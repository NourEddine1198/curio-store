import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { POST_SHIP_ACTIVE } from "@/lib/order-status";
import { updateParcel } from "@/lib/ecotrack";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/agent/orders/[n]/parcel-edit — fix a parcel already at Ecotrack.
//
// Two things go wrong after shipping: the courier is set to collect the wrong
// amount, or the address/phone is wrong and the driver cannot find anyone.
// Both used to mean opening the Ecotrack dashboard by hand.
//
// Ecotrack's /update/order is a full re-statement, not a patch — every field
// is mandatory — so we always send the order's CURRENT values and overlay only
// what the agent changed.
//
// The amount is kept in step on BOTH sides. Editing the parcel without editing
// the order is how #605 ended up 1,100 DA out: Ecotrack collected 5,450 while
// our books said 6,550, and nothing flagged it.
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
    if (!order.trackingCode) {
      return NextResponse.json({ error: "هذا الطلب ما عندوش كولي في إيكوتراك" }, { status: 400 });
    }
    // Only a parcel still genuinely in flight may be rewritten. Checking just
    // DELIVERED/RETURNED left a hole: a CANCELLED / EXPIRED / DUPLICATE order
    // that still carries a stale tracking code would have let this route
    // rewrite its total, name, phone and address — fields the console locks
    // everywhere else once an order leaves the agent's hands.
    if (!(POST_SHIP_ACTIVE as readonly string[]).includes(order.status)) {
      return NextResponse.json({ error: "هذا الطلب ما عادش في الطريق — ما ينفعش تبدّلو" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const isOffice = order.deliveryType === "OFFICE";

    if (body?.montant !== undefined && !(Number.isFinite(Number(body.montant)) && Number(body.montant) > 0)) {
      return NextResponse.json({ error: "المبلغ غير صحيح" }, { status: 400 });
    }
    const montant = body?.montant !== undefined ? Math.round(Number(body.montant)) : order.total;
    const adresse = typeof body?.adresse === "string" && body.adresse.trim()
      ? body.adresse.trim()
      : (isOffice ? (order.officeName || order.officeCommune || "") : (order.address || ""));
    const tel = typeof body?.tel === "string" && body.tel.trim() ? body.tel.trim() : order.customerPhone;
    const client = typeof body?.client === "string" && body.client.trim() ? body.client.trim() : order.customerName;

    if (montant > 200000) {
      return NextResponse.json({ error: "المبلغ كبير بزاف — تأكدي منو" }, { status: 400 });
    }

    const agentRow = await db.agent.findUnique({ where: { id: agent.id }, select: { name: true } });
    const agentName = agentRow?.name || "agent";

    const result = await updateParcel({
      tracking: order.trackingCode,
      client,
      tel,
      tel2: order.customerPhone2,
      wilaya: parseInt(order.wilayaCode, 10),
      commune: isOffice ? (order.officeCommune || "") : (order.commune || order.wilayaName),
      adresse,
      montant,
      stopDesk: isOffice,
      produit: order.items.map((i) => i.product.name + (i.quantity > 1 ? ` x${i.quantity}` : "")).join(", "),
    });

    if (!result.success) {
      await db.orderEvent.create({
        data: {
          orderId: order.id, kind: "system", actor: agentName,
          note: `فشل تعديل الكولي في إيكوتراك — ${result.error || "سبب غير معروف"}`,
        },
      });
      return NextResponse.json({ error: result.error || "فشل تعديل الكولي" }, { status: 502 });
    }

    // Describe only what actually moved, so the timeline stays readable.
    const changes: string[] = [];
    if (montant !== order.total) changes.push(`المبلغ ${order.total} ← ${montant} دج`);
    if (client !== order.customerName) changes.push(`الاسم: ${client}`);
    if (tel !== order.customerPhone) changes.push(`الهاتف: ${tel}`);
    if (body?.adresse && adresse !== (isOffice ? order.officeName : order.address)) changes.push(`العنوان: ${adresse}`);

    // Log the courier-side change FIRST. Ecotrack has already been rewritten
    // and we cannot undo it; if the local update below fails, the timeline
    // must still show that the parcel diverged — otherwise this route
    // recreates the exact silent 1,100 DA gap it exists to prevent.
    await db.orderEvent.create({
      data: {
        orderId: order.id, kind: "system", actor: agentName,
        note: `تعدّل الكولي في إيكوتراك${changes.length ? ` — ${changes.join(" · ")}` : ""}`,
      },
    });

    // Keep OUR books equal to what the courier will collect.
    const data: Record<string, unknown> = {};
    if (montant !== order.total) data.total = montant;
    if (client !== order.customerName) data.customerName = client;
    if (tel !== order.customerPhone) data.customerPhone = tel;
    if (body?.adresse && !isOffice) data.address = adresse;
    if (Object.keys(data).length) await db.order.update({ where: { id: order.id }, data });

    // The cached parcel now understates the truth; force a re-read next open.
    const cached = await db.parcelTracking.findUnique({
      where: { trackingCode: order.trackingCode }, select: { id: true },
    });
    if (cached) await db.parcelTracking.update({ where: { id: cached.id }, data: { montant, syncedAt: new Date(0) } });

    return NextResponse.json({ success: true, montant, changes });
  } catch (error) {
    console.error("POST /api/agent/orders/[n]/parcel-edit error:", error);
    return NextResponse.json({ error: "صار مشكل في تعديل الكولي" }, { status: 500 });
  }
}
