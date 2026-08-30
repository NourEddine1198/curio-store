// ─────────────────────────────────────────────────────────────
// Moving the shelf.
//
// Every place that changes stock goes through here, because a bundle is not
// a box. The Roubla+Dlala pack has its own row in the products table, but
// selling one takes a Roubla AND a Dlala off the shelf — and until this
// existed, six different call sites each decremented the pack's own phantom
// counter instead.
//
// The Neon HTTP driver has no transactions, so moves are applied one at a
// time. A partial move is visible and fixable; a silent wrong one is not.
// ─────────────────────────────────────────────────────────────
import { db } from "@/lib/db";
import { physicalUnitsOf, isComposite } from "@/lib/product-composition";

export interface StockLine { slug: string; quantity: number }

/**
 * Turn order lines into the real boxes they represent.
 * Returns slug → number of physical units.
 */
export function physicalUnits(lines: StockLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) {
    const parts = physicalUnitsOf(l.slug);
    for (const [slug, per] of Object.entries(parts)) {
      out[slug] = (out[slug] || 0) + per * l.quantity;
    }
  }
  return out;
}

/**
 * Apply a stock move for a set of order lines.
 * `direction` "take" removes from the shelf, "restore" puts back.
 * A composite product's own counter is never touched — it does not exist.
 */
export async function moveStock(lines: StockLine[], direction: "take" | "restore"): Promise<void> {
  // A caller that forgot to select the `product` relation hands us lines with
  // no slug. Silently doing nothing is the worst possible outcome — stock
  // drifts forever and nothing ever says so. Shout instead.
  const blank = lines.filter((l) => !l.slug).reduce((s, l) => s + l.quantity, 0);
  if (blank > 0) {
    console.error(`[stock] ${blank} unit(s) had no product slug — the caller must select product.slug. NOT ${direction}n.`);
  }
  const units = physicalUnits(lines);
  const slugs = Object.keys(units).filter((s) => s && !isComposite(s));
  if (!slugs.length) return;
  const products = await db.product.findMany({ where: { slug: { in: slugs } }, select: { id: true, slug: true } });
  for (const p of products) {
    const qty = units[p.slug];
    if (!qty) continue;
    await db.product.update({
      where: { id: p.id },
      data: { stock: direction === "take" ? { decrement: qty } : { increment: qty } },
    });
  }
}

/** Order lines carrying a product relation, as most call sites already load them. */
export function linesFromItems(
  items: { quantity: number; product?: { slug: string } | null }[]
): StockLine[] {
  return items.map((i) => ({ slug: i.product?.slug || "", quantity: i.quantity }));
}

/**
 * How many of a product can actually be sold.
 * For a composite this is whichever component runs out first — never its
 * own stored number, which is meaningless.
 */
export async function availableUnits(slug: string): Promise<number> {
  const parts = physicalUnitsOf(slug);
  const slugs = Object.keys(parts);
  const products = await db.product.findMany({ where: { slug: { in: slugs } }, select: { slug: true, stock: true } });
  let min = Infinity;
  for (const s of slugs) {
    const stock = products.find((p) => p.slug === s)?.stock ?? 0;
    min = Math.min(min, Math.floor(stock / parts[s]));
  }
  return Number.isFinite(min) ? Math.max(0, min) : 0;
}

/**
 * How the shelf must move when an order's LINES change — a quantity edited,
 * a product swapped, a line added or removed.
 *
 * The slug-aware twin of itemStockDelta in order-status.ts, which worked in
 * product IDs and so could never see that a pack is two boxes. Swapping a
 * Roubla for a pack, for instance, is +1 Dlala and nothing else.
 *
 * An order in the restock family holds NOTHING, so an edit moves no stock.
 */
export async function applyLineChange(
  status: string,
  oldLines: StockLine[],
  newLines: StockLine[],
  holdsStock: (s: string) => boolean
): Promise<void> {
  if (!holdsStock(status)) return;
  const before = physicalUnits(oldLines);
  const after = physicalUnits(newLines);
  // Array.from, not a spread: this project compiles to a target where
  // iterating a Set needs --downlevelIteration.
  const slugs = Array.from(new Set(Object.keys(before).concat(Object.keys(after))));

  const takes: StockLine[] = [];
  const gives: StockLine[] = [];
  for (const slug of slugs) {
    if (!slug || isComposite(slug)) continue;
    const d = (after[slug] || 0) - (before[slug] || 0);
    if (d > 0) takes.push({ slug, quantity: d });
    else if (d < 0) gives.push({ slug, quantity: -d });
  }
  if (takes.length) await moveStock(takes, "take");
  if (gives.length) await moveStock(gives, "restore");
}
