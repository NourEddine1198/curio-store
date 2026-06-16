import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { fetchAllEcotrackOrders } from "@/lib/ecotrack";
import { matchOrderToParcel, type MatchInputOrder } from "@/lib/delivery-match";

// ─────────────────────────────────────────────────────────────
// DELIVERY SYNC — reads Curio's OWN Ecotrack account, matches each
// in-flight order to its parcel (Tier 1 exact-id → Tier 2 phone+time),
// and FREEZES the final DELIVERED/RETURNED outcome into Curio's DB so
// the dashboard reads permanent, vendor-independent truth.
//
// SAFETY:
//  - Dry-run is the DEFAULT. A real write requires ?apply=1.
//  - POST only. Requires the SYNC_SECRET header; missing secret = deny.
//  - Writes ONLY delivery-outcome fields, and only on EXACT/HIGH + a
//    STRICT terminal status. Never writes CANCELLED. Never touches stock.
//  - Guarded updateMany (status must still be in-flight) so it can't
//    clobber a concurrent confirmation; single-flight; per-run write cap.
//  - Every write is audit-stamped into `notes` (reversible).
// ─────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 60; // seconds (host may cap; page/write caps bound the work)

const SYNC_SECRET = process.env.SYNC_SECRET;
const WRITE_CAP = 100; // backlog drains over multiple runs
const IN_FLIGHT = ["CONFIRMED", "PROCESSING", "SHIPPED"] as const;

let _running = false;

