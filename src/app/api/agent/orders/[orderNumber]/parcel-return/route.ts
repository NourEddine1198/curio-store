import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { POST_SHIP_ACTIVE } from "@/lib/order-status";
import { askParcelReturn } from "@/lib/ecotrack";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/agent/orders/[n]/parcel-return — «اطلب الإرجاع».
// Tells Ecotrack to stop retrying and send the box home. Used when the
// customer has gone silent or cancelled: every extra retry costs us a
// delivery attempt and delays the unit getting back on the shelf.
//
// We do NOT move our own status here. The parcel takes days to travel
// back; the tracking sync flips the order to IN_RETURN/RETURNED when
// Ecotrack actually says so. Writing it locally would be a guess.
export async function POST(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  try {
    const order = await db.order.findUnique({
      where: { orderNumber: num },
      select: { id: true, status: true, trackingCode: true },
    });
    if (!order) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    if (!order.trackingCode) {
      return NextResponse.json({ error: "هذا الطلب ما عندوش كولي في إيكوتراك" }, { status: 400 });
    }
    // Same lock as parcel-edit: only a parcel actually in flight. An order
    // that was cancelled or marked duplicate can still hold a stale tracking
    // code, and asking the courier to return a box for it is a real action.
    if (!(POST_SHIP_ACTIVE as readonly string[]).includes(order.status)) {
      return NextResponse.json({ error: "الطلب خلاص وصل لنهايتو — ما ينفعش طلب الإرجاع" }, { status: 400 });
    }

    const agentRow = await db.agent.findUnique({ where: { id: agent.id }, select: { name: true } });
    const agentName = agentRow?.name || "agent";

    const body = await request.json().catch(() => ({}));
    const why = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";

    const result = await askParcelReturn(order.trackingCode);
    if (!result.success) {
      // Log the refusal — otherwise "Ecotrack said no" and "nobody tried"
      // look identical on the timeline, which is exactly how the confirmed
      // orders went missing in August.
      await db.orderEvent.create({
        data: {
          orderId: order.id, kind: "system", actor: agentName,
          note: `فشل طلب الإرجاع من إيكوتراك — ${result.error || "سبب غير معروف"}`,
        },
      });
      return NextResponse.json({ error: result.error || "فشل طلب الإرجاع" }, { status: 502 });
    }

    await db.orderEvent.create({
      data: {
        orderId: order.id, kind: "system", actor: agentName,
        note: `طلبنا الإرجاع من إيكوتراك${why ? ` — ${why}` : ""}`,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("POST /api/agent/orders/[n]/parcel-return error:", error);
    return NextResponse.json({ error: "صار مشكل في طلب الإرجاع" }, { status: 500 });
  }
}
