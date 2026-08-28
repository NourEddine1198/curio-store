import crypto from "crypto";

/**
 * Meta Conversions API — server-side event reporting.
 *
 * Why this exists: until now Meta only learned about a sale from a script in
 * the customer's browser. That script is blocked constantly (iOS tracking
 * prevention, ad blockers, tabs closed too fast) and it can only tell Meta
 * what a browser knows. This sends the same event from the server, carrying
 * the identifiers we actually hold — the phone number the customer typed, the
 * name, the city — so Meta can match the sale to a real person.
 *
 * DEDUPLICATION IS THE WHOLE GAME. The checkout already fires the browser
 * Purchase with eventID "order-<n>". We send the identical event_id, so Meta
 * treats the two reports as one sale. Break that and every purchase is counted
 * twice, reported CPA halves overnight, and the numbers look wonderful while
 * being nonsense. If you change the id format here, change it in the checkout
 * too — roubla/index.html, dlala/index.html and assets/custom-code.js.
 *
 * NOTHING HERE MAY EVER FAIL A CHECKOUT. Every call is wrapped, time-limited
 * and swallowed, the same discipline as checkout-failures.ts. If Meta is down
 * or the token is wrong, the customer's order still goes through and they
 * never know anything happened.
 */

const DATASET_ID = "587121070888027";
const API_VERSION = "v21.0";
const TIMEOUT_MS = 2500;

/** Meta wants SHA-256 hex of a normalised value. Never send raw PII. */
function hash(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalised = value.trim().toLowerCase();
  if (!normalised) return undefined;
  return crypto.createHash("sha256").update(normalised).digest("hex");
}

/**
 * Algerian mobiles are stored as 0XXXXXXXXX. Meta matches on E.164 without
 * the plus, so 0555123456 has to become 213555123456 before hashing — hash
 * the local format and it will never match anything.
 */
function hashPhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return undefined;
  const e164 = digits.startsWith("0")
    ? "213" + digits.slice(1)
    : digits.startsWith("213")
      ? digits
      : "213" + digits;
  return hash(e164);
}

/**
 * Splits "شهد بولعيون" into first and last name. Meta hashes them separately
 * and a missing surname is fine — a wrong one is worse than none.
 */
function splitName(full: string | null | undefined): { fn?: string; ln?: string } {
  if (!full) return {};
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { fn: hash(parts[0]) };
  return { fn: hash(parts[0]), ln: hash(parts.slice(1).join(" ")) };
}

export interface CapiPurchaseInput {
  orderNumber: number;
  total: number;
  customerName?: string | null;
  customerPhone?: string | null;
  wilayaName?: string | null;
  commune?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  /** Unix seconds. Defaults to now; pass the order's createdAt when replaying. */
  eventTime?: number;
}

/**
 * Reports a purchase to Meta. Returns quietly whether it worked — callers must
 * not branch on it, and must never await it in a way that delays the customer.
 */
export async function sendPurchaseToMeta(
  input: CapiPurchaseInput
): Promise<{ sent: boolean; reason?: string }> {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { sent: false, reason: "no_token" };

  // Set META_CAPI_TEST_CODE to route events to the Test Events tab instead of
  // real reporting. Leave it UNSET in production — with it set, nothing counts.
  const testCode = process.env.META_CAPI_TEST_CODE;

  try {
    const { fn, ln } = splitName(input.customerName);

    // Only include keys we actually have. Sending empty strings lowers the
    // match quality score rather than leaving the field unknown.
    const userData: Record<string, unknown> = {};
    const ph = hashPhone(input.customerPhone);
    if (ph) userData.ph = [ph];
    if (fn) userData.fn = [fn];
    if (ln) userData.ln = [ln];
    const ct = hash(input.commune || input.wilayaName);
    if (ct) userData.ct = [ct];
    userData.country = [hash("dz")];
    if (input.ip) userData.client_ip_address = input.ip;
    if (input.userAgent) userData.client_user_agent = input.userAgent;
    if (input.fbc) userData.fbc = input.fbc;
    if (input.fbp) userData.fbp = input.fbp;

    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: "Purchase",
          event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
          // MUST match the checkout's eventID exactly — see the note at the top.
          event_id: `order-${input.orderNumber}`,
          action_source: "website",
          event_source_url: "https://curiodz.com/",
          user_data: userData,
          custom_data: {
            currency: "DZD",
            value: input.total,
            order_id: String(input.orderNumber),
          },
        },
      ],
    };
    if (testCode) payload.test_event_code = testCode;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://graph.facebook.com/${API_VERSION}/${DATASET_ID}/events?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // Log the reason, never the payload — it carries hashed PII.
        console.error(`[capi] order ${input.orderNumber} rejected ${res.status}: ${text.slice(0, 300)}`);
        return { sent: false, reason: `http_${res.status}` };
      }
      return { sent: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    console.error(`[capi] order ${input.orderNumber} failed: ${reason}`);
    return { sent: false, reason };
  }
}
