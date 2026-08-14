import { db } from "@/lib/db";

// ─── The lost-order log ─────────────────────────────────────
// Records a checkout the customer could not complete. See the
// CheckoutFailure model in schema.prisma for why this exists.
//
// HARD RULE: this must never break or slow a checkout. Every call is
// wrapped — if the insert fails, we log to the console and move on. A
// broken failure-logger must not become a second outage.

export interface CheckoutFailureInput {
  reason: string;
  message: string;
  status?: number;
  silent?: boolean;
  page?: string | null;
  wilayaCode?: unknown;
  phone?: unknown;
  name?: unknown;
  slugs?: string[];
  ip?: string | null;
}

/** Trim to a safe length so a hostile payload can't bloat a row. */
function str(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * Turn the Referer header into a short page label ("/roubla/").
 * Falls back to null rather than storing a full URL with query strings,
 * which can carry coupon/launch codes we don't need here.
 */
export function pageFromReferer(referer: string | null): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).pathname.slice(0, 120) || "/";
  } catch {
    return null;
  }
}

export async function recordCheckoutFailure(input: CheckoutFailureInput): Promise<void> {
  try {
    await db.checkoutFailure.create({
      data: {
        reason: input.reason.slice(0, 60),
        message: input.message.slice(0, 500),
        status: input.status ?? 400,
        silent: input.silent ?? false,
        page: str(input.page, 120),
        wilayaCode: str(input.wilayaCode, 20),
        phone: str(input.phone, 30),
        name: str(input.name, 120),
        slugs: (input.slugs ?? []).filter((s) => typeof s === "string").slice(0, 10),
        ip: str(input.ip, 60),
      },
    });
  } catch (err) {
    console.error("[CheckoutFailure] could not record (checkout unaffected):", err);
  }
}

/**
 * Plain-English label for each reason code — used by the dashboard so the
 * owner reads "Wilaya refused" instead of "wilaya_unavailable".
 */
export const FAILURE_LABELS: Record<string, string> = {
  name_missing: "Name missing or too short",
  phone_invalid: "Phone number invalid",
  phone2_invalid: "Backup phone invalid",
  wilaya_missing: "No wilaya chosen",
  wilaya_unavailable: "Wilaya refused — not in our delivery list",
  wilaya_no_price: "Wilaya has no delivery price set",
  delivery_type_invalid: "Delivery type invalid",
  address_too_short: "Address missing or too short",
  commune_missing: "No commune chosen",
  office_missing: "No stop-desk chosen",
  items_empty: "Empty cart",
  items_too_many: "Too many different products",
  product_unavailable: "A product was inactive or unknown",
  product_unknown: "Product not found",
  out_of_stock: "Not enough stock",
  coupon_rejected: "Coupon rejected",
  rate_limit_ip: "Blocked — too many orders from one connection",
  rate_limit_phone: "Blocked — too many orders from one phone",
  server_error: "Server error — our fault",
  bot_honeypot: "Bot trap: hidden field filled",
  bot_speed_trap: "Bot trap: form submitted in under 3 seconds",
};
