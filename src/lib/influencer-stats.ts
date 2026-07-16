import { db } from "@/lib/db";

// ─── Influencer money math ──────────────────────────────────
// One place computes every number the influencer window shows, so the
// admin table, the drill-down, and the influencer's own /i/<token> page
// can never disagree.
//
// Status buckets:
//   junk      = WRONG + DUPLICATE (fake numbers / duplicates — never counted)
//   placed    = every real order that used the code (junk removed)
//   confirmed = passed the confirmation call (confirmedAt set, or already
//               progressed past confirmation in the pipeline)
//   delivered = money actually collected
//   returned  = came back / on its way back
//
// Payable orders depend on the influencer's negotiated countTrigger:
//   CONFIRMED → confirmed orders   ·   PLACED → placed orders
// Commission depends on commissionBasis:
//   ORDER → rate × payable orders  ·   UNIT → rate × games inside them

const JUNK_STATUSES = new Set<string>(["WRONG", "DUPLICATE"]);
const CONFIRMED_STATUSES = new Set<string>([
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "AT_STOPDESK",
  "DELIVERY_FAILED",
  "IN_RETURN",
  "DELIVERED",
  "RETURNED",
]);
const RETURN_STATUSES = new Set<string>(["RETURNED", "IN_RETURN"]);
const TERMINAL_STATUSES = new Set<string>([
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
  "EXPIRED",
]);

export interface OrderLite {
  orderNumber: number;
  status: string;
  confirmedAt: Date | null;
  total: number;
  deliveryPrice: number;
  couponDiscount: number;
  createdAt: Date;
  units: number; // games in the order (sum of item quantities)
}

export interface DealTerms {
  commissionRate: number;
  commissionBasis: string; // "ORDER" | "UNIT"
  countTrigger: string; // "CONFIRMED" | "PLACED"
  fixedFee: number;
}

export interface InfluencerStats {
  placed: number;
  junk: number;
  confirmed: number;
  delivered: number;
  returned: number;
  cancelled: number;
  inFlight: number; // real orders not yet at a terminal status
  countedOrders: number; // payable per countTrigger
  countedUnits: number; // games inside payable orders
  revenueDelivered: number; // product money collected (total − delivery) on delivered
  discountCost: number; // coupon DA given away on delivered orders
  commissionOwed: number;
  fixedFee: number;
  owedTotal: number; // commission + fixed fee
  paidTotal: number; // logged payments
  balance: number; // owed − paid
  totalCost: number; // commission + fixed fee + discounts on delivered
  costPerDelivered: number | null; // the keep-or-drop number
  lastOrderAt: Date | null;
}

// ─── Usage cap (maxUses) ────────────────────────────────────
// A code with maxUses > 0 stops working once this many LIVE orders carry it
// ("first 150 copies" launch offers). Junk (wrong/duplicate) and dead
// (cancelled/expired) orders don't burn a slot — a cancelled order frees
// its copy, exactly like stock.
import { OrderStatus } from "@/generated/prisma/client";

const CAP_EXCLUDED: OrderStatus[] = [
  OrderStatus.WRONG,
  OrderStatus.DUPLICATE,
  OrderStatus.CANCELLED,
  OrderStatus.EXPIRED,
];

export async function countCapUses(couponCode: string): Promise<number> {
  return db.order.count({
    where: { couponCode, status: { notIn: CAP_EXCLUDED } },
  });
}

function isConfirmed(o: { status: string; confirmedAt: Date | null }): boolean {
  return o.confirmedAt !== null || CONFIRMED_STATUSES.has(o.status);
}

export function computeStats(
  orders: OrderLite[], // sorted newest-first
  deal: DealTerms,
  paidTotal: number
): InfluencerStats {
  const junk = orders.filter((o) => JUNK_STATUSES.has(o.status));
  const real = orders.filter((o) => !JUNK_STATUSES.has(o.status));
  const confirmed = real.filter(isConfirmed);
  const delivered = real.filter((o) => o.status === "DELIVERED");
  const returned = real.filter((o) => RETURN_STATUSES.has(o.status));
  const cancelled = real.filter(
    (o) => o.status === "CANCELLED" || o.status === "EXPIRED"
  );
  const inFlight = real.filter((o) => !TERMINAL_STATUSES.has(o.status)).length;

  const counted = deal.countTrigger === "PLACED" ? real : confirmed;
  const countedUnits = counted.reduce((n, o) => n + o.units, 0);
  const commissionOwed =
    deal.commissionBasis === "UNIT"
      ? deal.commissionRate * countedUnits
      : deal.commissionRate * counted.length;

  const revenueDelivered = delivered.reduce(
    (n, o) => n + (o.total - o.deliveryPrice),
    0
  );
  const discountCost = delivered.reduce(
    (n, o) => n + (o.couponDiscount || 0),
    0
  );
  const owedTotal = commissionOwed + deal.fixedFee;
  const totalCost = owedTotal + discountCost;

  return {
    placed: real.length,
    junk: junk.length,
    confirmed: confirmed.length,
    delivered: delivered.length,
    returned: returned.length,
    cancelled: cancelled.length,
    inFlight,
    countedOrders: counted.length,
    countedUnits,
    revenueDelivered,
    discountCost,
    commissionOwed,
    fixedFee: deal.fixedFee,
    owedTotal,
    paidTotal,
    balance: owedTotal - paidTotal,
    totalCost,
    costPerDelivered:
      delivered.length > 0 ? Math.round(totalCost / delivered.length) : null,
    lastOrderAt: orders.length > 0 ? orders[0].createdAt : null,
  };
}

// One query for ALL codes at once (the admin list) — grouped in JS.
export async function fetchOrdersForCodes(
  codes: string[]
): Promise<Map<string, OrderLite[]>> {
  const map = new Map<string, OrderLite[]>();
  if (codes.length === 0) return map;
  const rows = await db.order.findMany({
    where: { couponCode: { in: codes } },
    select: {
      orderNumber: true,
      status: true,
      confirmedAt: true,
      total: true,
      deliveryPrice: true,
      couponDiscount: true,
      createdAt: true,
      couponCode: true,
      items: { select: { quantity: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  for (const r of rows) {
    const code = r.couponCode as string;
    const lite: OrderLite = {
      orderNumber: r.orderNumber,
      status: r.status,
      confirmedAt: r.confirmedAt,
      total: r.total,
      deliveryPrice: r.deliveryPrice,
      couponDiscount: r.couponDiscount,
      createdAt: r.createdAt,
      units: r.items.reduce((n, it) => n + it.quantity, 0),
    };
    const list = map.get(code);
    if (list) list.push(lite);
    else map.set(code, [lite]);
  }
  return map;
}
