import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyUpsellToken, UPSELL_PAIR } from "@/lib/upsell-token";

// ─────────────────────────────────────────────────────────────
// POST /api/orders/[orderNumber]/upsell
//
// The cross-sell after checkout. The order already exists — it is saved the
// moment the customer presses «أكّد الطلب» — so this only ever ADDS the paired
// game to it and re-prices, giving the customer the 800 DA pair discount.
//
// Deliberately narrow. It cannot set a price, cannot choose a product, cannot
// change a quantity, and cannot touch an order it wasn't given a token for.
// The only thing it can do is turn "one game" into "the pair", once.
// ─────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const BUNDLE_PAIR_OFF = 800; // must match the value in /api/orders
// ...and so must this: a campaign code replaces the pair discount rather than
// stacking with it, so the cross-sell prices the second game the same way the
// checkout does. Keep in step with CAMPAIGN_PAIR_OFF in /api/orders.
const CAMPAIGN_PAIR_OFF: Record<string, number> = { "DLALA-LAUNCH": 450 };

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return bad("رقم غير صحيح");

  try {
    const body = await request.json().catch(() => ({}));
    if (!verifyUpsellToken(String(body?.token || ""), num)) {
      return bad("انتهى الوقت — عيّطلنا ونكمّلو معاك", 403);
    }

    const order = await db.order.findUnique({
      where: { orderNumber: num },
      include: { items: { include: { product: { select: { id: true, slug: true, price: true } } } } },
    });
    if (!order) return bad("الطلب غير موجود", 404);

    // Only an order still waiting for its confirmation call can change. Once an
    // agent has worked it or it has gone to the courier, the phone call is the
    // place to add something, not this endpoint.
    if (order.status !== "PENDING") {
      return bad("الطلب راه تحت المعالجة — عيّطلنا باش نزيدوها", 409);
    }

    // What pairs with what is decided HERE, never by the caller.
    const current = order.items.map((i) => i.product.slug);
    const target = current.map((s) => UPSELL_PAIR[s]).find(Boolean);
    if (!target) return bad("ما كاينش عرض مزدوج لهاذ الطلب");
    if (current.includes(target)) {
      // Double-click, or a retry after a dropped response. Not an error —
      // just report where the order already stands.
      return NextResponse.json({ success: true, alreadyAdded: true, orderNumber: num, total: order.total });
    }

    const product = await db.product.findUnique({ where: { slug: target } });
    if (!product || !product.active) return bad("المنتج ما كاينش دركا");
    // If the pair game is sold out, adding it would drag the whole order onto
    // the waitlist and delay the game they already bought. Refuse instead.
    if (product.stock < 1) return bad("خلاص نسالو — نبقاو على الطلب الأول");

    // ── Re-price the whole order the same way /api/orders does ──
    const newItems = [...order.items.map((i) => ({ slug: i.product.slug, quantity: i.quantity, unitPrice: i.unitPrice })),
                      { slug: target, quantity: 1, unitPrice: product.price }];
    const subtotal = newItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    const qty = (slug: string) => newItems.reduce((n, i) => (i.slug === slug ? n + i.quantity : n), 0);
    const pairRate = (order.couponCode && CAMPAIGN_PAIR_OFF[order.couponCode] !== undefined)
      ? CAMPAIGN_PAIR_OFF[order.couponCode]
      : BUNDLE_PAIR_OFF;
    const bundleDiscount = Math.min(qty("roubla"), qty("dlala")) * pairRate;
    const total = subtotal - bundleDiscount - (order.couponDiscount || 0) + order.deliveryPrice;

    await db.orderItem.create({
      data: { orderId: order.id, productId: product.id, quantity: 1, unitPrice: product.price },
    });
    await db.product.update({ where: { id: product.id }, data: { stock: { decrement: 1 } } });

    const bundleNote = `باك روبلة+دلالة: -${bundleDiscount} دج`;
    await db.order.update({
      where: { id: order.id },
      data: {
        subtotal,
        total,
        notes: order.notes ? `${order.notes} | ${bundleNote}` : bundleNote,
      },
    });
    await db.orderEvent.create({
      data: {
        orderId: order.id, kind: "system", actor: "system",
        note: `الزبون زاد ${product.name} من العرض المزدوج — الإجمالي ${total} دج`,
      },
    });

    return NextResponse.json({ success: true, orderNumber: num, total, added: product.name });
  } catch (error) {
    console.error("POST /api/orders/[n]/upsell error:", error);
    return NextResponse.json({ error: "صار مشكل، عيّطلنا" }, { status: 500 });
  }
}
