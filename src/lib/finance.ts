// ─────────────────────────────────────────────────────────────
// Curio — the money-control engine behind /finance.
//
// READ-ONLY. Every function here counts; none of them writes.
//
// The one idea worth knowing before reading the code:
//
//   THE LEDGER is stored (MoneyMovement rows — cash that moved).
//   THE PROFIT is not. It is worked out here, on every request,
//   from orders + parcels + the cost rules in FinanceSetting.
//
// Nothing derived is written to a table, so correcting a cost rule
// fixes history instead of leaving a trail of stale totals behind.
//
// WHICH MONTH A SALE BELONGS TO: the day the parcel was DELIVERED,
// never the day the order was placed. Twelve of August's delivered
// parcels are waitlist orders placed in April–June; the money
// arrived in August and that is when it counts.
// ─────────────────────────────────────────────────────────────
import { db } from "@/lib/db";
import { compositionOf, type GameKind } from "@/lib/product-composition";

// ─── Cost rules ─────────────────────────────────────────────
export interface CostRules {
  openFrom: string;             // "2026-08-13" — books start here
  printRoubla: number;          // DA per game — real, not averaged
  printDlala: number;
  printDefault: number;
  wrapRoubla: number;
  wrapDlala: number;
  wrapDefault: number;
  confirmationPerOrder: number;
  upsellBonus: number;
  returnFee: number;
  eurDzd: number;               // DA per €1
}

const FALLBACK: CostRules = {
  openFrom: "2026-08-13",
  printRoubla: 480,
  printDlala: 280,
  printDefault: 480,
  wrapRoubla: 80,
  wrapDlala: 40,
  wrapDefault: 60,
  confirmationPerOrder: 80,
  upsellBonus: 150,
  returnFee: 50,
  eurDzd: 280,
};

/**
 * Read the cost rules from the database. Falls back to the seeded
 * values only if a row is missing — never to the old localStorage
 * numbers, which is the whole point of moving them here.
 */
