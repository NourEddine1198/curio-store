import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dbPg } from "@/lib/db-pg";
import { agentFromRequest } from "@/lib/agent-guard";
import { createParcel } from "@/lib/ecotrack";

export const dynamic = "force-dynamic";

// POST /api/agent/orders/[orderNumber]/ship — agent sends a confirmed order
// to Ecotrack (parcel created auto-filled from the order). Agent-authenticated.
export async function POST(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  try {
    const order = await db.order.findUnique({
      where: { orderNumber: num },
      include: { items: { include: { product: { select: { name: true } } } } },
    });
    if (!order) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });

    if (!["CONFIRMED", "PROCESSING"].includes(order.status)) {
      return NextResponse.json({ error: "لازم الطلب يكون مأكد قبل ما تبعثو لإيكوتراك" }, { status: 400 });
    }

    const result = await createParcel(order);
    if (!result.success) {
      return NextResponse.json({ error: result.error || "فشل الإرسال لإيكوتراك", rawResponse: result.rawResponse }, { status: 502 });
    }

    const updateData: Record<string, unknown> = { status: "SHIPPED", shippedAt: new Date() };
    if (result.trackingCode) updateData.trackingCode = result.trackingCode;
    updateData.webhookPayload = result.rawResponse as never;

    await dbPg.order.update({ where: { orderNumber: num }, data: updateData });

    const updated = await db.order.findUnique({
      where: { orderNumber: num },
      include: { items: { include: { product: { select: { name: true, slug: true } } } }, assignedAgent: { select: { id: true, name: true } } },
    });
    return NextResponse.json({ success: true, trackingCode: result.trackingCode || null, order: updated });
  } catch (error) {
    console.error("POST /api/agent/orders/[n]/ship error:", error);
    return NextResponse.json({ error: "صار مشكل في الشحن" }, { status: 500 });
  }
}
