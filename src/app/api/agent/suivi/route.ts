import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { isCollectedNotPaid } from "@/lib/suivi";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// GET /api/agent/suivi — the follow-up board.
//
// Answers one question: which parcels in the air need a human today?
// Reads the cached ParcelTracking rows the cron fills, so this is a
// plain indexed query — no Ecotrack call on the request path.
//
// Buckets:
//   act    — call somebody now (no answer, phone off, cancelled,
//            suspended, repeated failed attempts, stuck for days)
//   watch  — one failed attempt, a note from the driver, a reschedule
//   money  — delivered and cash collected, but Ecotrack hasn't paid us
export async function GET(request: NextRequest) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = new URL(request.url).searchParams.get("bucket") || "act";

  // The money filter has to run in SQL, not in JS after the fact. Filtering
  // a `take`-limited page meant the query first grabbed the 300 oldest-moving
  // parcels of ANY kind — and delivered ones move most recently, so they sort
  // last and were exactly what the limit threw away. The tab would have shown
  // "they owe us 84,000 DA" above an empty list.
  const MONEY_WHERE = {
    AND: [
      { status: { contains: "encaiss", mode: "insensitive" as const } },
      { status: { contains: "non pay", mode: "insensitive" as const } },
    ],
  };
  const where =
    bucket === "money"
      ? { orderId: { not: null }, ...MONEY_WHERE }
      : { orderId: { not: null }, alertLevel: bucket === "watch" ? "watch" : "act" };

  try {
    const parcels = await db.parcelTracking.findMany({
      where,
      include: {
        order: {
          select: {
            orderNumber: true, customerName: true, customerPhone: true, customerPhone2: true,
            wilayaName: true, commune: true, total: true, status: true, deliveryType: true,
            shippedAt: true,
            items: { select: { quantity: true, product: { select: { name: true } } } },
          },
        },
      },
      orderBy: [{ lastMoveAt: "asc" }],
      take: 300,
    });

    const rows = parcels
      // Belt-and-braces: SQL narrowed it, this keeps the exact
      // accent-insensitive semantics as the single source of truth.
      .filter((p) => (bucket === "money" ? isCollectedNotPaid(p.status) : true))
      .filter((p) => !!p.order)
      .map((p) => ({
        orderNumber: p.order!.orderNumber,
        customerName: p.order!.customerName,
        customerPhone: p.order!.customerPhone,
        customerPhone2: p.order!.customerPhone2,
        wilayaName: p.order!.wilayaName,
        commune: p.order!.commune,
        total: p.order!.total,
        orderStatus: p.order!.status,
        deliveryType: p.order!.deliveryType,
        shippedAt: p.order!.shippedAt,
        products: p.order!.items.map((i) => i.product.name + (i.quantity > 1 ? ` x${i.quantity}` : "")).join(" + "),

        trackingCode: p.trackingCode,
        ecotrackStatus: p.status,
        currentStation: p.currentStation,
        driverName: p.driverName,
        driverPhone: p.driverPhone,
        montant: p.montant,
        attemptCount: p.attemptCount,
        alertLevel: p.alertLevel,
        alertReason: p.alertReason,
        lastMoveAt: p.lastMoveAt,
        postponedTo: p.postponedTo,
        syncedAt: p.syncedAt,
      }));

    // Counts for the tab badges — cheap, and the agent needs to see
    // the size of each pile before deciding where to start.
    // Aggregated in SQL. This used to pull every cached row into memory on
    // every board load — and the board reloads it on each tab switch.
    const [actCount, watchCount, moneyAgg] = await Promise.all([
      db.parcelTracking.count({ where: { alertLevel: "act", orderId: { not: null } } }),
      db.parcelTracking.count({ where: { alertLevel: "watch", orderId: { not: null } } }),
      db.parcelTracking.aggregate({
        where: { orderId: { not: null }, ...MONEY_WHERE },
        _count: { _all: true },
        _sum: { montant: true },
      }),
    ]);

    return NextResponse.json({
      rows,
      counts: {
        act: actCount,
        watch: watchCount,
        money: moneyAgg._count._all,
        moneyTotal: moneyAgg._sum.montant || 0,
      },
    });
  } catch (error) {
    console.error("GET /api/agent/suivi error:", error);
    return NextResponse.json({ error: "ما نجمناش نجيبو المتابعة" }, { status: 500 });
  }
}
