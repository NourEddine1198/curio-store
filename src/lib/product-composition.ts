// How many actual GAMES sit inside each thing we sell.
//
// Shared deliberately: the finance engine uses it to cost printing and
// wrapping per game, and the agent console uses it to work out how many
// games an edit added — which is what her upsell bonus is paid on. If the
// two ever disagreed, she would be paid for work the profit never charged.
//
// Kept in code rather than a settings row: a mistyped JSON blob here would
// silently mis-cost every order, and product structure changes about once a
// year.

export type GameKind = "roubla" | "dlala" | "other";

export const COMPOSITION: Record<string, GameKind[]> = {
  "roubla": ["roubla"],
  "dlala": ["dlala"],
  "roubla-dlala-pack": ["roubla", "dlala"],
  "eid-2026-bundle": ["roubla", "other"],   // legacy: Roubla + Goul
  "goul-bla-matgoul": ["other"],
};

export const DEFAULT_COMPOSITION: GameKind[] = ["other"];

/** What one line of this product is made of. Unknown slugs count as one game. */
export function compositionOf(slug: string | null | undefined): GameKind[] {
  return COMPOSITION[slug || ""] || DEFAULT_COMPOSITION;
}

/** Total games across a set of order lines — a pack counts as two. */
export function countGames(
  items: { quantity: number; product?: { slug: string } | null; slug?: string }[]
): number {
  let n = 0;
  for (const it of items) {
    const slug = it.slug ?? it.product?.slug ?? "";
    n += compositionOf(slug).length * it.quantity;
  }
  return n;
}

// ─── What physically leaves the shelf ───────────────────────
// Separate from COMPOSITION above, which answers "how many GAMES is this"
// for costing. This one answers "which boxes do I physically pick", which
// is a different question with a different answer for bundles.
//
// The pack was set up as its own product with its own stock counter, as if
// it were a third kind of box. It is not — it is a Roubla and a Dlala in
// one delivery. Selling 73 packs therefore took 73 Roubla and 73 Dlala off
// the shelf while both counters sat untouched, and tracked 1,932 "packs"
// that do not exist.
export const PHYSICAL: Record<string, Record<string, number>> = {
  "roubla-dlala-pack": { roubla: 1, dlala: 1 },
  "eid-2026-bundle": { roubla: 1, "goul-bla-matgoul": 1 },   // legacy
};

/** Which real products one unit of this product takes off the shelf. */
export function physicalUnitsOf(slug: string | null | undefined): Record<string, number> {
  const s = slug || "";
  return PHYSICAL[s] || { [s]: 1 };
}

/** True for anything that is a wrapper around other products. */
export function isComposite(slug: string | null | undefined): boolean {
  return !!PHYSICAL[slug || ""];
}
