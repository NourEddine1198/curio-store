// ─────────────────────────────────────────────────────────────
// Curio — the scoreboard engine.
//
// READ-ONLY. Feeds both the /analytics page and the machine brief a
// fresh Claude session reads.
//
// It deliberately does NOT re-implement the money model. Profit, costs
// and the receivable all come from lib/finance.ts, so the scoreboard and
// the finance page can never quietly disagree about what a sale is worth.
// This file adds only what finance does not answer: conversion, basket,
// geography, repeat buying, and how any of it is moving.
//
// Nothing here is stored. Correct a cost rule and every past week
// re-reads correctly.
// ─────────────────────────────────────────────────────────────
import { db } from "@/lib/db";
import { buildFinanceReport, loadCostRules, type PeriodKey } from "@/lib/finance";
import { compositionOf, isComposite } from "@/lib/product-composition";
import { availableUnits } from "@/lib/stock";

// ─── Helpers ────────────────────────────────────────────────
const TZ_OFFSET_MIN = 60;                     // Algiers, UTC+1 year round
const day = (d: Date) => new Date(d.getTime() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const div = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) / 100 : 0);

/** The status an order really holds — HANDLED is an archive label. */
function realStatus(o: { status: string; preHandledStatus: string | null }): string {
  return o.status === "HANDLED" ? (o.preHandledStatus ?? "PENDING") : o.status;
}

const DELIVERED = ["DELIVERED"];
const RETURNED = ["RETURNED", "IN_RETURN"];
const JUNK = ["WRONG", "DUPLICATE"];
const LOST = ["CANCELLED", "EXPIRED"];

// ─── Shapes ─────────────────────────────────────────────────
export interface Metric {
  value: number;
  unit: string;
  formula: string;
  caveat?: string;
}
export interface TargetCheck {
  key: string;
  label: string;
  target: number | null;
  actual: number;
  unit: string;
  met: boolean | null;      // null = no target set
  direction: "below" | "above";  // which side of the target is good
}

export interface Scoreboard {
  generatedAt: string;
  window: { key: PeriodKey; label: string; from: string; to: string; days: number };
  northStars: { profitPerDeliveredOrder: Metric; returnOnAdSpend: Metric };
  funnel: {
    placed: number; confirmed: number; shipped: number; delivered: number;
    returned: number; lost: number; junk: number; stillOpen: number;
    confirmRate: number; deliveryRate: number; returnRate: number;
  };
  money: {
    collected: number; courierFees: number; netRevenue: number;
    costs: Record<string, number>; profit: number;
    receivable: number; inTransit: number;
  };
  products: {
    slug: string; name: string; unitsDelivered: number; revenue: number;
    contribution: number; grossMarginPerUnit: number;
    stock: number; unitsPerWeek: number; weeksOfStock: number | null; reorderBy: string | null;
    composite: boolean;
  }[];
  basket: {
    aov: number; multiItemShare: number; gamesPerOrder: number;
    bundleShare: number; phase1BundleShare: number | null;
    websiteUpsells: number; phoneUpsells: number;
  };
  tiers: {
    tier: string; wilayas: number; placed: number; delivered: number; returned: number;
    deliveryRate: number; returnRate: number; revenue: number;
  }[];
  channel: { home: { placed: number; delivered: number; rate: number }; stopdesk: { placed: number; delivered: number; rate: number } };
  ads: {
    spend: number; costPerDeliveredOrder: number; blendedReturn: number;
    tracedOrders: number; tracedShare: number;
    perCampaign: { campaign: string; orders: number; delivered: number; revenue: number }[];
  };
  repeat: { customers: number; repeatBuyers: number; repeatShare: number; ordersFromReturning: number };
  weekly: { weekStart: string; placed: number; delivered: number; revenue: number; adSpend: number }[];
  targets: TargetCheck[];
  changes: { label: string; now: number; before: number; changePct: number; unit: string; good: boolean | null }[];
  caveats: string[];
  definitions: Record<string, string>;

