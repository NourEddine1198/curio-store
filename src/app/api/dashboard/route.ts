import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  fetchAllEcotrackOrders,
  normalizePhone,
  type EcotrackListResult,
  type EcotrackOrder,
} from "@/lib/ecotrack";

// This endpoint is READ-ONLY. It only runs read queries against the
// database and read-only GETs against Ecotrack. It never creates,
// updates, ships, confirms, cancels, or deletes anything.

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;

// Algiers is UTC+1 all year (no daylight saving).
const TZ_OFFSET_MIN = 60;

function algiersDayStart(base: Date, dayOffset = 0): Date {
  const shifted = new Date(base.getTime() + TZ_OFFSET_MIN * 60000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  return new Date(shifted.getTime() - TZ_OFFSET_MIN * 60000);
}

// ─── Cache the Ecotrack order list (best-effort, cleared on cold start) ──
let _ecoListCache: { at: number; result: EcotrackListResult } | null = null;
const ECO_TTL_MS = 3 * 60 * 1000;

async function getEcotrackListCached(): Promise<EcotrackListResult> {
  if (_ecoListCache && Date.now() - _ecoListCache.at < ECO_TTL_MS) {
    return _ecoListCache.result;
  }
  const result = await fetchAllEcotrackOrders();
  if (result.ok) _ecoListCache = { at: Date.now(), result };
  return result;
}

type Stage =
  | "pending"
  | "confirmed"
  | "in_transit"
  | "delivered"
  | "returned"
  | "cancelled";

interface OrderRow {
  orderNumber: number;
  status: string;
  subtotal: number;
  createdAt: Date;
  customerPhone: string;
  items: { quantity: number; product: { slug: string } | null }[];
}

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const todayStart = algiersDayStart(now, 0);
    const d7 = new Date(now.getTime() - 7 * 86400000);
    const d30 = new Date(now.getTime() - 30 * 86400000);

    // ── All orders (capped) + active products, in parallel ──
    const [orders, products] = (await Promise.all([
      db.order.findMany({
        select: {
          orderNumber: true,
          status: true,
          subtotal: true,
          createdAt: true,
          customerPhone: true,
          items: { select: { quantity: true, product: { select: { slug: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: 8000,
      }),
      db.product.findMany({
        where: { active: true },
        select: { slug: true, name: true, nameEn: true, stock: true, price: true },
        orderBy: { createdAt: "asc" },
      }),
    ])) as [OrderRow[], { slug: string; name: string; nameEn: string | null; stock: number; price: number }[]];

    // ── Ecotrack list (read-only) → phone → orders map ──
    const eco = await getEcotrackListCached();
    const ecoByPhone = new Map<string, EcotrackOrder[]>();
    for (const eo of eco.orders) {
      if (!eo.phone) continue;
      const arr = ecoByPhone.get(eo.phone);
      if (arr) arr.push(eo);
      else ecoByPhone.set(eo.phone, [eo]);
    }

    // Count Ecotrack global statuses (for transparency / refinement).
    const globalStatusCounts: Record<string, number> = {};
    for (const eo of eco.orders) {
      const key = eo.globalStatus || "(none)";
      globalStatusCounts[key] = (globalStatusCounts[key] || 0) + 1;
    }

    // Match a store order to its best Ecotrack record by phone + closest date.
    let matchedCount = 0;
    const stageByOrder = new Map<number, Stage>();
    for (const o of orders) {
      const phone = normalizePhone(o.customerPhone);
      const candidates = phone ? ecoByPhone.get(phone) : undefined;
      let stage: Stage | null = null;

      if (candidates && candidates.length) {
        // Pick the Ecotrack order closest in time to this store order.
        // Guard with a 60-day window so a repeat customer's NEW Ecotrack
        // parcel can't mislabel an OLD store order with the same phone.
        const MATCH_WINDOW_MS = 60 * 86400000;
        const oTime = o.createdAt.getTime();
        let best = candidates[0];
        let bestDiff = Infinity;
        for (const c of candidates) {
          const ct = c.createdAt ? new Date(c.createdAt).getTime() : oTime;
          const diff = Math.abs(ct - oTime);
          if (diff < bestDiff) { bestDiff = diff; best = c; }
        }
        if (bestDiff <= MATCH_WINDOW_MS) {
          matchedCount += 1;
          stage =
            best.bucket === "delivered" ? "delivered"
            : best.bucket === "returned" ? "returned"
            : best.bucket === "cancelled" ? "cancelled"
            : "in_transit";
        }
      }

      if (!stage) {
        switch (o.status) {
          case "PENDING": stage = "pending"; break;
          case "CONFIRMED":
          case "PROCESSING": stage = "confirmed"; break;
          case "SHIPPED": stage = "in_transit"; break;
          case "DELIVERED": stage = "delivered"; break;
          case "RETURNED": stage = "returned"; break;
          case "CANCELLED": stage = "cancelled"; break;
          default: stage = "pending";
        }
      }
      stageByOrder.set(o.orderNumber, stage);
    }

    // Earliest order date (for all-time rent proration).
    let earliest = now.getTime();
    for (const o of orders) earliest = Math.min(earliest, o.createdAt.getTime());

    const metricsFor = (fromDate: Date | null, label: string, days: number) => {
      const subset = fromDate ? orders.filter((o) => o.createdAt >= fromDate) : orders;
      const funnel = { pending: 0, confirmed: 0, in_transit: 0, delivered: 0, returned: 0, cancelled: 0 };
      let confirmedRevenue = 0;
      let deliveredRevenue = 0;
      const perProductDeliveredUnits: Record<string, number> = {};

      for (const o of subset) {
        const stage = stageByOrder.get(o.orderNumber) || "pending";
        funnel[stage] += 1;
        if (stage === "confirmed" || stage === "in_transit" || stage === "delivered") {
          confirmedRevenue += o.subtotal;
        }
        if (stage === "delivered") {
          deliveredRevenue += o.subtotal;
          for (const it of o.items) {
            const slug = it.product?.slug || "unknown";
            perProductDeliveredUnits[slug] = (perProductDeliveredUnits[slug] || 0) + it.quantity;
          }
        }
      }

      const deliveredCount = funnel.delivered;
      const returnedCount = funnel.returned;
      const inTransitCount = funnel.in_transit;
      const attempts = deliveredCount + returnedCount + inTransitCount;
      const terminalShipped = deliveredCount + returnedCount;
      const returnRatePct = terminalShipped > 0 ? (returnedCount / terminalShipped) * 100 : 0;

      return {
        label, days,
        orders: subset.length,
        funnel,
        confirmedRevenue,
        deliveredRevenue,
        confirmedCount: funnel.confirmed,
        deliveredCount, returnedCount, inTransitCount, attempts,
        returns: { count: returnedCount, ratePct: returnRatePct },
        perProductDeliveredUnits,
      };
    };

    // Trend = orders count current vs previous equal window.
    const countIn = (from: Date, to?: Date) =>
      orders.filter((o) => o.createdAt >= from && (!to || o.createdAt < to)).length;
    const yesterdayStart = algiersDayStart(now, -1);
    const d14 = new Date(now.getTime() - 14 * 86400000);
    const d60 = new Date(now.getTime() - 60 * 86400000);

    const allDays = Math.max(1, Math.round((now.getTime() - earliest) / 86400000));

    return NextResponse.json({
      generatedAt: now.toISOString(),
      totalOrdersAllTime: orders.length,
      trend: {
        today: { current: countIn(todayStart), previous: countIn(yesterdayStart, todayStart) },
        week: { current: countIn(d7), previous: countIn(d14, d7) },
        month: { current: countIn(d30), previous: countIn(d60, d30) },
      },
      periods: {
        today: metricsFor(todayStart, "Today", 1),
        week: metricsFor(d7, "Last 7 days", 7),
        month: metricsFor(d30, "Last 30 days", 30),
        all: metricsFor(null, "All time", allDays),
      },
      inventory: products.map((p) => ({
        slug: p.slug, name: p.name, nameEn: p.nameEn, stock: p.stock, price: p.price,
      })),
      ecotrack: {
        ok: eco.ok,
        error: eco.error || null,
        ordersInEcotrack: eco.orders.length,
        matchedToStore: matchedCount,
        globalStatusCounts,
      },
    });
  } catch (error) {
    console.error("GET /api/dashboard error:", error);
    return NextResponse.json({ error: "Failed to build dashboard data" }, { status: 500 });
  }
}
