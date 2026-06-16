import { normalizePhone, strictTerminalBucket, type EcotrackOrder } from "./ecotrack";

// ─────────────────────────────────────────────────────────────
// PURE matching logic for the delivery sync. No I/O, no DB — so it
// can be unit-tested with fixtures. Given a store order and the list
// of Ecotrack parcels (from Curio's OWN account), decide which parcel
// is this order's, and how confident we are.
//
// HYBRID (founder's choice):
//   Tier 1 — EXACT id: order.externalId === parcel.reference (immutable,
//            readonly in OrderDZ). Deterministic. Confidence = EXACT.
//   Tier 2 — PHONE + time fallback (independent of OrderDZ). Amount/product
//            are AGENT-EDITABLE in OrderDZ, so they are REPORT-ONLY hints,
//            never confidence inputs. ≥2 plausible candidates → AMBIGUOUS.
//
// Only EXACT / HIGH results are ever written; everything else is logged
// for manual review. We NEVER guess on a terminal (irreversible) write.
// ─────────────────────────────────────────────────────────────

export type MatchConfidence = "EXACT" | "HIGH" | "AMBIGUOUS" | "UNMATCHED";

export interface MatchInputOrder {
  orderNumber: number;
  externalId: string | null;
  customerPhone: string;
  customerPhone2: string | null;
  total: number;
  subtotal: number;
  deliveryPrice: number;
  createdAt: Date;
  productNames: string[];
}

export interface MatchResult {
  orderNumber: number;
  tier: 0 | 1 | 2 | null;
  confidence: MatchConfidence;
  parcel: EcotrackOrder | null;
  /** Strict terminal bucket of the matched parcel (null if not clearly terminal). */
  terminal: "delivered" | "returned" | null;
  reasons: string[];
}

const DAY = 86400000;
// A parcel is created when the order SHIPS — after confirmation/prep. Accept a
// small negative tolerance (clock skew) up to a generous positive delay.
const MIN_GAP_MS = -1 * DAY;
const MAX_GAP_MS = 14 * DAY;

export function matchOrderToParcel(
  order: MatchInputOrder,
  parcels: EcotrackOrder[]
): MatchResult {
  const reasons: string[] = [];

  // ── Tier 1 — EXACT id ────────────────────────────────────────
  const ext = (order.externalId || "").trim();
  if (ext) {
    const hits = parcels.filter((p) => (p.reference || "").trim() === ext);
    if (hits.length === 1) {
      const p = hits[0];
      return {
        orderNumber: order.orderNumber,
        tier: 1,
        confidence: "EXACT",
        parcel: p,
        terminal: strictTerminalBucket(p),
        reasons: [`tier1 exact: externalId===reference (${ext})`],
      };
    }
    if (hits.length > 1) {
      // Should never happen (reference is unique per parcel) — refuse rather than guess.
      reasons.push(`tier1 ambiguous: ${hits.length} parcels share reference=${ext}`);
      return { orderNumber: order.orderNumber, tier: 1, confidence: "AMBIGUOUS", parcel: null, terminal: null, reasons };
    }
    reasons.push(`tier1 miss: no parcel with reference=${ext}`);
  } else {
    reasons.push("tier1 skip: order has no externalId");
  }

  // ── Tier 2 — phone + time (independent fallback) ─────────────
  const orderPhones = new Set(
    [normalizePhone(order.customerPhone), normalizePhone(order.customerPhone2)].filter(Boolean)
  );
  const byPhone = parcels.filter(
    (p) => orderPhones.has(p.phone) || (p.phone2 && orderPhones.has(p.phone2))
  );

  if (byPhone.length === 0) {
    reasons.push("tier2 unmatched: no parcel shares the order's phone");
    return { orderNumber: order.orderNumber, tier: null, confidence: "UNMATCHED", parcel: null, terminal: null, reasons };
  }

  const oTime = order.createdAt.getTime();
  const inWindow = byPhone.filter((p) => {
    if (!p.createdAt) return false;
    const gap = new Date(p.createdAt).getTime() - oTime;
    return gap >= MIN_GAP_MS && gap <= MAX_GAP_MS;
  });

  // Report-only corroborators (NOT used to decide — agent-editable in OrderDZ).
  const amountMatch = (p: EcotrackOrder) =>
    [order.total, order.subtotal, order.total - order.deliveryPrice].some(
      (a) => Math.abs(a - p.montant) < 1
    );
  const productMatch = (p: EcotrackOrder) =>
    order.productNames.some((n) => n && p.produit && p.produit.toLowerCase().includes(n.toLowerCase()));

  if (inWindow.length === 1) {
    const p = inWindow[0];
    reasons.push(
      `tier2 high: 1 in-window phone candidate (amountHint=${amountMatch(p)}, productHint=${productMatch(p)})`
    );
    return {
      orderNumber: order.orderNumber,
      tier: 2,
      confidence: "HIGH",
      parcel: p,
      terminal: strictTerminalBucket(p),
      reasons,
    };
  }

  if (inWindow.length === 0) {
    reasons.push(`tier2 ambiguous: ${byPhone.length} phone candidate(s) but none in the time window`);
    return { orderNumber: order.orderNumber, tier: 2, confidence: "AMBIGUOUS", parcel: null, terminal: null, reasons };
  }

  // ≥2 candidates in the plausible window → phone+time cannot safely separate
  // them, and amount/product are too weak to break the tie. Refuse to guess.
  reasons.push(
    `tier2 ambiguous: ${inWindow.length} in-window candidates — phone+time cannot separate (amount/product are agent-editable)`
  );
  return { orderNumber: order.orderNumber, tier: 2, confidence: "AMBIGUOUS", parcel: null, terminal: null, reasons };
}
