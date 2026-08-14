import { db } from "@/lib/db";

export interface Reprice {
  ok: boolean;
  error?: string;
  subtotal: number;
  deliveryPrice: number;
  total: number;
  wilayaName: string;
  orderItems: { productId: string; quantity: number; unitPrice: number }[];
  /** What the order WOULD cost at catalog prices + the wilaya's normal fee. */
  catalogTotal: number;
  /** True when the agent typed a total that differs from subtotal + delivery. */
  totalOverridden: boolean;
}

/** Whole dinars only, and never negative. Returns null when not a usable number. */
function money(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < 0) return null;
  return n;
}

// Recompute an order's money after an agent edits items / wilaya / delivery type.
//
// Prices default to the catalog and the wilaya's fee, but the agent may override
// any of them on THIS order only — the catalog and the wilaya table are never
// touched. She negotiates on the phone ("I'll do free delivery", "2,000 for the
// pair"), so the order has to be able to carry a price the catalog doesn't know.
//
// Guard rails (agreed with the founder):
//   - a product's unit price must be at least 1 DA — a slipped digit must not
//     create a free order the courier collects nothing for
//   - delivery MAY be 0 — "free delivery" is a real closing offer
//   - a manually typed total is honoured, but the caller drops it whenever the
//     products or the wilaya change, because the agreed figure is then stale
export async function repriceOrder(input: {
  items: { slug: string; quantity: number; unitPrice?: unknown }[];
  wilayaCode: string;
  deliveryType: "HOME" | "OFFICE";
  /** Agent's delivery-fee override for this order. 0 is valid (free delivery). */
  deliveryPrice?: unknown;
  /** Agent's hand-typed final total for this order. */
  total?: unknown;
}): Promise<Reprice> {
  const empty: Reprice = {
    ok: false, subtotal: 0, deliveryPrice: 0, total: 0, wilayaName: "",
    orderItems: [], catalogTotal: 0, totalOverridden: false,
  };

  const items = (input.items || []).filter((i) => i && i.slug && Number(i.quantity) > 0);
  if (items.length === 0) return { ...empty, error: "لازم منتج واحد على الأقل" };

  const products = await db.product.findMany({ where: { slug: { in: items.map((i) => i.slug) } } });
  const bySlug = new Map(products.map((p) => [p.slug, p]));

  let subtotal = 0;
  let catalogSubtotal = 0;
  const orderItems: { productId: string; quantity: number; unitPrice: number }[] = [];
  for (const it of items) {
    const p = bySlug.get(it.slug);
    if (!p) return { ...empty, error: `منتج غير معروف: ${it.slug}` };
    const qty = Math.max(1, Math.floor(Number(it.quantity)));

    const override = money(it.unitPrice);
    if (it.unitPrice !== undefined && it.unitPrice !== null && it.unitPrice !== "" && override === null) {
      return { ...empty, error: `ثمن غير صحيح: ${p.name}` };
    }
    if (override !== null && override < 1) {
      return { ...empty, error: `ثمن ${p.name} لازم يكون 1 دج على الأقل` };
    }
    const unitPrice = override ?? p.price;

    subtotal += unitPrice * qty;
    catalogSubtotal += p.price * qty;
    orderItems.push({ productId: p.id, quantity: qty, unitPrice });
  }

  const wilaya = await db.wilaya.findUnique({ where: { code: input.wilayaCode } });
  if (!wilaya) return { ...empty, error: "الولاية غير موجودة" };
  const catalogDelivery = input.deliveryType === "OFFICE" ? wilaya.officePrice : wilaya.homePrice;

  const deliveryOverride = money(input.deliveryPrice);
  if (
    input.deliveryPrice !== undefined && input.deliveryPrice !== null &&
    input.deliveryPrice !== "" && deliveryOverride === null
  ) {
    return { ...empty, error: "ثمن التوصيل غير صحيح" };
  }
  const deliveryPrice = deliveryOverride ?? catalogDelivery;

  const computed = subtotal + deliveryPrice;
  const totalOverride = money(input.total);
  if (input.total !== undefined && input.total !== null && input.total !== "" && totalOverride === null) {
    return { ...empty, error: "الإجمالي غير صحيح" };
  }
  const total = totalOverride ?? computed;

  return {
    ok: true,
    subtotal,
    deliveryPrice,
    total,
    wilayaName: wilaya.name,
    orderItems,
    catalogTotal: catalogSubtotal + catalogDelivery,
    totalOverridden: total !== computed,
  };
}
