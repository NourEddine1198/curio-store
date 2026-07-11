import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { repriceOrder } from "@/lib/order-pricing";
import {
  AGENT_SET_STATUSES,
  POST_SHIP_STATUSES,
  DISPOSITION_TO_STATUS,
  STATUS_TO_DISPOSITION,
  MAX_CALL_ATTEMPTS,
  RETRY_INTERVAL_MS,
  stockMove,
  type StatusKey,
} from "@/lib/order-status";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const PHONE_RE = /^0[567]\d{8}$/;

async function loadOrder(num: number) {
  return db.order.findUnique({
    where: { orderNumber: num },
    omit: { ip: true, webhookPayload: true, externalId: true },
    include: {
      items: { include: { product: { select: { name: true, slug: true, nameEn: true } } } },
      assignedAgent: { select: { id: true, name: true } },
      events: { orderBy: { createdAt: "desc" }, take: 120 },
    },
  });
}

// GET — full order + timeline + this customer's other orders
export async function GET(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  const order = await loadOrder(num);
  if (!order) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });

  const prevOrders = await db.order.findMany({
    where: { customerPhone: order.customerPhone, orderNumber: { not: num } },
    select: { orderNumber: true, status: true, total: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  // The live cancellation-reasons list (owner-editable SiteSetting)
  let cancelReasons: string[] = [];
  try {
    const row = await db.siteSetting.findUnique({ where: { key: "cancelReasons" } });
    if (row?.value) cancelReasons = JSON.parse(row.value);
  } catch { /* keep empty */ }

  return NextResponse.json({ order, prevOrders, cancelReasons });
}

// The one place a status change happens — validations + side effects.
async function applyStatus(opts: {
  existing: { id: string; status: string; callAttempts: number | null; confirmedAt: Date | null; notes: string | null; items: { productId: string; quantity: number }[] };
  requested: StatusKey;
  agentName: string;
  agentId: string;
  reason?: string;          // cancel reason text
  callbackAt?: string;      // ISO datetime for CALLBACK
  callbackNote?: string;
  attemptNote?: string;     // optional note on a no-answer attempt
}) {
  const { existing, requested, agentName } = opts;

  if (!AGENT_SET_STATUSES.includes(requested)) {
    return { error: "حالة غير مسموحة من الكونسول", code: 400 as const };
  }
  if (POST_SHIP_STATUSES.includes(existing.status as StatusKey)) {
    return { error: "الطلب راه عند الموصّل — الحالة تتبدل وحدها من إيكوتراك. تقدري تزيدي تعليق برك.", code: 409 as const };
  }

  const now = new Date();
  let finalStatus: StatusKey = requested;
  const data: Record<string, unknown> = { assignedAgentId: undefined };
  const events: { kind: string; status?: string; note?: string }[] = [];

  if (requested === "NO_ANSWER") {
    const attempts = (existing.callAttempts || 0) + 1;
    data.callAttempts = attempts;
    data.lastCallAt = now;
    events.push({ kind: "attempt", note: opts.attemptNote || `محاولة رقم ${attempts} — ما جاوبش` });
    if (attempts >= MAX_CALL_ATTEMPTS) {
      finalStatus = "EXPIRED";
      data.nextCallAt = null;
      events.push({ kind: "system", status: "EXPIRED", note: `وصلنا ${MAX_CALL_ATTEMPTS} محاولات بلا رد — انتهى` });
    } else {
      data.nextCallAt = new Date(now.getTime() + RETRY_INTERVAL_MS);
    }
  } else if (requested === "CALLBACK") {
    const at = opts.callbackAt ? new Date(opts.callbackAt) : null;
    if (!at || isNaN(at.getTime())) return { error: "لازم تختاري وقتاش نعاودو نتصلو", code: 400 as const };
    data.nextCallAt = at;
    data.callbackNote = (opts.callbackNote || "").trim() || null;
    data.lastCallAt = now;
    const when = at.toLocaleString("fr-DZ", { dateStyle: "short", timeStyle: "short" });
    events.push({ kind: "status", status: "CALLBACK", note: `معاودة: ${when}${opts.callbackNote ? " — " + opts.callbackNote : ""}` });
  } else if (requested === "CONFIRMED") {
    data.confirmedAt = existing.confirmedAt || now;
    data.confirmedBy = agentName;
    data.nextCallAt = null;
  } else if (requested === "CANCELLED") {
    data.cancelReason = (opts.reason || "").trim() || null;
    data.nextCallAt = null;
    events.push({ kind: "status", status: "CANCELLED", note: opts.reason ? `السبب: ${opts.reason}` : undefined });
  } else if (requested === "WRONG" || requested === "DUPLICATE") {
    data.nextCallAt = null;
  } else if (requested === "PENDING") {
    data.nextCallAt = null; // recover back into the fresh queue
  }

  const statusChanged = finalStatus !== existing.status;
  if (statusChanged) {
    data.status = finalStatus;
    const disp = STATUS_TO_DISPOSITION[finalStatus];
    data.disposition = finalStatus === "PENDING" ? null : disp || undefined;
    // status event (unless a more specific one was already queued)
    if (!events.some((e) => e.kind === "status" || e.kind === "system")) {
      events.push({ kind: "status", status: finalStatus });
    }
  } else if (requested === "NO_ANSWER") {
    data.disposition = "no_answer"; // repeated attempt on an already-NO_ANSWER order
  }

  // Stock: entering the cancelled family puts the unit back on the shelf;
  // recovering out of it takes the unit again. (Same rule as the admin.)
  const move = stockMove(existing.status, finalStatus);

  await db.order.update({ where: { id: existing.id }, data });
  if (move) {
    for (const it of existing.items) {
      await db.product.update({
        where: { id: it.productId },
        data: { stock: move === "restore" ? { increment: it.quantity } : { decrement: it.quantity } },
      });
    }
  }
  for (const e of events) {
    await db.orderEvent.create({ data: { orderId: existing.id, kind: e.kind, status: e.status, note: e.note, actor: agentName } });
  }
  return { ok: true as const, finalStatus };
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

    // ---- COMMENT: add a note to the timeline (always allowed) ----
    if (action === "comment") {
      const text = String(body.text || "").trim().slice(0, 2000);
      if (!text) return NextResponse.json({ error: "التعليق فارغ" }, { status: 400 });
      await db.orderEvent.create({ data: { orderId: existing.id, kind: "comment", note: text, actor: agentName } });
      return NextResponse.json({ success: true, order: await loadOrder(num) });
    }

    // ---- STATUS: the workflow move (with side effects) ----
    if (action === "status") {
      const requested = String(body.status || "").toUpperCase() as StatusKey;
      const res = await applyStatus({
        existing, requested, agentName, agentId: agent.id,
        reason: body.reason, callbackAt: body.callbackAt, callbackNote: body.callbackNote, attemptNote: body.attemptNote,
      });
      if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.code });
      // make sure the order is owned by someone
      if (!existing.assignedAgentId) {
        await db.order.update({ where: { id: existing.id }, data: { assignedAgentId: agent.id } });
      }
      return NextResponse.json({ success: true, order: await loadOrder(num) });
    }

    // ---- DISPOSITION (legacy console compatibility) ----
    if (action === "disposition") {
      const disp = String(body.disposition || "");
      const mapped = DISPOSITION_TO_STATUS[disp];
      if (!mapped) return NextResponse.json({ error: "نتيجة غير معروفة" }, { status: 400 });
      const days = Number(body.postponeDays) > 0 ? Math.min(7, Number(body.postponeDays)) : 1;
      const res = await applyStatus({
        existing, requested: mapped, agentName, agentId: agent.id,
        callbackAt: mapped === "CALLBACK" ? new Date(Date.now() + days * 86400000).toISOString() : undefined,
      });
      if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.code });
      if (!existing.assignedAgentId) {
        await db.order.update({ where: { id: existing.id }, data: { assignedAgentId: agent.id } });
      }
      return NextResponse.json({ success: true, order: await loadOrder(num) });
    }

    // ---- EDIT: change customer / delivery / items, recompute money ----
    if (action === "edit") {
      const e = body.edit || {};
      const deliveryType: "HOME" | "OFFICE" = (e.deliveryType || existing.deliveryType) as "HOME" | "OFFICE";
      const wilayaCode: string = e.wilayaCode || existing.wilayaCode;

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
      // transactions, so do it sequentially (edits are rare + agent-driven).
      await db.orderItem.deleteMany({ where: { orderId: existing.id } });
      for (const oi of priced.orderItems) {
        await db.orderItem.create({ data: { orderId: existing.id, productId: oi.productId, quantity: oi.quantity, unitPrice: oi.unitPrice } });
      }
      await db.order.update({ where: { id: existing.id }, data: orderData });

      const moneyChanged = priced.total !== existing.total;
      await db.orderEvent.create({
        data: {
          orderId: existing.id, kind: "system", actor: agentName,
          note: moneyChanged
            ? `عدّلت الطلب — الإجمالي ولّى ${priced.total} دج (كان ${existing.total})`
            : "عدّلت بيانات الطلب",
        },
      });

      return NextResponse.json({ success: true, order: await loadOrder(num) });
    }

    return NextResponse.json({ error: "action غير معروف" }, { status: 400 });
  } catch (error) {
    console.error("PATCH /api/agent/orders error:", error);
    return NextResponse.json({ error: "صار مشكل، عاود حاول" }, { status: 500 });
  }
}
