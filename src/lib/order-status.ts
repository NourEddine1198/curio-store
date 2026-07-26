// ─────────────────────────────────────────────────────────────
// ORDER STATUS BRAIN — single source of truth for the workflow.
// Used by the agent console (UI + APIs), the admin API, the
// tracking sync, and the stats. OrderDZ-style: the status IS the
// workflow; everything the agent does moves an order between tabs.
// ─────────────────────────────────────────────────────────────

export const ALL_STATUSES = [
  "PENDING",
  "WAITLIST",
  "NO_ANSWER",
  "CALLBACK",
  "CONFIRMED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "AT_STOPDESK",
  "DELIVERY_FAILED",
  "DELIVERED",
  "IN_RETURN",
  "RETURNED",
  "CANCELLED",
  "EXPIRED",
  "WRONG",
  "DUPLICATE",
] as const;

export type StatusKey = (typeof ALL_STATUSES)[number];

// Statuses the AGENT can set from the console (pre-ship work).
// SHIPPED comes only from the ship endpoints; delivery-journey
// statuses come only from the Ecotrack tracking sync.
export const AGENT_SET_STATUSES: StatusKey[] = [
  "PENDING",
  "WAITLIST",
  "NO_ANSWER",
  "CALLBACK",
  "CONFIRMED",
  "CANCELLED",
  "WRONG",
  "DUPLICATE",
];

// Once a parcel exists at the courier, the agent can't move the
// status by hand — it flows from Ecotrack. She can still comment.
export const POST_SHIP_STATUSES: StatusKey[] = [
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "AT_STOPDESK",
  "DELIVERY_FAILED",
  "DELIVERED",
  "IN_RETURN",
  "RETURNED",
];

// Post-ship statuses that are still "alive" (tracking sync scans these).
export const POST_SHIP_ACTIVE: StatusKey[] = [
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "AT_STOPDESK",
  "DELIVERY_FAILED",
  "IN_RETURN",
];

// ── Stock rule ───────────────────────────────────────────────
// Stock is taken when the order is placed. These statuses mean
// "the unit is back on the shelf". Entering the family restores
// stock once; leaving it takes stock again. (RETURNED is NOT here:
// the physical unit comes back days later — owner adjusts stock
// in the admin when the parcel physically arrives.)
// WAITLIST is here on purpose: a waitlisted order is NOT holding a unit for
// anyone — we never had the stock. Parking an order releases its claim, and
// the moment the agent confirms it the unit is taken again. That makes
// "stock = what's physically on the shelf" true, and means confirming a
// waitlist order automatically draws one down without anyone remembering to.
export const RESTOCK_FAMILY: StatusKey[] = ["WAITLIST", "CANCELLED", "EXPIRED", "WRONG", "DUPLICATE"];

export function stockMove(oldStatus: string, newStatus: string): "restore" | "take" | null {
  const wasOut = RESTOCK_FAMILY.includes(oldStatus as StatusKey);
  const isOut = RESTOCK_FAMILY.includes(newStatus as StatusKey);
  if (!wasOut && isOut) return "restore";
  if (wasOut && !isOut) return "take";
  return null;
}

// ── No-answer / expiry policy (copied from OrderDZ) ──────────
export const MAX_CALL_ATTEMPTS = 9; // hard cap → EXPIRED
export const RETRY_INTERVAL_MS = 8 * 60 * 60 * 1000; // suggest next try in ~8h
export const EXPIRE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // 3 days silent → EXPIRED
export const PENDING_STALE_MS = 24 * 60 * 60 * 1000; // new order untouched 24h → attention

// ── Rank for the tracking sync's "never move backwards" guard ──
// (e.g. once DELIVERY_FAILED, an "en livraison" retry doesn't hide
// the failure — only a terminal outcome moves it on. Same as OrderDZ.)
export const SHIP_RANK: Record<string, number> = {
  SHIPPED: 1,
  OUT_FOR_DELIVERY: 2,
  AT_STOPDESK: 2,
  DELIVERY_FAILED: 3,
  IN_RETURN: 4,
  DELIVERED: 5,
  RETURNED: 5,
  CANCELLED: 5,
};

// ── Display (Arabic labels + tab colors, no emojis — Windows) ──
export const STATUS_META: Record<StatusKey, { ar: string; color: string; text?: string }> = {
  PENDING: { ar: "جديد", color: "#eab308" },
  WAITLIST: { ar: "مستني السلعة", color: "#0f766e" },
  NO_ANSWER: { ar: "ما جاوبش", color: "#f97316" },
  CALLBACK: { ar: "معاودة", color: "#8b5cf6" },
  CONFIRMED: { ar: "مأكد", color: "#22c55e" },
  PROCESSING: { ar: "قيد التحضير", color: "#16a34a" },
  SHIPPED: { ar: "مبعوث", color: "#3b82f6" },
  OUT_FOR_DELIVERY: { ar: "في التوزيع", color: "#0ea5e9" },
  AT_STOPDESK: { ar: "في المكتب", color: "#06b6d4" },
  DELIVERY_FAILED: { ar: "فشل التسليم", color: "#dc2626" },
  DELIVERED: { ar: "وصل", color: "#15803d" },
  IN_RETURN: { ar: "راجع في الطريق", color: "#a16207" },
  RETURNED: { ar: "رجع", color: "#78716c" },
  CANCELLED: { ar: "ملغى", color: "#6b7280" },
  EXPIRED: { ar: "منتهي", color: "#991b1b" },
  WRONG: { ar: "رقم غالط", color: "#64748b" },
  DUPLICATE: { ar: "مكرر", color: "#64748b" },
};

// Tab bar order for the agent board ("all" is added by the UI).
// PROCESSING is legacy — folded into the CONFIRMED tab, not shown.
export const TAB_ORDER: StatusKey[] = [
  "PENDING",
  "WAITLIST",
  "NO_ANSWER",
  "CALLBACK",
  "CONFIRMED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "AT_STOPDESK",
  "DELIVERY_FAILED",
  "DELIVERED",
  "IN_RETURN",
  "RETURNED",
  "CANCELLED",
  "EXPIRED",
  "WRONG",
  "DUPLICATE",
];

// Old disposition keys → new statuses (backward compatibility with
// the previous console + keeps existing stats fields flowing).
export const DISPOSITION_TO_STATUS: Record<string, StatusKey> = {
  confirmed: "CONFIRMED",
  no_answer: "NO_ANSWER",
  postponed: "CALLBACK",
  cancelled: "CANCELLED",
  wrong_number: "WRONG",
  duplicate: "DUPLICATE",
};

export const STATUS_TO_DISPOSITION: Partial<Record<StatusKey, string>> = {
  CONFIRMED: "confirmed",
  NO_ANSWER: "no_answer",
  CALLBACK: "postponed",
  CANCELLED: "cancelled",
  WRONG: "wrong_number",
  DUPLICATE: "duplicate",
};
