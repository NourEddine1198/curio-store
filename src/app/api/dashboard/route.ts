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
export const fetchCache = "force-no-store";
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

interface FailureRow {
  reason: string;
  message: string;
  status: number;
  silent: boolean;
  page: string | null;
  wilayaCode: string | null;
  phone: string | null;
  name: string | null;
  createdAt: Date;
}

interface OrderRow {
  orderNumber: number;
  status: string;
  preHandledStatus: string | null;
  subtotal: number;
  createdAt: Date;
  customerPhone: string;
  items: { quantity: number; unitPrice: number; product: { slug: string } | null }[];
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

    // ── All orders (capped) + active products + the lost-order log ──
    const [orders, products, failures] = (await Promise.all([
      db.order.findMany({
        select: {
          orderNumber: true,
          status: true,
          preHandledStatus: true,
          subtotal: true,
          createdAt: true,
          customerPhone: true,
          items: { select: { quantity: true, unitPrice: true, product: { select: { slug: true } } } },
        },
        orderBy: { createdAt: "desc" },
        take: 8000,
      }),
      db.product.findMany({
        where: { active: true },
        select: { slug: true, name: true, nameEn: true, stock: true, price: true },
        orderBy: { createdAt: "asc" },
      }),
      // Checkout failures — 30 days is enough to spot an outage and still
      // have a call-back list. Older rows stay in the table, just unread.
      db.checkoutFailure.findMany({
        where: { createdAt: { gte: d30 } },
        orderBy: { createdAt: "desc" },
        take: 3000,
      }),
    ])) as [
      OrderRow[],
      { slug: string; name: string; nameEn: string | null; stock: number; price: number }[],
      FailureRow[]
    ];

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

