import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteParcel, parcelIsStillOurs } from "@/lib/ecotrack";

// Boxes we hand to our own driver instead of the courier.
//
// GET  → orders you could give him, plus the ones already given
// POST → mark a batch as delivered by hand, each with its own fee
//
// This is the ONLY thing on /finance that changes an order, and it does so
// deliberately: without it a hand-delivered sale has no Ecotrack parcel, and
// the profit view — which reads revenue from parcels — counts it as zero
// revenue while the cash quietly arrives.
//
// It is recorded AFTER the fact, when the driver comes back with the money,
// because he pays same-day. There is no in-flight state to model.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;
const guard = (r: NextRequest) => !!ADMIN_KEY && r.headers.get("x-admin-key") === ADMIN_KEY;

/**
 * Only two states describe a box that is genuinely ready to go out with him:
 *
 *   SHIPPED  «مبعوث»      — confirmed, packed, parcel made, courier not here yet
 *   PENDING  «في الانتظار» — a new order still waiting to be worked
 *
 * Everything else was wrong to offer. EXPIRED is three days of nobody
 * answering, NO_ANSWER and CALLBACK are unconfirmed, and WAITLIST means the
 * stock does not exist — you cannot hand a driver a box you do not have.
 * Listing them padded the picker to 35 orders, most of which nobody would
 * ever give him.
 */
const GIVEABLE = ["SHIPPED", "PENDING"];

/** The two rules that decide what our own driver is allowed to carry. */
async function settings() {
  const [feeRow, wilayaRow] = await Promise.all([
    db.financeSetting.findUnique({ where: { key: "delivery.perDelivery" } }),
    db.financeSetting.findUnique({ where: { key: "delivery.wilayas" } }),
  ]);
  return {
    defaultFee: Number(feeRow?.value) || 350,
    // Algiers doorsteps. A setting rather than a hard-coded "16" so adding
    // Blida later is a typed number, not a deploy.
    wilayas: (wilayaRow?.value || "16").split(/[,\s]+/).map((w) => w.trim().padStart(2, "0")).filter(Boolean),
  };
}

