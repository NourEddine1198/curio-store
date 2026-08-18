import { db } from "@/lib/db";
import { fetchTrackingsInfo, fetchParcelDetails, type EcotrackTrackingInfo, type ParcelDetail } from "@/lib/ecotrack";
import { triageParcel } from "@/lib/suivi";
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
// Two separate caps, not one shared budget. A single slice over the
// concatenated list let the active parcels eat all of it, so once we pass
// ~250 in flight the delivered ones would never be cached — emptying the
// "they owe us money" bucket and freezing stale alerts on arrived boxes.
const ACTIVE_CACHE_CAP = 200;
const DELIVERED_CACHE_CAP = 80;

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
  /** parcels whose suivi cache was written (phase 2) */
  parcelsCached: number;
  /** parcels the board will flag red */
  needAction: number;
  byStatus: Record<string, number>;
  unknownStatuses: string[];
  ranAt: string;
}

// ─────────────────────────────────────────────────────────────
// SUIVI CACHE — mirror Ecotrack's side of each live parcel into
// ParcelTracking, so «فتح» opens instantly and the Suivi board can
// actually QUERY delivery trouble instead of asking Ecotrack per row.
//
// Runs after the status pass. NOTE: this is a SECOND pass over Ecotrack —
// it re-hits /get/trackings/info and additionally crawls the paginated list
// endpoint, so it roughly doubles the run's outbound calls. Kept separate
// because the status pass must commit even if this half is cut short.
// Best-effort by design: if this throws, the status sync above has already
// committed and must not be rolled back by a cache miss.
// ─────────────────────────────────────────────────────────────
async function cacheParcels(
  orders: { id: string; trackingCode: string | null; shippedAt?: Date | null }[],
  report: TrackingSyncReport
): Promise<void> {
  const trackings = orders.map((o) => o.trackingCode!).filter(Boolean);
  if (!trackings.length) return;

  const res = await fetchParcelDetails(trackings);
  if (!res.ok) return;

  const byTracking = new Map(orders.map((o) => [o.trackingCode!, o]));

  for (const [tracking, p] of Object.entries(res.parcels) as [string, ParcelDetail][]) {
    const src = byTracking.get(tracking);
    const t = triageParcel(p, new Date(), src?.shippedAt ?? null);
    const data = {
      orderId: src?.id ?? null,
      status: p.status,
      globalStatus: p.globalStatus,
      currentStation: p.currentStation,
      driverName: p.driverName,
      driverPhone: p.driverPhone,
      stopDesk: p.stopDesk,
      montant: p.montant,
      tarifLivraison: p.tarifLivraison,
      tarifRetour: p.tarifRetour,
      activity: p.activity as unknown as object,
      comments: p.comments as unknown as object,
      attemptCount: t.attemptCount,
      lastMoveAt: t.lastMoveAt,
      lastCommentAt: t.lastCommentAt,
      postponedTo: t.postponedTo,
      alertLevel: t.level,
      alertReason: t.reason || null,
      syncedAt: new Date(),
    };

    // Read-then-write, never upsert: upsert opens a transaction and the
    // Neon HTTP driver has none ("Transactions are not supported").
    // One bad parcel must not abort the batch. `orderId` is @unique, so a
    // re-shipped order (a second tracking code) makes create throw P2002 —
    // and an uncaught throw here would stop the cache at the same row on
    // every future run, silently and forever.
    try {
      const existing = await db.parcelTracking.findUnique({ where: { trackingCode: tracking }, select: { id: true } });
      if (existing) {
        await db.parcelTracking.update({ where: { id: existing.id }, data });
      } else {
        if (data.orderId) {
          // Release the claim from any older parcel for this order.
          const stale = await db.parcelTracking.findUnique({ where: { orderId: data.orderId }, select: { id: true } });
          if (stale) await db.parcelTracking.update({ where: { id: stale.id }, data: { orderId: null } });
        }
        await db.parcelTracking.create({ data: { trackingCode: tracking, ...data } });
      }
      report.parcelsCached += 1;
      if (t.level === "act") report.needAction += 1;
    } catch (err) {
      console.error(`suivi cache: parcel ${tracking} failed`, err);
    }
  }
}

export async function runTrackingSync(): Promise<TrackingSyncReport> {
  const ranAt = new Date().toISOString();
  const report: TrackingSyncReport = {
    ok: true, scanned: 0, resolved: 0, changed: 0, courierNotes: 0,
    parcelsCached: 0, needAction: 0,
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
      deliveryType: true, deliveredAt: true, returnedAt: true, shippedAt: true,
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

    // Guard: only move if STILL in an active post-ship status. Read-then-
    // update (not updateMany — updateMany opens a transaction under the
    // Neon HTTP driver and dies with "Transactions are not supported").
    const fresh = await db.order.findUnique({ where: { id: o.id }, select: { status: true } });
    if (!fresh || !POST_SHIP_ACTIVE.includes(fresh.status as StatusKey)) continue;
    await db.order.update({ where: { id: o.id }, data });
    await db.orderEvent.create({
      data: { orderId: o.id, kind: "status", status: mapped, actor: "ecotrack", note: info.status || undefined },
    });
    report.changed += 1;
    report.byStatus[mapped] = (report.byStatus[mapped] || 0) + 1;
    writes += 1;
  }

  // Remember when we last ran (rate-limits the agent's refresh button).
  // Stamped BEFORE the cache pass on purpose: the cache is the slow half, and
  // if the function is killed at its 60s ceiling an unwritten stamp would
  // leave the rate limit permanently disengaged, so every agent click would
  // relaunch the whole job.
  // NOT an upsert — upsert opens a transaction and the Neon HTTP driver
  // has none ("Transactions are not supported in HTTP mode").
  const stamp = await db.siteSetting.findUnique({ where: { key: "trackingSyncLastRunAt" } });
  if (stamp) await db.siteSetting.update({ where: { key: "trackingSyncLastRunAt" }, data: { value: ranAt } });
  else await db.siteSetting.create({ data: { key: "trackingSyncLastRunAt", value: ranAt } });

  // ── suivi cache (phase 2) ──
  // Live parcels PLUS recently delivered ones: a delivered parcel still
  // matters while Ecotrack is holding our cash ("Livre encaissé non payé"),
  // and it is also the only chance to re-triage a row whose alert would
  // otherwise stay red forever after the box arrived.
  // Each group gets its OWN cap — a single shared slice let the active list
  // eat the whole budget, starving the delivered ones completely.
  // Best-effort: a failure here must not undo the status work above.
  try {
    const recentlyDelivered = await db.order.findMany({
      where: {
        status: { in: ["DELIVERED", "RETURNED"] as never },
        trackingCode: { not: null },
        shippedAt: { gte: new Date(Date.now() - 45 * 86400000) },
      },
      select: { id: true, trackingCode: true, shippedAt: true },
      orderBy: { shippedAt: "desc" },
      take: DELIVERED_CACHE_CAP,
    });
    await cacheParcels(
      [...orders.slice(0, ACTIVE_CACHE_CAP), ...recentlyDelivered],
      report
    );
  } catch (err) {
    console.error("suivi cache failed (status sync unaffected):", err);
  }

  return report;
}