export async function loadCostRules(): Promise<CostRules> {
  const rows = await db.financeSetting.findMany();
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const num = (k: string, fb: number) => {
    const v = get(k);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  return {
    openFrom: get("books.openFrom") || FALLBACK.openFrom,
    printRoubla: num("print.roubla", FALLBACK.printRoubla),
    printDlala: num("print.dlala", FALLBACK.printDlala),
    printDefault: num("print.default", FALLBACK.printDefault),
    wrapRoubla: num("wrap.roubla", FALLBACK.wrapRoubla),
    wrapDlala: num("wrap.dlala", FALLBACK.wrapDlala),
    wrapDefault: num("wrap.default", FALLBACK.wrapDefault),
    confirmationPerOrder: num("confirmation.perOrder", FALLBACK.confirmationPerOrder),
    upsellBonus: num("upsell.bonus", FALLBACK.upsellBonus),
    returnFee: num("return.fee", FALLBACK.returnFee),
    eurDzd: num("fx.eurDzd", FALLBACK.eurDzd),
  };
}
// What is inside each thing we sell lives in one shared module, so the
// bonus the agent is paid on and the cost the profit charges can never
// drift apart.

function wrapCost(kind: GameKind, r: CostRules): number {
  return kind === "roubla" ? r.wrapRoubla : kind === "dlala" ? r.wrapDlala : r.wrapDefault;
}

/** What one game cost to print. Roubla and Dlala are genuinely different
 *  (480 vs 280) — averaging them hid 95 DA on one and 105 DA on the other. */
function printCost(kind: GameKind, r: CostRules): number {
  return kind === "roubla" ? r.printRoubla : kind === "dlala" ? r.printDlala : r.printDefault;
}

// ─── Ecotrack status helpers ────────────────────────────────
const norm = (s: string | null | undefined) =>
  (s || "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const isDelivered = (globalStatus: string | null) => norm(globalStatus).startsWith("livre");
const isReturned = (globalStatus: string | null) => norm(globalStatus).startsWith("retour");

/**
 * Ecotrack's own words for "we have your cash and have not given it to
 * you". This is the receivable, straight from the courier's mouth —
 * `Livre encaissé non payé`. `Livre non encaissé` is the worse cousin:
 * delivered, and the money was never even collected.
 */
const isCollectedNotPaid = (status: string | null) => {
  const s = norm(status);
  return s.includes("encaisse") && !s.includes("non encaisse");
};

// ─── Dates ──────────────────────────────────────────────────
// Algiers is UTC+1 all year, no daylight saving.
const TZ_OFFSET_MIN = 60;

export function algiersDayStart(base: Date, dayOffset = 0): Date {
  const shifted = new Date(base.getTime() + TZ_OFFSET_MIN * 60000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  return new Date(shifted.getTime() - TZ_OFFSET_MIN * 60000);
}

export function algiersMonthStart(base: Date): Date {
  const shifted = new Date(base.getTime() + TZ_OFFSET_MIN * 60000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(1);
  return new Date(shifted.getTime() - TZ_OFFSET_MIN * 60000);
}

export type PeriodKey = "month" | "last30" | "all";

// ─── Shapes returned to the page ────────────────────────────
export interface TypedCost { categoryKey: string; label: string; amountDzd: number; count: number }

export interface FinanceReport {
  generatedAt: string;
  period: { key: PeriodKey; label: string; from: string; to: string; days: number };
  rules: CostRules;

  revenue: {
    parcels: number;
    collected: number;      // what customers actually handed the driver
    courierFees: number;    // Ecotrack's delivery charge on those parcels
    net: number;            // collected − courierFees = the cash you end up with
    games: { roubla: number; dlala: number; other: number; total: number };
  };

  costs: {
    print: number;
    wrapping: number;
    confirmation: number;
    upsellBonus: number;
    returnFees: number;
    returns: number;
    upsells: number;
    driverFees: number;
    handDelivered: number;
    influencer: number;
    typed: TypedCost[];
    typedTotal: number;
    total: number;
  };

  profit: number;
  perDeliveredOrder: number;

  receivable: {
    total: number;
    parcels: number;
    collectedNotPaid: { total: number; parcels: number };
    deliveredNotCollected: { total: number; parcels: number };
    inTransit: { gross: number; parcels: number };
    settledSoFar: number;
  };

  accounts: {
    key: string; name: string; currency: string;
    inAmount: number; outAmount: number;   // in the account's own currency
    inDzd: number; outDzd: number; netDzd: number;
    movements: number;
  }[];

  discrepancies: {
    orderNumber: number; ours: number; theirs: number; diff: number;
    trackingCode: string; status: string; customerName: string;
  }[];

  assumptions: { key: string; label: string; value: string; unit: string | null; note: string | null }[];

  freshness: { parcelsSyncedAt: string | null; ageHours: number | null; stale: boolean };
}

/** How stale the parcel cache may be before we refuse to show a profit. */
const STALE_AFTER_HOURS = 24;

export async function buildFinanceReport(periodKey: PeriodKey = "month"): Promise<FinanceReport> {
  const rules = await loadCostRules();
  const now = new Date();

  // ── Window. Never earlier than the day the books open, so a
  //    calendar month that starts before Phase 2 cannot drag in
  //    Phase-1 orders nobody has an outcome for.
  const openFrom = new Date(`${rules.openFrom}T00:00:00.000Z`);
  const rawFrom =
    periodKey === "all" ? openFrom
    : periodKey === "last30" ? new Date(now.getTime() - 30 * 86400000)
    : algiersMonthStart(now);
  const from = rawFrom < openFrom ? openFrom : rawFrom;
  const to = now;
  // Filtering ends at the END of today in Algiers, not at this instant.
  // Hand-typed rows are stored at midday so a calendar date can't slip to the
  // day before in another timezone — which means a cost recorded at 9am would
  // sit in the "future" and vanish from today's profit until noon.
  const filterTo = algiersDayStart(now, 1);
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000));
  const label =
    periodKey === "all" ? "Since the books opened"
    : periodKey === "last30" ? "Last 30 days"
    : "This month";

  const [parcels, settings, accounts, categories, movements, payouts, influencerPayments, upsellEvents, handDelivered] =
    await Promise.all([
      db.parcelTracking.findMany({
        select: {
          trackingCode: true, status: true, globalStatus: true,
          montant: true, tarifLivraison: true, tarifRetour: true, syncedAt: true,
          lastMoveAt: true,
          order: {
            select: {
              orderNumber: true, total: true, customerName: true,
              deliveredAt: true, returnedAt: true, shippedAt: true,
              items: { select: { quantity: true, product: { select: { slug: true } } } },
            },
          },
        },
      }),
      db.financeSetting.findMany({
        where: { NOT: { key: { startsWith: "watch.seen." } } },
        orderBy: { sort: "asc" },
      }),
      db.financeAccount.findMany({ where: { active: true }, orderBy: { sort: "asc" } }),
      db.financeCategory.findMany(),
      db.moneyMovement.findMany({
        where: { occurredAt: { gte: from, lt: filterTo } },
        select: { accountId: true, toAccountId: true, categoryKey: true, direction: true, amount: true, amountDzd: true },
      }),
      db.courierPayout.findMany({ select: { trackingCodes: true, slipTotal: true, collectedAt: true } }),
      db.influencerPayment.findMany({ where: { paidAt: { gte: from, lt: filterTo } }, select: { amount: true } }),
      // One row per game the agent sold on the phone. Written by the agent
      // console at the moment she adds the line — the only honest record of
      // it. Only orders that actually arrived earn the bonus, to match the
      // 80-per-DELIVERED-order rule she is already paid on.
      db.orderEvent.findMany({
        where: { kind: "upsell", createdAt: { gte: from, lt: filterTo } },
        select: { order: { select: { status: true, preHandledStatus: true } } },
      }),
      // Boxes our own driver carried. They have no Ecotrack parcel, so without
      // this query the sale would count ZERO revenue while the cash quietly
      // arrived — the profit understated by the whole order, every time.
      db.order.findMany({
        where: { handDeliveredAt: { gte: from, lt: filterTo } },
        select: {
          orderNumber: true, total: true, handDeliveryFee: true,
          items: { select: { quantity: true, product: { select: { slug: true } } } },
        },
      }),
    ]);

  // ── Freshness. Revenue AND the receivable both come from this
  //    cache, so a broken sync would make the profit quietly wrong
  //    rather than loudly missing. The page shows this line always.
  const syncedAt = parcels.reduce<Date | null>(
    (max, p) => (!max || p.syncedAt > max ? p.syncedAt : max), null);
  const ageHours = syncedAt ? (now.getTime() - syncedAt.getTime()) / 3600000 : null;
  const freshness = {
    parcelsSyncedAt: syncedAt ? syncedAt.toISOString() : null,
    ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
    stale: ageHours == null || ageHours > STALE_AFTER_HOURS,
  };

  // ── Revenue + per-game costs, from parcels delivered IN the window ──
  const inWindow = (d: Date | null | undefined) => !!d && d >= from && d < filterTo;

  const eachGame = (
    items: { quantity: number; product: { slug: string } | null }[],
    fn: (kind: GameKind, qty: number) => void
  ) => {
    for (const it of items) {
      const parts = compositionOf(it.product?.slug);
      for (const kind of parts) fn(kind, it.quantity);
    }
  };

  // ── Revenue and the costs that belong to a completed sale ──
  let collected = 0, courierFees = 0, print = 0, deliveredCount = 0;
  let wrappingHand = 0;
  const games = { roubla: 0, dlala: 0, other: 0 };

  for (const p of parcels) {
    if (!isDelivered(p.globalStatus)) continue;
    if (!inWindow(p.order?.deliveredAt)) continue;

    deliveredCount += 1;
    // Revenue is what the COURIER collected, not what our order says.
    // Where the two disagree the courier is right — that is the cash the
    // customer actually handed over — and the gap is surfaced below
    // rather than quietly absorbed.
    collected += p.montant;
    courierFees += p.tarifLivraison;

    // Printing is charged only on a game that SOLD. A returned box comes
    // back and goes out again, so its printing was never lost.
    eachGame(p.order!.items, (kind, qty) => {
      games[kind] += qty;
      print += qty * printCost(kind, rules);
    });
  }

  // Our own driver's boxes: same sale, different road. The courier fee is
  // zero because there is no courier — his fee is a separate line below.
  let driverFees = 0;
  for (const o of handDelivered) {
    deliveredCount += 1;
    collected += o.total;
    driverFees += o.handDeliveryFee ?? 0;
    eachGame(o.items, (kind, qty) => {
      games[kind] += qty;
      print += qty * printCost(kind, rules);
      // No parcel means the wrapping loop below will never see this order,
      // so its packaging is charged here instead.
      wrappingHand += qty * wrapCost(kind, rules);
    });
  }

  // ── Wrapping is charged when the box is PACKED, not when it arrives ──
  // The plastic, the bag and the scotch are gone the moment it ships,
  // whether or not the customer ever takes it. Charging it on delivery
  // would quietly under-count every parcel still in transit.
  let wrapping = wrappingHand;
  for (const p of parcels) {
    if (!inWindow(p.order?.shippedAt)) continue;
    eachGame(p.order!.items, (kind, qty) => { wrapping += qty * wrapCost(kind, rules); });
  }

  // ── Returns ──
  // Most returns never get `returnedAt` filled in: an order sits in
  // "Retours en traitement" for days before anyone marks it RETURNED, and
  // 14 of this month's 15 have no date on our side at all. The parcel's
  // own last movement is the honest stand-in — it is the day the courier
  // started sending the box back, which is when they charge us.
  const returnsInWindow = parcels.filter((p) => {
    if (!isReturned(p.globalStatus)) return false;
    return inWindow(p.order?.returnedAt ?? p.lastMoveAt);
  });
  const returnFees = returnsInWindow.length * rules.returnFee;
  const confirmation = deliveredCount * rules.confirmationPerOrder;

  const upsellsPaid = upsellEvents.filter((e) => {
    const st = e.order?.status === "HANDLED" ? e.order?.preHandledStatus : e.order?.status;
    return st === "DELIVERED";
  }).length;
  const upsellBonus = upsellsPaid * rules.upsellBonus;

  const influencer = influencerPayments.reduce((s, r) => s + r.amount, 0);

  // ── Typed costs: only categories the profit view does NOT work out
  //    itself. Paying the agent her month in cash is a real ledger row
  //    but must not land here, or it double-counts the 80-per-order.
  const autoKeys = new Set(categories.filter((c) => c.auto).map((c) => c.key));
  const labelOf = (k: string) => categories.find((c) => c.key === k)?.label || k;
  // Non-auto INCOME is money the profit view cannot see any other way — it
  // has no parcel behind it — so it is added as a negative cost.
  let typedIncome = 0;
  for (const m of movements) {
    if (m.direction === "in" && !autoKeys.has(m.categoryKey)) typedIncome += m.amountDzd;
  }

  const typedMap = new Map<string, { amountDzd: number; count: number }>();
  for (const m of movements) {
    if (m.direction !== "out") continue;
    if (autoKeys.has(m.categoryKey)) continue;
    const cur = typedMap.get(m.categoryKey) || { amountDzd: 0, count: 0 };
    cur.amountDzd += m.amountDzd;
    cur.count += 1;
    typedMap.set(m.categoryKey, cur);
  }
  // Array.from, not a spread: this project compiles to a target where
  // spreading a Map iterator needs --downlevelIteration.
  const typed: TypedCost[] = Array.from(typedMap.entries())
    .map(([categoryKey, v]) => ({ categoryKey, label: labelOf(categoryKey), ...v }))
    .sort((a, b) => b.amountDzd - a.amountDzd);
  const typedTotal = typed.reduce((s, t) => s + t.amountDzd, 0);

  const net = collected - courierFees;
  const costsTotal = print + wrapping + confirmation + upsellBonus + returnFees + driverFees + influencer + typedTotal - typedIncome;
  const profit = net - costsTotal;

  // ── The receivable. A delivered parcel is owed to us until its
  //    tracking code turns up on a payout slip. That list is the only
  //    thing standing between us and counting the same cash twice.
  const settled = new Set<string>();
  for (const po of payouts) for (const t of po.trackingCodes) settled.add(t);

  let recvTotal = 0, recvParcels = 0;
  let cnpTotal = 0, cnpParcels = 0;      // collected, not paid to us
  let dncTotal = 0, dncParcels = 0;      // delivered, never collected
  let transitGross = 0, transitParcels = 0;

  for (const p of parcels) {
    if (isDelivered(p.globalStatus)) {
      if (settled.has(p.trackingCode)) continue;
      const owed = p.montant - p.tarifLivraison;
      recvTotal += owed;
      recvParcels += 1;
      if (isCollectedNotPaid(p.status)) { cnpTotal += owed; cnpParcels += 1; }
      else { dncTotal += owed; dncParcels += 1; }
    } else if (!isReturned(p.globalStatus)) {
      transitGross += p.montant;
      transitParcels += 1;
    }
  }
  const settledSoFar = payouts.reduce((s, p) => s + p.slipTotal, 0);

  // ── The ledger, per account ──
  const accountRows = accounts.map((a) => {
    const mine = movements.filter((m) => m.accountId === a.id);
    // A transfer names the SOURCE in accountId and the destination in
    // toAccountId. Without the second filter the money left one account and
    // arrived nowhere.
    const arriving = movements.filter((m) => m.direction === "transfer" && m.toAccountId === a.id);
    const ins = mine.filter((m) => m.direction === "in").concat(arriving);
    const outs = mine.filter((m) => m.direction === "out" || m.direction === "transfer");
    const sum = (rows: typeof mine, f: (m: (typeof mine)[number]) => number) =>
      rows.reduce((s, m) => s + f(m), 0);
    const inDzd = sum(ins, (m) => m.amountDzd);
    const outDzd = sum(outs, (m) => m.amountDzd);
    return {
      key: a.key, name: a.name, currency: a.currency,
      inAmount: sum(ins, (m) => m.amount),
      outAmount: sum(outs, (m) => m.amount),
      inDzd, outDzd, netDzd: inDzd - outDzd,
      movements: mine.length,
    };
  });

  // ── Where our books and the courier disagree ──
  // Always worth looking at: every one found so far was real money.
  const discrepancies = parcels
    .filter((p) => p.order && p.montant !== p.order.total && !isReturned(p.globalStatus))
    .map((p) => ({
      orderNumber: p.order!.orderNumber,
      ours: p.order!.total,
      theirs: p.montant,
      diff: p.montant - p.order!.total,
      trackingCode: p.trackingCode,
      status: p.status || p.globalStatus || "",
      customerName: p.order!.customerName,
    }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // ── Anything still a guess, surfaced rather than buried ──
  const assumptions = settings
    .filter((s) => (s.note || "").toUpperCase().includes("ASSUMPTION"))
    .map((s) => ({ key: s.key, label: s.label || s.key, value: s.value, unit: s.unit, note: s.note }));

  return {
    generatedAt: now.toISOString(),
    period: { key: periodKey, label, from: from.toISOString(), to: to.toISOString(), days },
    rules,
    revenue: {
      parcels: deliveredCount, collected, courierFees, net,
      games: { ...games, total: games.roubla + games.dlala + games.other },
    },
    costs: {
      print, wrapping, confirmation, upsellBonus, returnFees,
      returns: returnsInWindow.length, upsells: upsellsPaid,
      driverFees, handDelivered: handDelivered.length, influencer,
      typed, typedTotal, total: costsTotal,
    },
    profit,
    perDeliveredOrder: deliveredCount > 0 ? Math.round(profit / deliveredCount) : 0,
    receivable: {
      total: recvTotal, parcels: recvParcels,
      collectedNotPaid: { total: cnpTotal, parcels: cnpParcels },
      deliveredNotCollected: { total: dncTotal, parcels: dncParcels },
      inTransit: { gross: transitGross, parcels: transitParcels },
      settledSoFar,
    },
    accounts: accountRows,
    discrepancies,
    assumptions,
    freshness,
  };
}

// ═════════════════════════════════════════════════════════════
// PHASE 2 — the receivable, parcel by parcel, and the payout slip
// ═════════════════════════════════════════════════════════════

export interface UnsettledParcel {
  trackingCode: string;
  orderNumber: number | null;
  customerName: string;
  wilaya: string;
  /** What the courier collected from the customer. */
  montant: number;
  /** Their delivery charge on this parcel. */
  fee: number;
  /** montant − fee: what should land on a payout slip. */
  net: number;
  deliveredAt: string | null;
  /** How long Ecotrack has been sitting on this money. */
  daysHeld: number | null;
  /** Their words. `Livre encaissé non payé` = collected, owed to us. */
  status: string;
  /** False when the status says delivered but never collected — a different problem. */
  collected: boolean;
}

/**
 * Every delivered parcel whose tracking code has not yet turned up on a
 * payout slip. Oldest first, because age is the whole point: money the
 * courier collected three weeks ago and has not handed over is a very
 * different thing from money collected yesterday, and on the summary card
 * the two look identical.
 */
export async function listUnsettledParcels(): Promise<UnsettledParcel[]> {
  const [parcels, payouts] = await Promise.all([
    db.parcelTracking.findMany({
      select: {
        trackingCode: true, status: true, globalStatus: true,
        montant: true, tarifLivraison: true,
        order: {
          select: { orderNumber: true, customerName: true, wilayaName: true, deliveredAt: true },
        },
      },
    }),
    db.courierPayout.findMany({ select: { trackingCodes: true } }),
  ]);

  const settled = new Set<string>();
  for (const p of payouts) for (const t of p.trackingCodes) settled.add(t);

  const now = Date.now();
  const rows: UnsettledParcel[] = [];
  for (const p of parcels) {
    if (!isDelivered(p.globalStatus)) continue;
    if (settled.has(p.trackingCode)) continue;
    const deliveredAt = p.order?.deliveredAt ?? null;
    rows.push({
      trackingCode: p.trackingCode,
      orderNumber: p.order?.orderNumber ?? null,
      customerName: p.order?.customerName ?? "—",
      wilaya: p.order?.wilayaName ?? "—",
      montant: p.montant,
      fee: p.tarifLivraison,
      net: p.montant - p.tarifLivraison,
      deliveredAt: deliveredAt ? deliveredAt.toISOString() : null,
      daysHeld: deliveredAt ? Math.floor((now - deliveredAt.getTime()) / 86400000) : null,
      status: p.status || p.globalStatus || "",
      collected: isCollectedNotPaid(p.status),
    });
  }

  // Oldest money first — that is the order he should be chasing it in, and
  // the order a payout slip almost certainly covers.
  rows.sort((a, b) => {
    if (a.deliveredAt && b.deliveredAt) return a.deliveredAt.localeCompare(b.deliveredAt);
    if (a.deliveredAt) return -1;
    if (b.deliveredAt) return 1;
    return 0;
  });
  return rows;
}

/** Turn an amount in an account's own currency into dinars for reporting. */
export function toDzd(amount: number, currency: string, eurDzd: number): number {
  // EUR is held in cents so no float ever touches money on the way in.
  return currency === "EUR" ? Math.round((amount / 100) * eurDzd) : amount;
}