    // Stage resolution (v3 — the DB is the source of truth):
    //  1) If the DB status is already TERMINAL (delivered/returned/cancelled),
    //     trust it — the delivery sync freezes the real outcome there, and it
    //     never "ages off" the way a live Ecotrack lookup does.
    //  2) Otherwise the order is still in-flight → enrich from a live Ecotrack
    //     phone-match (best-effort, until the sync freezes it).
    //  3) Otherwise fall back to the in-flight DB status.
    let matchedCount = 0;
    const stageByOrder = new Map<number, Stage>();
    for (const o of orders) {
      let stage: Stage | null = null;

      // 1) DB-primary for terminal states (+ the v2 junk family).
      // HANDLED is an archive label put on the whole pre-waitlist era, so it
      // says nothing about the outcome — read through it to the status the
      // order actually held, or the delivered/returned revenue would vanish
      // from this dashboard the moment we archived it.
      const trueStatus = o.status === "HANDLED" ? (o.preHandledStatus ?? "PENDING") : o.status;
      switch (trueStatus) {
        case "DELIVERED": stage = "delivered"; break;
        case "RETURNED": stage = "returned"; break;
        case "CANCELLED":
        case "EXPIRED":
        case "WRONG":
        case "DUPLICATE": stage = "cancelled"; break;
        // A waitlisted order has no parcel and never will until someone calls
        // it. Resolve it here rather than letting step 2 phone-match it: these
        // are months old, so a customer's earlier delivered parcel can fall
        // inside the 60-day window and mislabel them as "delivered".
        case "WAITLIST": stage = "pending"; break;
      }

      // 2) Live Ecotrack enrichment — only for orders still in flight.
      if (!stage) {
        const phone = normalizePhone(o.customerPhone);
        const candidates = phone ? ecoByPhone.get(phone) : undefined;
        if (candidates && candidates.length) {
          // Closest in time within a 60-day window so a repeat customer's NEW
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
      }

      // 3) Fall back to the in-flight DB status.
      if (!stage) {
        switch (trueStatus) {
          case "PENDING":
          case "NO_ANSWER":
          case "CALLBACK": stage = "pending"; break;
          case "CONFIRMED":
          case "PROCESSING": stage = "confirmed"; break;
          case "SHIPPED":
          case "OUT_FOR_DELIVERY":
          case "AT_STOPDESK":
          case "DELIVERY_FAILED":
          case "IN_RETURN": stage = "in_transit"; break;
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

      // Per-product breakdown for the new "Daily" cards.
      const perProduct: Record<string, { orders: number; deliveredUnits: number; deliveredRevenue: number; returned: number; attempts: number }> = {};
      const pp = (slug: string) =>
        perProduct[slug] || (perProduct[slug] = { orders: 0, deliveredUnits: 0, deliveredRevenue: 0, returned: 0, attempts: 0 });

      for (const o of subset) {
        const stage = stageByOrder.get(o.orderNumber) || "pending";
        funnel[stage] += 1;
        const slugSet = new Set<string>();
        for (const it of o.items) slugSet.add(it.product?.slug || "unknown");
        const slugs = Array.from(slugSet);

        if (stage === "confirmed" || stage === "in_transit" || stage === "delivered") {
          confirmedRevenue += o.subtotal;
        }
        if (stage === "delivered" || stage === "returned" || stage === "in_transit") {
          for (const s of slugs) pp(s).attempts += 1;
        }
        if (stage === "returned") {
          for (const s of slugs) pp(s).returned += 1;
        }
        if (stage === "delivered") {
          deliveredRevenue += o.subtotal;
          for (const s of slugs) pp(s).orders += 1;
          for (const it of o.items) {
            const slug = it.product?.slug || "unknown";
            perProductDeliveredUnits[slug] = (perProductDeliveredUnits[slug] || 0) + it.quantity;
            pp(slug).deliveredUnits += it.quantity;
            pp(slug).deliveredRevenue += (it.unitPrice || 0) * it.quantity;
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
        perProduct,
      };
    };

    // ── Weekly trend (last 8 rolling 7-day buckets) for the War Room chart ──
    const WEEKS = 8;
    const weekly: { weekStart: string; orders: number; deliveredRevenue: number }[] = [];
    for (let w = WEEKS - 1; w >= 0; w--) {
      const start = new Date(now.getTime() - (w + 1) * 7 * 86400000);
      const end = new Date(now.getTime() - w * 7 * 86400000);
      let ord = 0;
      let drev = 0;
      for (const o of orders) {
        if (o.createdAt >= start && o.createdAt < end) {
          ord += 1;
          if ((stageByOrder.get(o.orderNumber) || "pending") === "delivered") drev += o.subtotal;
        }
      }
      weekly.push({ weekStart: start.toISOString(), orders: ord, deliveredRevenue: drev });
    }

    // Trend = orders count current vs previous equal window.
    const countIn = (from: Date, to?: Date) =>
      orders.filter((o) => o.createdAt >= from && (!to || o.createdAt < to)).length;
    const yesterdayStart = algiersDayStart(now, -1);
    const d14 = new Date(now.getTime() - 14 * 86400000);
    const d60 = new Date(now.getTime() - 60 * 86400000);

    const allDays = Math.max(1, Math.round((now.getTime() - earliest) / 86400000));

    // ── Checkout failures — the lost-order log ──
    // Bot traps are counted apart: they're mostly real bots, and mixing them
    // in would bury a genuine outage under noise. Everything else is a human
    // who wanted to buy and was turned away.
    const realFails = failures.filter((f) => !f.silent);
    const botFails = failures.filter((f) => f.silent);

    const failWindow = (from: Date) => {
      const subset = realFails.filter((f) => f.createdAt >= from);
      const byReason: Record<string, number> = {};
      for (const f of subset) byReason[f.reason] = (byReason[f.reason] || 0) + 1;
      const placed = orders.filter((o) => o.createdAt >= from).length;
      const attempts = placed + subset.length;
      return {
        count: subset.length,
        // Share of everyone who pressed the button and did NOT get an order.
        lostPct: attempts > 0 ? (subset.length / attempts) * 100 : 0,
        byReason: Object.entries(byReason)
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count),
      };
    };

    // The call-back list: one row per person (most recent attempt wins), only
    // those who got far enough to leave a phone number. This is the thing the
    // old blind spot destroyed — proof of who we lost.
    const seenPhones = new Set<string>();
    const callback: {
      phone: string; name: string | null; reason: string; message: string;
      wilayaCode: string | null; page: string | null; at: string; tries: number;
    }[] = [];
    const triesByPhone: Record<string, number> = {};
    for (const f of realFails) if (f.phone) triesByPhone[f.phone] = (triesByPhone[f.phone] || 0) + 1;
    // Anyone who later succeeded doesn't belong on a call-back list.
    const succeededPhones = new Set(orders.filter((o) => o.createdAt >= d30).map((o) => o.customerPhone));
    for (const f of realFails) {
      if (!f.phone || seenPhones.has(f.phone) || succeededPhones.has(f.phone)) continue;
      seenPhones.add(f.phone);
      callback.push({
        phone: f.phone, name: f.name, reason: f.reason, message: f.message,
        wilayaCode: f.wilayaCode, page: f.page,
        at: f.createdAt.toISOString(), tries: triesByPhone[f.phone] || 1,
      });
      if (callback.length >= 40) break;
    }

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
      weekly,
      inventory: products.map((p) => ({
        slug: p.slug, name: p.name, nameEn: p.nameEn, stock: p.stock, price: p.price,
      })),
      checkoutFailures: {
        today: failWindow(todayStart),
        week: failWindow(d7),
        month: failWindow(d30),
        botsToday: botFails.filter((f) => f.createdAt >= todayStart).length,
        botsMonth: botFails.length,
        callback,
        // Null until the first failure is ever recorded — lets the dashboard
        // say "watching since X" instead of implying 30 clean days we can't
        // actually vouch for (the log only started when it was deployed).
        oldest: failures.length ? failures[failures.length - 1].createdAt.toISOString() : null,
      },
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
