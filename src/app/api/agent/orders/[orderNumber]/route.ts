import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { repriceOrder } from "@/lib/order-pricing";

export const dynamic = "force-dynamic";

const PHONE_RE = /^0[567]\d{8}$/;
const DISPOSITIONS = ["confirmed", "no_answer", "postponed", "cancelled", "wrong_number", "duplicate"];

// Retry policy: up to 9 calls spread across ~3 days → ~8h between tries.
const MAX_CALLS = 9;
const RETRY_INTERVAL_MS = 8 * 60 * 60 * 1000;

async function loadOrder(num: number) {
  return db.order.findUnique({
    where: { orderNumber: num },
    include: {
      items: { include: { product: { select: { name: true, slug: true, nameEn: true } } } },
      assignedAgent: { select: { id: true, name: true } },
    },
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  const order = await loadOrder(num);
  if (!order) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
  return NextResponse.json({ order });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  try {
    const body = await request.json();
    const action = body?.action;
    const existing = await db.order.findUnique({
      where: { orderNumber: num },
      include: { items: { include: { product: { select: { slug: true } } } } },
    });
    if (!existing) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });

    const agentRow = await db.agent.findUnique({ where: { id: agent.id }, select: { name: true } });
    const agentName = agentRow?.name || "agent";

    // ---- EDIT: change customer / delivery / items, recompute money ----
    if (action === "edit") {
      const e = body.edit || {};
      const deliveryType: "HOME" | "OFFICE" = (e.deliveryType || existing.deliveryType) as "HOME" | "OFFICE";
      const wilayaCode: string = e.wilayaCode || existing.wilayaCode;

      // items: use provided, else current
      const items = Array.isArray(e.items) && e.items.length
        ? e.items.map((i: { slug: string; quantity: number }) => ({ slug: i.slug, quantity: i.quantity }))
        : existing.items.map((i) => ({ slug: i.product.slug, quantity: i.quantity }));

      if (e.customerPhone && !PHONE_RE.test(e.customerPhone)) {
        return NextResponse.json({ error: "رقم الهاتف غير صحيح" }, { status: 400 });
      }

      const priced = await repriceOrder({ items, wilayaCode, deliveryType });
      if (!priced.ok) return NextResponse.json({ error: priced.error }, { status: 400 });

      const orderData: Record<string, unknown> = {
        subtotal: priced.subtotal,
        deliveryPrice: priced.deliveryPrice,
        total: priced.total,
        wilayaCode,
        wilayaName: priced.wilayaName,
        deliveryType,
        assignedAgentId: existing.assignedAgentId || agent.id,
      };
      if (e.customerName != null) orderData.customerName = String(e.customerName).trim();
      if (e.customerPhone != null) orderData.customerPhone = String(e.customerPhone).trim();
      if (e.customerPhone2 != null) orderData.customerPhone2 = String(e.customerPhone2).trim() || null;
      if (e.notes != null) orderData.notes = String(e.notes);
      if (deliveryType === "HOME") {
        if (e.commune != null) orderData.commune = String(e.commune).trim();
        if (e.address != null) orderData.address = String(e.address).trim();
        orderData.officeCommune = null;
        orderData.officeName = null;
      } else {
        if (e.officeCommune != null) orderData.officeCommune = String(e.officeCommune).trim();
        if (e.officeName != null) orderData.officeName = String(e.officeName).trim() || null;
        orderData.address = null;
        orderData.commune = null;
      }

      // Replace items, then update the order. The Neon HTTP driver has no
      // transactions, so do it sequentially (edits are rare + admin-driven).
      await db.orderItem.deleteMany({ where: { orderId: existing.id } });
      for (const oi of priced.orderItems) {
        await db.orderItem.create({ data: { orderId: existing.id, productId: oi.productId, quantity: oi.quantity, unitPrice: oi.unitPrice } });
      }
      await db.order.update({ where: { id: existing.id }, data: orderData });

      return NextResponse.json({ success: true, order: await loadOrder(num) });
    }

    // ---- DISPOSITION: outcome of the call ----
    if (action === "disposition") {
      const disp = body.disposition;
      if (!DISPOSITIONS.includes(disp)) {
        return NextResponse.json({ error: "نتيجة غير معروفة" }, { status: 400 });
      }
      const now = new Date();
      const data: Record<string, unknown> = {
        disposition: disp,
        assignedAgentId: existing.assignedAgentId || agent.id,
      };

      if (disp === "confirmed") {
        data.status = "CONFIRMED";
        data.confirmedAt = now;
        data.confirmedBy = agentName;
      } else if (disp === "no_answer") {
        const attempts = (existing.callAttempts || 0) + 1;
        data.callAttempts = attempts;
        data.lastCallAt = now;
        if (attempts >= MAX_CALLS) {
          data.status = "CANCELLED";
          data.notes = ((existing.notes ? existing.notes + " | " : "") + `ملغى: ${MAX_CALLS} محاولات بلا رد`);
        } else {
          data.nextCallAt = new Date(now.getTime() + RETRY_INTERVAL_MS);
        }
      } else if (disp === "postponed") {
        data.lastCallAt = now;
        const days = Number(body.postponeDays) > 0 ? Math.min(7, Number(body.postponeDays)) : 1;
        data.nextCallAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      } else {
        // cancelled | wrong_number | duplicate → terminal
        data.status = "CANCELLED";
      }

      await db.order.update({ where: { id: existing.id }, data });
      return NextResponse.json({ success: true, order: await loadOrder(num) });
    }

    return NextResponse.json({ error: "action غير معروف" }, { status: 400 });
  } catch (error) {
    console.error("PATCH /api/agent/orders error:", error);
    return NextResponse.json({ error: "صار مشكل، عاود حاول" }, { status: 500 });
  }
}