export async function GET(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { defaultFee, wilayas } = await settings();

    const [candidates, withDriver, done] = await Promise.all([
      // Anything already at Ecotrack is excluded: giving the driver a box the
      // courier is also carrying is how a customer ends up with two.
      // Orders are auto-shipped to Ecotrack the moment they are confirmed, so
      // almost every candidate ALREADY has a parcel. Excluding those would
      // leave the picker permanently empty. Instead we offer the ones the
      // courier has not collected yet and cancel the parcel at handover.
      db.order.findMany({
        where: {
          status: { in: GIVEABLE as never[] },
          handDeliveredAt: null,
          handedToDriverAt: null,
          wilayaCode: { in: wilayas },
          deliveryType: "HOME",
        },
        take: 300,
        select: {
          orderNumber: true, customerName: true, customerPhone: true, status: true,
          wilayaCode: true, wilayaName: true, commune: true, officeCommune: true,
          total: true, createdAt: true, trackingCode: true,
          parcel: { select: { status: true, globalStatus: true } },
          items: { select: { quantity: true, product: { select: { slug: true, name: true } } } },
        },
      }),
      // What he is holding at this moment — the open run.
      db.order.findMany({
        where: { handedToDriverAt: { not: null }, handDeliveredAt: null },
        orderBy: { handedToDriverAt: "asc" },
        select: {
          orderNumber: true, customerName: true, customerPhone: true, status: true,
          wilayaName: true, commune: true, total: true,
          handedToDriverAt: true, driverAttempts: true,
          items: { select: { quantity: true, product: { select: { name: true } } } },
        },
      }),
      db.order.findMany({
        where: { handDeliveredAt: { not: null } },
        orderBy: { handDeliveredAt: "desc" },
        take: 100,
        select: {
          orderNumber: true, customerName: true, wilayaName: true,
          total: true, handDeliveryFee: true, handDeliveredAt: true,
        },
      }),
    ]);

    // A confirmed order is what you actually hand a driver. EXPIRED means
    // three days of nobody answering and WAITLIST means out of stock — still
    // listed, because you might revive one, but never at the top where they
    // would bury the orders that are genuinely ready to go.
    /** Packed and ready first; new orders after. */
const PRIORITY = ["SHIPPED", "PENDING"];
    const rank = (st: string) => {
      const i = PRIORITY.indexOf(st);
      return i === -1 ? PRIORITY.length : i;
    };
    candidates.sort((a, b) =>
      rank(a.status) - rank(b.status) || a.createdAt.getTime() - b.createdAt.getTime());

    // A parcel the courier already collected cannot be pulled back — hiding
    // those is what stops us cancelling a box that is physically on a van.
    const givable = candidates.filter((o) => !o.trackingCode || parcelIsStillOurs(o.parcel?.status));

    return NextResponse.json({
      defaultFee,
      candidates: givable.map((o) => ({
        ...o,
        createdAt: o.createdAt.toISOString(),
        atEcotrack: !!o.trackingCode,
        where: o.commune || o.officeCommune || o.wilayaName,
        what: o.items.map((i) => `${i.product?.name ?? "?"}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(" + "),
      })),
      withDriver: withDriver.map((o) => ({
        ...o,
        handedToDriverAt: o.handedToDriverAt!.toISOString(),
        where: o.commune || o.wilayaName,
        what: o.items.map((i) => `${i.product?.name ?? "?"}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(" + "),
      })),
      withDriverValue: withDriver.reduce((s, o) => s + o.total, 0),
      done: done.map((o) => ({ ...o, handDeliveredAt: o.handDeliveredAt!.toISOString() })),
      wilayas,
      owedSoFar: done.reduce((s, o) => s + (o.handDeliveryFee ?? 0), 0),
    });
  } catch (error) {
    console.error("GET /api/finance/hand-delivery error:", error);
    return NextResponse.json({ error: "Failed to load the orders" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    const dateRaw = String(body?.on || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      return NextResponse.json({ error: "Use a date like 2026-08-30" }, { status: 400 });
    }
    // Midday UTC keeps a typed calendar day on that day in Algiers (UTC+1).
    const when = new Date(`${dateRaw}T12:00:00.000Z`);
    if (action === "handover") return await handover(body, when);
    if (action === "settle") return await settle(body, when);
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    console.error("POST /api/finance/hand-delivery error:", error);
    return NextResponse.json({ error: "Failed to record it" }, { status: 500 });
  }
}

// ─── Evening 1 — he takes tomorrow's boxes ──────────────────
async function handover(body: Record<string, unknown>, when: Date) {
  const numbers: number[] = Array.isArray(body?.orderNumbers)
    ? (body.orderNumbers as unknown[]).map(Number).filter(Number.isFinite)
    : [];
  if (!numbers.length) return NextResponse.json({ error: "Pick at least one order" }, { status: 400 });

  const { wilayas } = await settings();
  const taken: number[] = [];
  const cancelled: number[] = [];
  const skipped: { orderNumber: number; why: string }[] = [];
  let value = 0;

  // One at a time: the Neon HTTP driver has no transactions, and a partial
  // batch that names exactly what it managed beats a silent half-write.
  for (const n of numbers) {
    const o = await db.order.findUnique({
      where: { orderNumber: n },
      select: {
        id: true, total: true, status: true, trackingCode: true,
        handedToDriverAt: true, handDeliveredAt: true, wilayaCode: true, deliveryType: true,
        parcel: { select: { id: true, status: true } },
      },
    });
    if (!o) { skipped.push({ orderNumber: n, why: "not found" }); continue; }
    if (o.handedToDriverAt) { skipped.push({ orderNumber: n, why: "already with him" }); continue; }
    if (o.handDeliveredAt) { skipped.push({ orderNumber: n, why: "already delivered" }); continue; }
    // Re-checked here and not only in the picker: a tab left open since before
    // an order changed could otherwise post something the rules exclude.
    if (!wilayas.includes(o.wilayaCode)) { skipped.push({ orderNumber: n, why: "outside his wilayas" }); continue; }
    if (o.deliveryType !== "HOME") { skipped.push({ orderNumber: n, why: "stop-desk order" }); continue; }

    // ── Take it off Ecotrack first ──
    // Orders auto-ship on confirmation, so a parcel usually already exists.
    // Handing our driver the box while the parcel still stands means the
    // courier turns up for something that is gone — or delivers a second one.
    // The cancel must SUCCEED before the order moves, or we would end up with
    // the worst of both: our books saying our driver has it, Ecotrack still
    // expecting to deliver it.
    if (o.trackingCode) {
      if (!parcelIsStillOurs(o.parcel?.status)) {
        skipped.push({ orderNumber: n, why: "the courier already collected this box" });
        continue;
      }
      const res = await deleteParcel(o.trackingCode);
      if (!res.success) {
        skipped.push({ orderNumber: n, why: `Ecotrack refused to cancel it — ${res.error || "unknown"}` });
        continue;
      }
      // NOT swallowed. A surviving parcel row would double-charge wrapping
      // (once through the parcel, once through the hand-delivery loop) and
      // keep counting a cancelled parcel as money in transit.
      if (o.parcel?.id) {
        try {
          await db.parcelTracking.delete({ where: { id: o.parcel.id } });
        } catch {
          skipped.push({ orderNumber: n, why: "cancelled at Ecotrack but our local parcel row would not clear — tell Claude" });
          continue;
        }
      }
      await db.orderEvent.create({
        data: {
          orderId: o.id, kind: "system", actor: "owner",
          note: `ألغينا الكولي من إيكوتراك (${o.trackingCode}) — راحت مع الليفرور ديالنا`,
        },
      });
      cancelled.push(n);
    }

    await db.order.update({
      where: { id: o.id },
      data: {
        status: "OUT_FOR_DELIVERY",
        handedToDriverAt: when,
        trackingCode: null,
        // Wrapping is charged when the box is packed, and it is packed now —
        // whether or not the customer ends up taking it.
        shippedAt: when,
      },
    });
    await db.orderEvent.create({
      data: {
        orderId: o.id, kind: "status", status: "OUT_FOR_DELIVERY", actor: "owner",
        note: "راحت مع الليفرور ديالنا",
      },
    });
    taken.push(n);
    value += o.total;
  }

  return NextResponse.json({
    success: true, action: "handover",
    taken: taken.length, orderNumbers: taken,
    cancelledAtEcotrack: cancelled.length, skipped, value,
  });
}

// ─── Evening 2 — he comes back with the money and the report ──
async function settle(body: Record<string, unknown>, when: Date) {
  const rows = Array.isArray(body?.outcomes)
    ? (body.outcomes as Record<string, unknown>[])
        .map((r) => ({ orderNumber: Number(r?.orderNumber), outcome: String(r?.outcome || ""), fee: Number(r?.fee) }))
        .filter((r) => Number.isFinite(r.orderNumber) && ["delivered", "retry", "refused"].includes(r.outcome))
    : [];
  if (!rows.length) return NextResponse.json({ error: "Say what happened to at least one box" }, { status: 400 });

  const done: number[] = [];
  const kept: number[] = [];
  const back: number[] = [];
  const skipped: { orderNumber: number; why: string }[] = [];
  let cashIn = 0;
  let feeTotal = 0;

  for (const r of rows) {
    const o = await db.order.findUnique({
      where: { orderNumber: r.orderNumber },
      select: { id: true, total: true, handedToDriverAt: true, handDeliveredAt: true, driverAttempts: true },
    });
    if (!o) { skipped.push({ orderNumber: r.orderNumber, why: "not found" }); continue; }
    if (!o.handedToDriverAt) { skipped.push({ orderNumber: r.orderNumber, why: "not with him" }); continue; }
    if (o.handDeliveredAt) { skipped.push({ orderNumber: r.orderNumber, why: "already settled" }); continue; }

    if (r.outcome === "delivered") {
      // He is paid only for boxes that actually arrived.
      const fee = Number.isFinite(r.fee) && r.fee >= 0 ? Math.round(r.fee) : 0;
      await db.order.update({
        where: { id: o.id },
        data: { status: "DELIVERED", deliveredAt: when, handDeliveredAt: when, handDeliveryFee: fee },
      });
      await db.orderEvent.create({
        data: {
          orderId: o.id, kind: "status", status: "DELIVERED", actor: "owner",
          note: `وصلت باليد — خلاص الليفرور ${fee} دج`,
        },
      });
      done.push(r.orderNumber);
      cashIn += o.total;
      feeTotal += fee;
    } else if (r.outcome === "retry") {
      // Nobody home: he keeps the box and tries tomorrow, so it stays out of
      // the building and out of every available list.
      await db.order.update({ where: { id: o.id }, data: { driverAttempts: o.driverAttempts + 1 } });
      await db.orderEvent.create({
        data: {
          orderId: o.id, kind: "attempt", actor: "owner",
          note: `ما كانش في الدار — الليفرور حافظ عليها و يعاود غدوة (محاولة ${o.driverAttempts + 1})`,
        },
      });
      kept.push(r.orderNumber);
    } else {
      // Refused: the box comes back to the shelf and stops being a sale.
      await db.order.update({
        where: { id: o.id },
        data: {
          status: "RETURNED", returnedAt: when, handedToDriverAt: null,
          driverAttempts: o.driverAttempts + 1, returnReason: "رفضها الزبون",
        },
      });
      await db.orderEvent.create({
        data: {
          orderId: o.id, kind: "status", status: "RETURNED", actor: "owner",
          note: "رفضها الزبون — رجعت معانا",
        },
      });
      back.push(r.orderNumber);
    }
  }

  return NextResponse.json({
    success: true, action: "settle",
    delivered: done.length, keptForTomorrow: kept.length, returned: back.length,
    cashIn, feeTotal, net: cashIn - feeTotal, skipped,
  });
}

// ─── Undo ───────────────────────────────────────────────────
// This does NOT recreate an Ecotrack parcel. If the box was pulled off the
// courier at handover, putting it back is a decision, not an automatic
// reversal — confirm the order again and the normal auto-ship makes a fresh
// parcel with a fresh tracking code.
export async function DELETE(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const n = Number(request.nextUrl.searchParams.get("orderNumber"));
  if (!Number.isFinite(n)) return NextResponse.json({ error: "orderNumber is required" }, { status: 400 });

  try {
    const o = await db.order.findUnique({
      where: { orderNumber: n },
      select: { id: true, handedToDriverAt: true, handDeliveredAt: true },
    });
    if (!o) return NextResponse.json({ error: "no such order" }, { status: 404 });
    if (!o.handedToDriverAt && !o.handDeliveredAt) {
      return NextResponse.json({ error: "that order never went with the driver" }, { status: 404 });
    }

    // Back to CONFIRMED, not PENDING: it had been through the call before
    // anyone handed it to a driver, and sending it to the top of the queue
    // would have Ikram ring the customer all over again.
    await db.order.update({
      where: { id: o.id },
      data: {
        status: "CONFIRMED",
        handedToDriverAt: null, handDeliveredAt: null, handDeliveryFee: null,
        deliveredAt: null, shippedAt: null, driverAttempts: 0,
      },
    });
    await db.orderEvent.create({
      data: {
        orderId: o.id, kind: "system", actor: "owner",
        note: "تراجعنا — ماشي توصيل باليد. إذا لازم كولي جديد، أكّد الطلب من جديد.",
      },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/finance/hand-delivery error:", error);
    return NextResponse.json({ error: "Failed to undo it" }, { status: 500 });
  }
}
