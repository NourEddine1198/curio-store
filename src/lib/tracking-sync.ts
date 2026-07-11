import { db } from "@/lib/db";
import { fetchTrackingsInfo, type EcotrackTrackingInfo } from "@/lib/ecotrack";
import { POST_SHIP_ACTIVE, SHIP_RANK, type StatusKey } from "@/lib/order-status";

// ─────────────────────────────────────────────────────────────
// TRACKING SYNC — the rescue loop.
// For every shipped order (we created the parcel, so we KNOW its
// exact tracking code), read Ecotrack's detailed tracking info and
// move the order through the delivery journey:
//   SHIPPED → OUT_FOR_DELIVERY / AT_STOPDESK → DELIVERED
//                                 ↘ DELIVERY_FAILED (agent calls!)
//                                 ↘ IN_RETURN → RETURNED
// Rules copied from OrderDZ's auto-tracking cron:
//   • exact tracking codes only (no fuzzy matching)
//   • never move BACKWARDS (a failed delivery stays visible until
//     a terminal outcome — the courier retrying doesn't hide it)
//   • courier failed-attempt texts land in the order timeline
// ─────────────────────────────────────────────────────────────

const WRITE_CAP = 200;

// French status → our status. Normalized: lowercase, accents stripped,
// spaces → underscores. ("Livré non encaissé" → "livre_non_encaisse")
function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s-]+/g, "_")
    .trim();
}

export function mapEcotrackStatus(
  frStatus: string,
  lastActivity: string | null,
  deliveryType: "HOME" | "OFFICE"
): StatusKey | null {
  const s = normalize(frStatus);
  if (!s) return null;
  if (s.includes("annul")) return "CANCELLED";
  if (s.startsWith("livre") || s.startsWith("paiement") || s.startsWith("paye") || s.startsWith("encaisse")) return "DELIVERED";
  if (s.startsWith("retour")) {
    return s.includes("recu") || s.includes("archive") || s.includes("pret") ? "RETURNED" : "IN_RETURN";
  }
  if (s === "en_livraison") {
    if (lastActivity === "attempt_delivery") return "DELIVERY_FAILED";
    if (lastActivity === "livred") return "DELIVERED";
    return deliveryType === "OFFICE" ? "AT_STOPDESK" : "OUT_FOR_DELIVERY";
  }
  if (s.startsWith("suspend")) return "DELIVERY_FAILED";
  if (
    s.includes("preparation") || s.includes("preparer") ||
    s.includes("ramassage") || s.includes("expedier") ||
    s.startsWith("vers_") || s.includes("hub") || s.includes("stock")
  ) return "SHIPPED";
  return null; // unknown — leave the order alone, report it
}

export interface TrackingSyncReport {
  ok: boolean;
  error?: string;
  scanned: number;
  resolved: number;
  changed: number;
  courierNotes: number;
  byStatus: Record<string, number>;
  unknownStatuses: string[];
  ranAt: string;
}

export async function runTrackingSync(): Promise<TrackingSyncReport> {
  const ranAt = new Date().toISOString();
  const report: TrackingSyncReport = {
    ok: true, scanned: 0, resolved: 0, changed: 0, courierNotes: 0,
    byStatus: {}, unknownStatuses: [], ranAt,
  };

  // Parcels with a known tracking code from the last 180 days — wide on
  // purpose: Ecotrack still answers old codes, so this also heals the
  // pre-cutover backlog of orders stuck at SHIPPED (verified: it returned
  // a March parcel's true outcome). Terminal orders drop out of the scan
  // once frozen, so the window costs nothing after the first pass.
  const since = new Date(Date.now() - 180 * 86400000);
  const orders = await db.order.findMany({
    where: {
      status: { in: POST_SHIP_ACTIVE as never },
      trackingCode: { not: null },
      OR: [{ shippedAt: { gte: since } }, { shippedAt: null, createdAt: { gte: since } }],
    },
    select: {
      id: true, orderNumber: true, status: true, trackingCode: true,
      deliveryType: true, deliveredAt: true, returnedAt: true,
    },
    orderBy: { shippedAt: "desc" },
    take: 500,
  });
  report.scanned = orders.length;
  if (!orders.length) return report;

  const eco = await fetchTrackingsInfo(orders.map((o) => o.trackingCode!));
  if (!eco.ok) return { ...report, ok: false, error: eco.error };
  report.resolved = Object.keys(eco.info).length;

  let writes = 0;
  for (const o of orders) {
    if (writes >= WRITE_CAP) break;
    const info: EcotrackTrackingInfo | undefined = eco.info[o.trackingCode!];
    if (!info) continue;

    const mapped = mapEcotrackStatus(info.status, info.lastActivityStatus, o.deliveryType as "HOME" | "OFFICE");
    if (!mapped) {
      if (info.status && !report.unknownStatuses.includes(info.status)) report.unknownStatuses.push(info.status);
      continue;
    }

    // ── courier failed-attempt texts → timeline (deduped) ──
    if (info.attempts.length) {
      const existingNotes = new Set(
        (await db.orderEvent.findMany({
          where: { orderId: o.id, kind: "courier" },
          select: { note: true },
        })).map((e) => e.note || "")
      );
      for (const a of info.attempts) {
        const note = `${a.text}${a.station ? ` — ${a.station}` : ""}${a.at ? ` (${a.at})` : ""}`;
        if (existingNotes.has(note)) continue;
        await db.orderEvent.create({ data: { orderId: o.id, kind: "courier", note, actor: "ecotrack" } });
        existingNotes.add(note);
        report.courierNotes += 1;
      }
    }

    // ── status move (never backwards) ──
    if (mapped === o.status) continue;
    const oldRank = SHIP_RANK[o.status] ?? 0;
    const newRank = SHIP_RANK[mapped] ?? 0;
    if (newRank < oldRank) continue;
    if (newRank === oldRank && mapped !== o.status && oldRank >= 3) continue; // don't shuffle within failure/return

    const data: Record<string, unknown> = { status: mapped };
    if (mapped === "DELIVERED" && !o.deliveredAt) data.deliveredAt = new Date();
    if (mapped === "RETURNED" && !o.returnedAt) data.returnedAt = new Date();

    // guarded — only move if still in an active post-ship status
    const res = await db.order.updateMany({
      where: { id: o.id, status: { in: POST_SHIP_ACTIVE as never } },
      data,
    });
    if (res.count > 0) {
      await db.orderEvent.create({
        data: { orderId: o.id, kind: "status", status: mapped, actor: "ecotrack", note: info.status || undefined },
      });
      report.changed += 1;
      report.byStatus[mapped] = (report.byStatus[mapped] || 0) + 1;
      writes += 1;
    }
  }

  // remember when we last ran (rate-limits the agent's refresh button)
  await db.siteSetting.upsert({
    where: { key: "trackingSyncLastRunAt" },
    update: { value: ranAt },
    create: { key: "trackingSyncLastRunAt", value: ranAt },
  });

  return report;
}