  /** The daily glance. Counts and links only — never a second copy of a
   *  list that another screen already owns. */
  attention: { key: string; label: string; count: number; value: number; href: string; severity: "act" | "watch" }[];
  yesterday: {
    date: string;
    orders: number; delivered: number; revenue: number; adSpend: number;
    avgOrders: number; avgDelivered: number; avgRevenue: number;
  };
}

// ─── Delivery tiers, derived from what you charge ───────────
// Grouping by the wilaya's own home price rather than a hand-kept list:
// the tiers then stay correct when a price changes, and 43 wilayas across
// 258 orders is far too thin to judge one at a time.
function tierOf(homePrice: number): string {
  if (homePrice <= 500) return "Algiers";
  if (homePrice <= 700) return "Near Algiers";
  if (homePrice <= 900) return "Standard";
  return "Far south";
}
const TIER_ORDER = ["Algiers", "Near Algiers", "Standard", "Far south"];

export async function buildScoreboard(periodKey: PeriodKey = "month"): Promise<Scoreboard> {
  const [fin, rules, settings, wilayas, products] = await Promise.all([
    buildFinanceReport(periodKey),
    loadCostRules(),
    db.financeSetting.findMany({ where: { key: { startsWith: "target." } } }),
    db.wilaya.findMany({ select: { code: true, name: true, homePrice: true } }),
    db.product.findMany({ select: { slug: true, name: true, nameEn: true, stock: true } }),
  ]);

  const from = new Date(fin.period.from);
  const to = new Date(fin.period.to);
  const openFrom = new Date(`${rules.openFrom}T00:00:00.000Z`);

  const orders = await db.order.findMany({
    where: { createdAt: { gte: from } },
    select: {
      orderNumber: true, status: true, preHandledStatus: true, customerPhone: true,
      total: true, subtotal: true, wilayaCode: true, wilayaName: true, deliveryType: true,
      createdAt: true, confirmedAt: true, deliveredAt: true, shippedAt: true,
      utmSource: true, utmCampaign: true,
      items: { select: { quantity: true, unitPrice: true, product: { select: { slug: true } } } },
    },
  });

  // ── Funnel ──
  const st = (o: (typeof orders)[number]) => realStatus(o);
  const placed = orders.length;
  const confirmed = orders.filter((o) => o.confirmedAt).length;
  const shipped = orders.filter((o) => o.shippedAt).length;
  // Dated by WHEN THEY RESOLVED, not when they were placed — the same basis
  // the profit engine uses. Filtering placed-in-window would, at a month
  // rollover, divide the month's ad spend by the handful of orders both
  // placed AND delivered since the 1st, and report a cost per sale ten times
  // the truth right beside a profit figure computed on the real number.
  const inWin = (d: Date | null | undefined) => !!d && d >= from && d <= to;
  const delivered = orders.filter((o) => DELIVERED.includes(st(o)) && inWin(o.deliveredAt));
  const returned = orders.filter((o) => RETURNED.includes(st(o)));
  const junk = orders.filter((o) => JUNK.includes(st(o))).length;
  const lost = orders.filter((o) => LOST.includes(st(o))).length;
  const resolved = delivered.length + returned.length;
  // Junk is excluded from the confirm rate: a wrong number was never a
  // customer, and counting it as a miss makes the agent look worse than
  // she is.
  const realLeads = placed - junk;

  // ── North stars ──
  const profitPerOrder = fin.perDeliveredOrder;
  const adSpend = fin.costs.typed.find((t) => t.categoryKey === "ads_meta")?.amountDzd ?? 0;
  const contribution = fin.profit + adSpend;   // profit before advertising
  const blendedReturn = div(contribution, adSpend);

  // ── Products ──
  const weeks = Math.max(1, fin.period.days / 7);
  const unitsBySlug: Record<string, number> = {};
  const revenueBySlug: Record<string, number> = {};
  for (const o of delivered) {
    for (const it of o.items) {
      const s = it.product?.slug || "unknown";
      unitsBySlug[s] = (unitsBySlug[s] || 0) + it.quantity;
      // Allocate by what the line is actually worth, not evenly across lines.
      // Splitting a Roubla + 3 Dlala order 50/50 understated Dlala by two
      // thirds. Delivery is excluded — the customer pays it and the courier
      // takes it, so it is not product revenue.
      revenueBySlug[s] = (revenueBySlug[s] || 0) + it.unitPrice * it.quantity;
    }
  }
  const leadRow = settings.find((s) => s.key === "target.printLeadWeeks");
  const leadWeeks = Number(leadRow?.value) || null;

  // A bundle has no shelf of its own — what it can sell is whichever
  // component runs out first. Reading its stored counter here is what made
  // "121 weeks of pack" look like a fact.
  const sellable: Record<string, number> = {};
  for (const p of products) sellable[p.slug] = await availableUnits(p.slug);

  const productRows = products.map((p) => {
    const units = unitsBySlug[p.slug] || 0;
    const perWeek = units / weeks;
    const stock = sellable[p.slug] ?? p.stock;
    const weeksLeft = perWeek > 0 ? Math.round((stock / perWeek) * 10) / 10 : null;
    // A reorder date only means something once you tell us how long the
    // printer takes. Until then this stays null rather than inventing one.
    let reorderBy: string | null = null;
    if (weeksLeft != null && leadWeeks != null) {
      const daysUntil = (weeksLeft - leadWeeks) * 7;
      reorderBy = day(new Date(Date.now() + daysUntil * 86400000));
    }
    const games = compositionOf(p.slug).length;
    const printCost = compositionOf(p.slug).reduce(
      (s, k) => s + (k === "roubla" ? rules.printRoubla : k === "dlala" ? rules.printDlala : rules.printDefault), 0);
    const wrapCost = compositionOf(p.slug).reduce(
      (s, k) => s + (k === "roubla" ? rules.wrapRoubla : k === "dlala" ? rules.wrapDlala : rules.wrapDefault), 0);
    const revenue = Math.round(revenueBySlug[p.slug] || 0);
    // Gross margin, NOT profit: product revenue less printing and wrapping.
    // It excludes the courier fee, the agent's fee, ads and returns, so it is
    // always higher than the real profit per order shown at the top of the
    // page. Naming it "profit" put two numbers 2.5x apart on one screen.
    const grossMarginPerUnit = units > 0 ? Math.round(revenue / units) - printCost - wrapCost : 0;
    return {
      slug: p.slug, name: p.nameEn || p.name,
      unitsDelivered: units, revenue,
      contribution: grossMarginPerUnit * units,
      grossMarginPerUnit, stock,
      unitsPerWeek: Math.round(perWeek * 10) / 10,
      weeksOfStock: weeksLeft, reorderBy,
      composite: isComposite(p.slug),
      games,
    };
  }).filter((p) => p.unitsDelivered > 0 || p.stock > 0)
    .sort((a, b) => b.unitsDelivered - a.unitsDelivered)
    .map(({ games, ...r }) => { void games; return r; });

  // ── Basket ──
  const gamesIn = (o: (typeof orders)[number]) =>
    o.items.reduce((s, i) => s + compositionOf(i.product?.slug).length * i.quantity, 0);
  const multiItem = delivered.filter((o) => gamesIn(o) > 1).length;
  const totalGames = delivered.reduce((s, o) => s + gamesIn(o), 0);
  const aov = delivered.length ? Math.round(delivered.reduce((s, o) => s + o.total, 0) / delivered.length) : 0;

  // Phase 1 is used for ONE thing only: what people bought. Its delivery
  // outcomes are unrecorded and must never be used for profit or returns.
  const phase1 = await db.order.findMany({
    where: { createdAt: { lt: openFrom } },
    select: { items: { select: { quantity: true, product: { select: { slug: true } } } } },
  });
  const p1Multi = phase1.filter(
    (o) => o.items.reduce((s, i) => s + compositionOf(i.product?.slug).length * i.quantity, 0) > 1).length;
  const phase1BundleShare = phase1.length ? pct(p1Multi, phase1.length) : null;

  const [websiteUpsells, phoneUpsells] = await Promise.all([
    db.orderEvent.count({ where: { createdAt: { gte: from }, note: { contains: "العرض المزدوج" } } }),
    db.orderEvent.count({ where: { createdAt: { gte: from }, kind: "upsell" } }),
  ]);

  // ── Geography, by tier ──
  const priceOf: Record<string, number> = {};
  const nameOf: Record<string, string> = {};
  for (const w of wilayas) { priceOf[w.code] = w.homePrice; nameOf[w.code] = w.name; }
  const tierAgg: Record<string, { wilayas: Set<string>; placed: number; delivered: number; returned: number; revenue: number }> = {};
  for (const o of orders) {
    const t = tierOf(priceOf[o.wilayaCode] ?? 850);
    tierAgg[t] ||= { wilayas: new Set(), placed: 0, delivered: 0, returned: 0, revenue: 0 };
    tierAgg[t].wilayas.add(o.wilayaCode);
    tierAgg[t].placed += 1;
    if (DELIVERED.includes(st(o))) { tierAgg[t].delivered += 1; tierAgg[t].revenue += o.total; }
    if (RETURNED.includes(st(o))) tierAgg[t].returned += 1;
  }
  // Delivery rate is measured against RESOLVED orders (delivered + returned),
  // never against everything placed. Using `placed` mixes in parcels still in
  // flight and cancelled leads, which drags every tier down to a number that
  // looks alarming and means nothing — and it would not match the funnel.
  const tiers = TIER_ORDER.filter((t) => tierAgg[t]).map((t) => {
    const a = tierAgg[t];
    const res = a.delivered + a.returned;
    return {
      tier: t, wilayas: a.wilayas.size, placed: a.placed, delivered: a.delivered, returned: a.returned,
      deliveryRate: pct(a.delivered, res),
      returnRate: pct(a.returned, res),
      revenue: a.revenue,
    };
  });

  const home = orders.filter((o) => o.deliveryType === "HOME");
  const desk = orders.filter((o) => o.deliveryType === "OFFICE");
  const homeDel = home.filter((o) => DELIVERED.includes(st(o))).length;
  const deskDel = desk.filter((o) => DELIVERED.includes(st(o))).length;
  const homeRet = home.filter((o) => RETURNED.includes(st(o))).length;
  const deskRet = desk.filter((o) => RETURNED.includes(st(o))).length;

  // ── Ads ──
  const traced = orders.filter((o) => o.utmSource);
  const byCampaign: Record<string, { orders: number; delivered: number; revenue: number }> = {};
  for (const o of traced) {
    const k = o.utmCampaign || "(untagged campaign)";
    byCampaign[k] ||= { orders: 0, delivered: 0, revenue: 0 };
    byCampaign[k].orders += 1;
    if (DELIVERED.includes(st(o))) { byCampaign[k].delivered += 1; byCampaign[k].revenue += o.total; }
  }

  // ── Repeat buying ──
  const allPhones = await db.order.groupBy({ by: ["customerPhone"], _count: { _all: true } });
  const repeatBuyers = allPhones.filter((p) => p._count._all > 1).length;
  const earlier = new Set(
    (await db.order.findMany({ where: { createdAt: { lt: from } }, select: { customerPhone: true } }))
      .map((o) => o.customerPhone));
  const ordersFromReturning = orders.filter((o) => earlier.has(o.customerPhone)).length;

  // ── Weekly series ──
  const WEEKS = 10;
  const seriesFrom = new Date(Math.max(openFrom.getTime(), to.getTime() - WEEKS * 7 * 86400000));
  // Orders for the SERIES range, not the report window. Using the window's
  // orders meant that on 1 September every August week printed "0 placed,
  // 0 delivered, 0 revenue" beside its real ad spend — a table claiming the
  // second half of August sold nothing.
  const [adRows, seriesOrders] = await Promise.all([
    db.moneyMovement.findMany({
      where: { categoryKey: "ads_meta", occurredAt: { gte: seriesFrom } },
      select: { occurredAt: true, amountDzd: true },
    }),
    db.order.findMany({
      where: { OR: [{ createdAt: { gte: seriesFrom } }, { deliveredAt: { gte: seriesFrom } }] },
      select: { createdAt: true, deliveredAt: true, total: true },
    }),
  ]);
  const weekly: Scoreboard["weekly"] = [];
  for (let w = WEEKS - 1; w >= 0; w--) {
    const start = new Date(to.getTime() - (w + 1) * 7 * 86400000);
    const end = new Date(to.getTime() - w * 7 * 86400000);
    if (end < openFrom) continue;
    const inWeek = seriesOrders.filter((o) => o.createdAt >= start && o.createdAt < end);
    const del = seriesOrders.filter((o) => o.deliveredAt && o.deliveredAt >= start && o.deliveredAt < end);
    weekly.push({
      weekStart: day(start),
      placed: inWeek.length,
      delivered: del.length,
      revenue: del.reduce((s, o) => s + o.total, 0),
      adSpend: adRows.filter((r) => r.occurredAt >= start && r.occurredAt < end)
                     .reduce((s, r) => s + r.amountDzd, 0),
    });
  }

  // ── Targets ──
  const targetVal = (k: string) => {
    const v = settings.find((s) => s.key === k)?.value;
    const n = v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const check = (key: string, label: string, target: number | null, actual: number,
                 unit: string, direction: "below" | "above"): TargetCheck => ({
    key, label, target, actual, unit,
    met: target == null ? null : direction === "below" ? actual <= target : actual >= target,
    direction,
  });
  const adCostPerSale = delivered.length ? Math.round(adSpend / delivered.length) : 0;
  const returnRate = pct(returned.length, resolved);
  const bundleShare = pct(multiItem, delivered.length);
  const targets: TargetCheck[] = [
    check("target.adCostPerSale", "Ad cost per delivered sale", targetVal("target.adCostPerSale"), adCostPerSale, "DA", "below"),
    check("target.returnRate", "Return rate", targetVal("target.returnRate"), returnRate, "%", "below"),
    check("target.bundleShare", "Orders with more than one game", targetVal("target.bundleShare"), bundleShare, "%", "above"),
    check("target.monthlyProfit", "Profit this period", targetVal("target.monthlyProfit"), fin.profit, "DA", "above"),
  ];

  // ── What changed (this week vs the one before) ──
  const changes: Scoreboard["changes"] = [];
  if (weekly.length >= 2) {
    const a = weekly[weekly.length - 1];
    const b = weekly[weekly.length - 2];
    const move = (label: string, now: number, before: number, unit: string, good: boolean | null) => {
      if (before === 0 && now === 0) return;
      changes.push({ label, now, before, changePct: before > 0 ? Math.round(((now - before) / before) * 100) : 100, unit, good });
    };
    move("Orders placed", a.placed, b.placed, "orders", null);
    move("Delivered", a.delivered, b.delivered, "orders", null);
    move("Revenue collected", a.revenue, b.revenue, "DA", null);
    move("Ad spend", a.adSpend, b.adSpend, "DA", null);
    changes.sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct));
  }

  // ── Caveats — stated beside the numbers, never buried ──
  const caveats: string[] = [];
  const daysOfData = Math.round((Date.now() - openFrom.getTime()) / 86400000);
  if (daysOfData < 45) {
    caveats.push(`Only ${daysOfData} days of trustworthy data (books opened ${rules.openFrom}). Trends are short and noisy — treat week-over-week moves as signals, not conclusions.`);
  }
  caveats.push(`Phase-1 orders (before ${rules.openFrom}) have NO recorded delivery outcome. They are used here for basket composition only — never for delivery, returns or profit.`);
  const tracedShare = pct(traced.length, placed);
  caveats.push(`Ad attribution covers ${tracedShare}% of orders (${traced.length} of ${placed}); UTM tagging began 23 Aug 2026. The blended figures are the trustworthy ones; per-campaign covers only traced orders.`);
  if (fin.assumptions.length) {
    caveats.push(`Unconfirmed cost assumptions in use: ${fin.assumptions.map((a) => `${a.label} = ${a.value}`).join("; ")}.`);
  }
  if (repeatBuyers < 60) {
    caveats.push(`Repeat buying is real but early — ${repeatBuyers} customers have ordered more than once. Not enough for cohort curves yet.`);
  }
  if (fin.freshness.stale) caveats.push("The Ecotrack parcel cache is stale; revenue and the receivable may be out of date.");
  if (leadWeeks == null) caveats.push("Print lead time is not set, so no reorder dates can be calculated.");

  // ── The daily glance ──
  // Each row is a count and a link to the screen that OWNS that job. If this
  // rebuilt those lists you would have a fourth screen quietly disagreeing
  // with the other three.
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 86400000);
  const [uncollected, uncalled, zeroAmount, withDriver] = await Promise.all([
    db.order.count({ where: { status: "SHIPPED", shippedAt: { lt: twoDaysAgo } } }),
    db.order.count({ where: { status: { in: ["PENDING", "NO_ANSWER", "CALLBACK"] as never[] }, createdAt: { lt: new Date(now - 86400000) } } }),
    db.parcelTracking.count({ where: { montant: 0 } }),
    db.order.count({ where: { handedToDriverAt: { not: null }, handDeliveredAt: null } }),
  ]);
  const lowStock = productRows.filter((p) => !p.composite && p.weeksOfStock != null && p.weeksOfStock < 8).length;

  const attention: Scoreboard["attention"] = [];
  if (uncollected) attention.push({ key: "uncollected", label: "parcels the courier has not collected", count: uncollected, value: 0, href: "/agent", severity: "act" });
  if (uncalled) attention.push({ key: "uncalled", label: "orders waiting for a call", count: uncalled, value: 0, href: "/agent", severity: "act" });
  if (zeroAmount) attention.push({ key: "zero_amount", label: "parcels set to collect nothing", count: zeroAmount, value: 0, href: "/finance", severity: "act" });
  if (withDriver) attention.push({ key: "with_driver", label: "boxes with our driver, not yet settled", count: withDriver, value: 0, href: "/finance", severity: "watch" });
  if (lowStock) attention.push({ key: "low_stock", label: "products under 8 weeks of stock", count: lowStock, value: 0, href: "/analytics", severity: "watch" });
  if (fin.receivable.total > 0) attention.push({ key: "receivable", label: "DA Ecotrack is holding — go and collect", count: fin.receivable.parcels, value: fin.receivable.total, href: "/finance", severity: "watch" });

  // ── Yesterday, against the 7-day average ──
  const dayStart = (offset: number) => {
    const d = new Date(now + TZ_OFFSET_MIN * 60000);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + offset);
    return new Date(d.getTime() - TZ_OFFSET_MIN * 60000);
  };
  // -8 spans EIGHT days; dividing that by 7 inflated every average by ~14%
  // and made yesterday look reliably worse than normal.
  const yStart = dayStart(-1), yEnd = dayStart(0), wStart = dayStart(-7);
  const inDay = <T extends { createdAt?: Date | null; deliveredAt?: Date | null }>(rows: T[], f: (r: T) => Date | null | undefined, a: Date, b: Date) =>
    rows.filter((r) => { const d = f(r); return !!d && d >= a && d < b; });
  const yOrders = inDay(orders, (o) => o.createdAt, yStart, yEnd);
  const yDelivered = inDay(orders, (o) => o.deliveredAt, yStart, yEnd);
  const wOrders = inDay(orders, (o) => o.createdAt, wStart, yEnd);
  const wDelivered = inDay(orders, (o) => o.deliveredAt, wStart, yEnd);
  const yAds = adRows.filter((r) => r.occurredAt >= yStart && r.occurredAt < yEnd).reduce((s, r) => s + r.amountDzd, 0);

  return {
    generatedAt: new Date().toISOString(),
    window: { key: periodKey, label: fin.period.label, from: day(from), to: day(to), days: fin.period.days },
    attention,
    yesterday: {
      date: day(yStart),
      orders: yOrders.length,
      delivered: yDelivered.length,
      revenue: yDelivered.reduce((s, o) => s + o.total, 0),
      adSpend: yAds,
      avgOrders: Math.round((wOrders.length / 7) * 10) / 10,
      avgDelivered: Math.round((wDelivered.length / 7) * 10) / 10,
      avgRevenue: Math.round(wDelivered.reduce((s, o) => s + o.total, 0) / 7),
    },
    northStars: {
      profitPerDeliveredOrder: {
        value: profitPerOrder, unit: "DA",
        formula: "(revenue collected − courier fees − printing − wrapping − confirmation − upsell bonuses − returns − driver fees − ads − influencer payouts − recorded spending) ÷ delivered orders",
        caveat: "Uses the same cost model as /finance, so the two can never disagree.",
      },
      returnOnAdSpend: {
        value: blendedReturn, unit: "× (dinars of profit per dinar of ads)",
        formula: "(profit + ad spend) ÷ ad spend — i.e. contribution margin before advertising, divided by what advertising cost",
        caveat: "Blended across ALL orders, not just traceable ones. This is deliberate: it cannot be flattered by attribution gaps.",
      },
    },
    funnel: {
      placed, confirmed, shipped, delivered: delivered.length, returned: returned.length,
      lost, junk,
      // Counted directly, not subtracted: an order that was confirmed and
      // later cancelled was being taken off twice, which could drive this
      // below zero.
      stillOpen: orders.filter((o) => {
        const s = st(o);
        return !DELIVERED.includes(s) && !RETURNED.includes(s) && !LOST.includes(s) && !JUNK.includes(s);
      }).length,
      confirmRate: pct(confirmed, realLeads),
      deliveryRate: pct(delivered.length, resolved),
      returnRate,
    },
    money: {
      collected: fin.revenue.collected, courierFees: fin.revenue.courierFees, netRevenue: fin.revenue.net,
      costs: {
        printing: fin.costs.print, wrapping: fin.costs.wrapping, confirmation: fin.costs.confirmation,
        upsellBonuses: fin.costs.upsellBonus, returns: fin.costs.returnFees,
        deliveryGuy: fin.costs.driverFees, influencers: fin.costs.influencer,
        ...Object.fromEntries(fin.costs.typed.map((t) => [t.categoryKey, t.amountDzd])),
      },
      profit: fin.profit,
      receivable: fin.receivable.total, inTransit: fin.receivable.inTransit.gross,
    },
    products: productRows,
    basket: {
      aov, multiItemShare: bundleShare,
      gamesPerOrder: div(totalGames, delivered.length),
      bundleShare, phase1BundleShare,
      websiteUpsells, phoneUpsells,
    },
    tiers,
    channel: {
      home: { placed: home.length, delivered: homeDel, rate: pct(homeDel, homeDel + homeRet) },
      stopdesk: { placed: desk.length, delivered: deskDel, rate: pct(deskDel, deskDel + deskRet) },
    },
    ads: {
      spend: adSpend, costPerDeliveredOrder: adCostPerSale, blendedReturn,
      tracedOrders: traced.length, tracedShare,
      perCampaign: Object.entries(byCampaign)
        .map(([campaign, v]) => ({ campaign, ...v }))
        .sort((a, b) => b.orders - a.orders),
    },
    repeat: {
      customers: allPhones.length, repeatBuyers,
      repeatShare: pct(repeatBuyers, allPhones.length),
      ordersFromReturning,
    },
    weekly,
    targets,
    changes,
    caveats,
    definitions: {
      "contribution margin": "Revenue minus every cost that moves with a sale. Excludes anything fixed.",
      "profit per delivered order": "The headline. What one completed sale is genuinely worth after everything.",
      "return on ad spend": "NOT ROAS. ROAS divides revenue by ad spend and flatters you; this divides real contribution by ad spend.",
      "confirm rate": "Orders the agent reached and confirmed, as a share of real leads (wrong numbers and duplicates excluded).",
      "delivery rate": "Delivered ÷ (delivered + returned). Orders still in flight are excluded, so the number is not diluted by pending parcels.",
      "return rate": "Returned ÷ (delivered + returned). The COD killer — every point here is pure loss.",
      "bundle share": "Delivered orders holding two or more GAMES. The Roubla+Dlala pack is a single order line but counts as two games — counting lines instead of games understates this badly.",
      "receivable": "Money Ecotrack has collected from customers and not yet handed over. Their own status says «Livre encaissé non payé».",
      "tier": "Wilayas grouped by what they cost to deliver to, not by name — 43 wilayas across a few hundred orders is too thin to judge one at a time.",
    },
  };
}