export async function POST(request: NextRequest) {
  // ── Auth: secret MUST be set; missing = deny (no open default) ──
  if (!SYNC_SECRET) {
    return NextResponse.json({ error: "SYNC_SECRET not set — sync disabled" }, { status: 401 });
  }
  if (request.headers.get("x-sync-secret") !== SYNC_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const apply = url.searchParams.get("apply") === "1";
  const dryRun = !apply;
  const maxPages = Math.min(120, Math.max(1, parseInt(url.searchParams.get("pages") || "60", 10) || 60));

  if (_running) {
    return NextResponse.json({ error: "a sync run is already in progress" }, { status: 409 });
  }
  _running = true;
  const runId = new Date().toISOString();

  try {
    const since = new Date(Date.now() - 90 * 86400000);

    // ── In-flight orders only (terminal ones are already frozen) ──
    const orders = (await db.order.findMany({
      where: { status: { in: [...IN_FLIGHT] }, createdAt: { gte: since } },
      select: {
        orderNumber: true,
        status: true,
        externalId: true,
        trackingCode: true,
        customerPhone: true,
        customerPhone2: true,
        total: true,
        subtotal: true,
        deliveryPrice: true,
        createdAt: true,
        notes: true,
        items: { select: { product: { select: { name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 4000,
    })) as OrderRow[];

    // ── Read Curio's own Ecotrack account (read-only) ──
    const eco = await fetchAllEcotrackOrders(maxPages);

    const report: SyncReport = {
      runId,
      dryRun,
      scanned: orders.length,
      ecotrack: { ok: eco.ok, error: eco.error || null, parcels: eco.orders.length, pages: eco.pages, truncated: eco.pages >= maxPages },
      tier1: 0,
      tier2High: 0,
      ambiguous: [],
      unmatched: [],
      wouldFreeze: { delivered: 0, returned: 0 },
      froze: { delivered: 0, returned: 0 },
      writeCapHit: false,
      multipleRunsNeeded: false,
      samples: [],
    };

    if (!eco.ok) {
      // Can't match without the parcel list — report and stop (no writes).
      return NextResponse.json({ ...report, note: "Ecotrack list fetch failed — no matching attempted." }, { status: 200 });
    }

    // ── Plan writes ──
    const plans: WritePlan[] = [];
    for (const o of orders) {
      const input: MatchInputOrder = {
        orderNumber: o.orderNumber,
        externalId: o.externalId,
        customerPhone: o.customerPhone,
        customerPhone2: o.customerPhone2,
        total: o.total,
        subtotal: o.subtotal,
        deliveryPrice: o.deliveryPrice,
        createdAt: o.createdAt,
        productNames: o.items.map((it) => it.product?.name || "").filter(Boolean),
      };
      const m = matchOrderToParcel(input, eco.orders);

      if (m.confidence === "EXACT") report.tier1 += 1;
      else if (m.confidence === "HIGH") report.tier2High += 1;
      else if (m.confidence === "AMBIGUOUS") report.ambiguous.push(o.orderNumber);
      else report.unmatched.push(o.orderNumber);

      // Only EXACT or HIGH matches with a STRICT terminal status get written.
      if ((m.confidence === "EXACT" || m.confidence === "HIGH") && m.terminal && m.parcel) {
        const newStatus = m.terminal === "delivered" ? "DELIVERED" : "RETURNED";
        report.wouldFreeze[m.terminal] += 1;
        // Only persist a REAL tracking code (not the reference/order id) so we
        // never pollute trackingCode with a non-tracking value (would break the
        // future exact-lookup path). `ecoDisplay` is for audit/report only.
        const realTracking = (m.parcel.tracking || "").trim();
        const ecoRef = (m.parcel.reference || "").trim();
        const trackingForStore =
          realTracking && realTracking !== ecoRef && realTracking !== (o.externalId || "").trim()
            ? realTracking
            : "";
        const ecoDisplay = realTracking || ecoRef || "";
        plans.push({
          orderNumber: o.orderNumber,
          prevStatus: o.status,
          newStatus,
          terminal: m.terminal,
          tier: m.tier ?? -1,
          confidence: m.confidence,
          tracking: ecoDisplay,
          trackingForStore,
          hadTracking: !!o.trackingCode,
          prevNotes: o.notes || "",
        });
        if (report.samples.length < 25) {
          report.samples.push({
            orderNumber: o.orderNumber,
            decision: `${o.status} → ${newStatus}`,
            tier: m.tier,
            confidence: m.confidence,
            eco: ecoDisplay,
            reasons: m.reasons,
          });
        }
      }
    }

    // If more terminal matches than the per-run cap, the backlog drains over
    // multiple apply runs — surface this even in a dry-run.
    report.multipleRunsNeeded =
      report.wouldFreeze.delivered + report.wouldFreeze.returned > WRITE_CAP;

    // ── Apply (guarded, capped) — only when ?apply=1 ──
    if (!dryRun) {
      for (const p of plans) {
        if (report.froze.delivered + report.froze.returned >= WRITE_CAP) {
          report.writeCapHit = true;
          break;
        }
        const stamp = `[sync ${runId}] ${p.prevStatus}->${p.newStatus} via tier${p.tier}/${p.confidence} eco=${p.tracking}`;
        const data: Record<string, unknown> = {
          status: p.newStatus,
          notes: p.prevNotes ? `${p.prevNotes}\n${stamp}` : stamp,
        };
        if (p.newStatus === "DELIVERED") data.deliveredAt = new Date();
        else data.returnedAt = new Date();
        if (!p.hadTracking && p.trackingForStore) data.trackingCode = p.trackingForStore;

        // GUARDED: only write if the order is STILL in-flight (can't clobber a
        // concurrent confirmation that may have moved it to CANCELLED).
        const res = await db.order.updateMany({
          where: { orderNumber: p.orderNumber, status: { in: [...IN_FLIGHT] } },
          data,
        });
        if (res.count > 0) report.froze[p.terminal] += 1;
      }
    }

    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    console.error("POST /api/sync/delivery error:", error);
    return NextResponse.json({ error: "delivery sync failed", runId }, { status: 500 });
  } finally {
    _running = false;
  }
}

// ─── types ───
interface OrderRow {
  orderNumber: number;
  status: string;
  externalId: string | null;
  trackingCode: string | null;
  customerPhone: string;
  customerPhone2: string | null;
  total: number;
  subtotal: number;
  deliveryPrice: number;
  createdAt: Date;
  notes: string | null;
  items: { product: { name: string } | null }[];
}

interface WritePlan {
  orderNumber: number;
  prevStatus: string;
  newStatus: "DELIVERED" | "RETURNED";
  terminal: "delivered" | "returned";
  tier: number;
  confidence: string;
  tracking: string; // audit/display only
  trackingForStore: string; // real tracking code to persist (empty if none)
  hadTracking: boolean;
  prevNotes: string;
}

interface SyncReport {
  runId: string;
  dryRun: boolean;
  scanned: number;
  ecotrack: { ok: boolean; error: string | null; parcels: number; pages: number; truncated: boolean };
  tier1: number;
  tier2High: number;
  ambiguous: number[];
  unmatched: number[];
  wouldFreeze: { delivered: number; returned: number };
  froze: { delivered: number; returned: number };
  writeCapHit: boolean;
  multipleRunsNeeded: boolean;
  samples: { orderNumber: number; decision: string; tier: number | null; confidence: string; eco: string; reasons: string[] }[];
}
