import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeStats, fetchOrdersForCodes } from "@/lib/influencer-stats";

// Drill-down: every order behind one influencer's code + their payments.
// Admin view — includes customer name/wilaya (same trust level as /dashboard).

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const influencer = await db.influencer.findUnique({
    where: { id },
    include: { payments: { orderBy: { paidAt: "desc" } } },
  });
  if (!influencer)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const orders = await db.order.findMany({
    where: { couponCode: influencer.couponCode },
    select: {
      orderNumber: true,
      status: true,
      confirmedAt: true,
      customerName: true,
      wilayaName: true,
      total: true,
      deliveryPrice: true,
      couponDiscount: true,
      createdAt: true,
      items: {
        select: {
          quantity: true,
          product: { select: { name: true, slug: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const paidTotal = influencer.payments.reduce((n, p) => n + p.amount, 0);
  const ordersByCode = await fetchOrdersForCodes([influencer.couponCode]);
  const stats = computeStats(
    ordersByCode.get(influencer.couponCode) ?? [],
    influencer,
    paidTotal
  );

  return NextResponse.json({ influencer, orders, stats });
}
