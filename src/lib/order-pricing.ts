import { dbPg } from "@/lib/db-pg";

export interface Reprice {
  ok: boolean;
  error?: string;
  subtotal: number;
  deliveryPrice: number;
  total: number;
  wilayaName: string;
  orderItems: { productId: string; quantity: number; unitPrice: number }[];
}

// Recompute an order's money after an agent edits items / wilaya / delivery type.
// Prices come from the DB (server-authoritative). No coupons in the agent edit path.
export async function repriceOrder(input: {
  items: { slug: string; quantity: number }[];
  wilayaCode: string;
  deliveryType: "HOME" | "OFFICE";
}): Promise<Reprice> {
  const empty: Reprice = { ok: false, subtotal: 0, deliveryPrice: 0, total: 0, wilayaName: "", orderItems: [] };

  const items = (input.items || []).filter((i) => i && i.slug && Number(i.quantity) > 0);
  if (items.length === 0) return { ...empty, error: "لازم منتج واحد على الأقل" };

  const products = await dbPg.product.findMany({ where: { slug: { in: items.map((i) => i.slug) } } });
  const bySlug = new Map(products.map((p) => [p.slug, p]));

  let subtotal = 0;
  const orderItems: { productId: string; quantity: number; unitPrice: number }[] = [];
  for (const it of items) {
    const p = bySlug.get(it.slug);
    if (!p) return { ...empty, error: `منتج غير معروف: ${it.slug}` };
    const qty = Math.max(1, Math.floor(Number(it.quantity)));
    subtotal += p.price * qty;
    orderItems.push({ productId: p.id, quantity: qty, unitPrice: p.price });
  }

  const wilaya = await dbPg.wilaya.findUnique({ where: { code: input.wilayaCode } });
  if (!wilaya) return { ...empty, error: "الولاية غير موجودة" };
  const deliveryPrice = input.deliveryType === "OFFICE" ? wilaya.officePrice : wilaya.homePrice;

  return {
    ok: true,
    subtotal,
    deliveryPrice,
    total: subtotal + deliveryPrice,
    wilayaName: wilaya.name,
    orderItems,
  };
}
