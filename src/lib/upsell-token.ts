import { createHmac, timingSafeEqual } from "crypto";

// ─── Upsell tokens ──────────────────────────────────────────
// POST /api/orders now saves the order the moment the customer presses
// «أكّد الطلب», BEFORE the cross-sell is offered — because a customer who
// closed the page at the upsell used to be lost entirely, name and phone
// included. The upsell therefore has to modify an order that already exists,
// and that needs a guard: without one, anyone could add items to any order
// number they felt like typing.
//
// The token is a short-lived HMAC over the order number. It is handed back
// only to the browser that just created the order, and it is the ONLY thing
// that lets /upsell touch it.
//
// The "upsell:" purpose prefix keeps these tokens from ever being mistaken
// for agent session tokens, which are signed with the same secret.

const TTL_MS = 30 * 60 * 1000; // half an hour — a checkout decision, not a session

function secret(): string {
  return process.env.AGENT_TOKEN_SECRET || process.env.ADMIN_KEY || "";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Token the create-order response hands to the browser. "" if unconfigured. */
export function signUpsellToken(orderNumber: number, nowMs = Date.now()): string {
  if (!secret()) return "";
  const exp = nowMs + TTL_MS;
  return `${exp}.${sign(`upsell:${orderNumber}:${exp}`)}`;
}

/** True only for a token this server issued, for THIS order, not yet expired. */
export function verifyUpsellToken(token: string | null, orderNumber: number, nowMs = Date.now()): boolean {
  if (!token || !secret()) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!isFinite(exp) || exp < nowMs) return false;
  const expected = sign(`upsell:${orderNumber}:${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The cross-sell is a fixed pairing, resolved on the SERVER. The browser never
// says what to add — it can only say "yes to the upsell" — so this endpoint
// cannot be talked into adding an arbitrary product or quantity.
export const UPSELL_PAIR: Record<string, string> = {
  roubla: "dlala",
  dlala: "roubla",
};
