import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// Payout log for one influencer: record a payment, undo a mistaken one.
// Admin-key gated.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;

function authorized(request: NextRequest): boolean {
  return !!ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const influencer = await db.influencer.findUnique({ where: { id } });
  if (!influencer)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: "المبلغ لازم يكون رقم موجب" },
      { status: 400 }
    );
  }

  const paidAt = body?.paidAt ? new Date(body.paidAt) : new Date();
  if (isNaN(paidAt.getTime())) {
    return NextResponse.json({ error: "تاريخ غير صحيح" }, { status: 400 });
  }

  const payment = await db.influencerPayment.create({
    data: {
      influencerId: id,
      amount: Math.floor(amount),
      note:
        typeof body?.note === "string" ? body.note.trim() || null : null,
      paidAt,
    },
  });

  return NextResponse.json({ payment }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const paymentId = request.nextUrl.searchParams.get("paymentId");
  if (!paymentId)
    return NextResponse.json({ error: "paymentId مطلوب" }, { status: 400 });

  // Guard: the payment must belong to this influencer.
  const payment = await db.influencerPayment.findUnique({
    where: { id: paymentId },
  });
  if (!payment || payment.influencerId !== id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await db.influencerPayment.delete({ where: { id: paymentId } });
  return NextResponse.json({ ok: true });
}
