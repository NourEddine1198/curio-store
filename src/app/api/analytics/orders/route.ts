import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadCostRules, algiersMonthStart, type PeriodKey } from "@/lib/finance";
import { compositionOf, physicalUnitsOf } from "@/lib/product-composition";

// The orders behind a number.
//
// Click "return rate 9.7%" and the sixteen returned orders appear, with
// names and wilayas. That is the difference between a number you act on and
// one you argue with — and it is why the page states figures rather than
// drawing charts nobody can interrogate.
//
//   /api/analytics/orders?metric=returned&period=month
//
// Read-only, admin-key gated. The brief token is NOT accepted here: it is a
// link pasted into chats, and customer names and phone numbers should not
// travel with it.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;

const realStatus = (o: { status: string; preHandledStatus: string | null }) =>
  o.status === "HANDLED" ? (o.preHandledStatus ?? "PENDING") : o.status;

const DELIVERED = ["DELIVERED"];
const RETURNED = ["RETURNED", "IN_RETURN"];
const JUNK = ["WRONG", "DUPLICATE"];
const LOST = ["CANCELLED", "EXPIRED"];

// Every number on the page that can be opened, and what it means.
// NOT exported: a Next route file may only export its handlers and a small
// set of config names, and an extra export fails the build.
const METRICS: Record<string, string> = {
  placed: "Every order placed in the window",
  confirmed: "Orders the agent reached and confirmed",
  delivered: "Orders that arrived and were paid for",
  returned: "Orders that came back — every one is pure loss",
  lost: "Cancelled or expired before shipping",
  junk: "Wrong numbers and duplicates — never real customers",
  open: "Still working: called, waiting, or in flight",
  bundle: "Delivered orders holding two or more games",
  single: "Delivered orders holding exactly one game",
  repeat: "Orders from a customer who had bought before",
  uncollected: "Shipped, but the courier has never come for them",
  zero_amount: "Parcels the courier was told to collect nothing for",
  with_driver: "Boxes our own driver is holding right now",
  discrepancy: "The courier will collect a different amount than our books say",
};

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const metric = String(request.nextUrl.searchParams.get("metric") || "");
  if (!METRICS[metric]) {
    return NextResponse.json({ error: "unknown metric", known: Object.keys(METRICS) }, { status: 400 });
  }
  const rawPeriod = request.nextUrl.searchParams.get("period");
  const period = (["month", "last30", "all"].includes(rawPeriod || "") ? rawPeriod : "month") as PeriodKey;
  const tier = request.nextUrl.searchParams.get("tier");
  const slug = request.nextUrl.searchParams.get("product");

  try {
    const rules = await loadCostRules();
    const openFrom = new Date(`${rules.openFrom}T00:00:00.000Z`);
    const now = new Date();
    const rawFrom =
      period === "all" ? openFrom
      : period === "last30" ? new Date(now.getTime() - 30 * 86400000)
      : algiersMonthStart(now);   // Algiers month, matching /finance
    const from = rawFrom < openFrom ? openFrom : rawFrom;

    const orders = await db.order.findMany({
      where: { createdAt: { gte: from } },
      orderBy: { createdAt: "desc" },
      select: {
        orderNumber: true, status: true, preHandledStatus: true, customerName: true,
        customerPhone: true, wilayaCode: true, wilayaName: true, commune: true,
        deliveryType: true, total: true, createdAt: true, deliveredAt: true,
        shippedAt: true, confirmedAt: true, returnReason: true, cancelReason: true,
        handedToDriverAt: true, handDeliveredAt: true, trackingCode: true,
        items: { select: { quantity: true, product: { select: { slug: true, name: true } } } },
        parcel: { select: { status: true, montant: true } },
      },
    });

    const gamesIn = (o: (typeof orders)[number]) =>
      o.items.reduce((s, i) => s + compositionOf(i.product?.slug).length * i.quantity, 0);

    // Who had bought before this window opened.
    // Junk was counted as a prior purchase, so a wrong number typed twice
    // made the second order look like a returning customer.
    const earlier = new Set(
      (await db.order.findMany({
        where: { createdAt: { lt: from }, status: { notIn: ["WRONG", "DUPLICATE"] as never[] } },
        select: { customerPhone: true },
      })).map((o) => o.customerPhone));

    let rows = orders;
    switch (metric) {
      case "placed": break;
      case "confirmed": rows = orders.filter((o) => o.confirmedAt); break;
      // Dated by when they RESOLVED, matching the headline figures. Filtering
      // on createdAt gave a different count than the number that was clicked.
      case "delivered":
        rows = orders.filter((o) => DELIVERED.includes(realStatus(o)) && o.deliveredAt && o.deliveredAt >= from);
        break;
      case "returned": rows = orders.filter((o) => RETURNED.includes(realStatus(o))); break;
      case "lost": rows = orders.filter((o) => LOST.includes(realStatus(o))); break;
      case "junk": rows = orders.filter((o) => JUNK.includes(realStatus(o))); break;
      case "open":
        rows = orders.filter((o) => {
          const s = realStatus(o);
          return !DELIVERED.includes(s) && !RETURNED.includes(s) && !LOST.includes(s) && !JUNK.includes(s);
        });
        break;
      case "bundle": rows = orders.filter((o) => DELIVERED.includes(realStatus(o)) && gamesIn(o) > 1); break;
      case "single": rows = orders.filter((o) => DELIVERED.includes(realStatus(o)) && gamesIn(o) === 1); break;
      case "repeat": rows = orders.filter((o) => earlier.has(o.customerPhone)); break;
      // These three ignore the window on purpose — a parcel stuck for eleven
      // days is exactly the thing a window would hide.
      case "uncollected":
        rows = (await db.order.findMany({
          where: { status: "SHIPPED", shippedAt: { lt: new Date(Date.now() - 2 * 86400000) } },
          orderBy: { shippedAt: "asc" },
          select: { orderNumber: true, status: true, preHandledStatus: true, customerName: true,
            customerPhone: true, wilayaCode: true, wilayaName: true, commune: true, deliveryType: true,
            total: true, createdAt: true, deliveredAt: true, shippedAt: true, confirmedAt: true,
            returnReason: true, cancelReason: true, handedToDriverAt: true, handDeliveredAt: true, trackingCode: true,
            items: { select: { quantity: true, product: { select: { slug: true, name: true } } } },
            parcel: { select: { status: true, montant: true } } },
        })) as typeof orders;
        break;
      case "zero_amount": rows = orders.filter((o) => o.parcel && o.parcel.montant === 0); break;
      case "with_driver": rows = orders.filter((o) => o.handedToDriverAt && !o.handDeliveredAt); break;
      case "discrepancy": rows = orders.filter((o) => o.parcel && o.parcel.montant !== o.total); break;
    }

    if (slug) rows = rows.filter((o) => o.items.some((i) => i.product?.slug === slug));
    if (tier) {
      const wil = await db.wilaya.findMany({ select: { code: true, homePrice: true } });
      const priceOf: Record<string, number> = {};
      for (const w of wil) priceOf[w.code] = w.homePrice;
      const tierOf = (p: number) => (p <= 500 ? "Algiers" : p <= 700 ? "Near Algiers" : p <= 900 ? "Standard" : "Far south");
      rows = rows.filter((o) => tierOf(priceOf[o.wilayaCode] ?? 850) === tier);
    }

    return NextResponse.json({
      metric, meaning: METRICS[metric], period, from: from.toISOString(),
      count: rows.length,
      value: rows.reduce((s, o) => s + o.total, 0),
      orders: rows.slice(0, 300).map((o) => ({
        orderNumber: o.orderNumber,
        status: realStatus(o),
        customerName: o.customerName,
        customerPhone: o.customerPhone,
        where: o.commune || o.wilayaName,
        wilaya: o.wilayaName,
        deliveryType: o.deliveryType,
        total: o.total,
        games: gamesIn(o),
        what: o.items.map((i) => `${i.product?.name ?? "?"}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(" + "),
        placed: o.createdAt.toISOString(),
        delivered: o.deliveredAt?.toISOString() ?? null,
        shipped: o.shippedAt?.toISOString() ?? null,
        daysWaiting: o.shippedAt && !o.deliveredAt
          ? Math.floor((Date.now() - o.shippedAt.getTime()) / 86400000) : null,
        reason: o.returnReason || o.cancelReason || null,
        courierSays: o.parcel?.status ?? null,
        courierCollects: o.parcel?.montant ?? null,
        physical: physicalUnitsOf(o.items[0]?.product?.slug),
        repeat: earlier.has(o.customerPhone),
      })),
      truncated: rows.length > 300,
    });
  } catch (error) {
    console.error("GET /api/analytics/orders error:", error);
    return NextResponse.json({ error: "Failed to load the orders" }, { status: 500 });
  }
}
