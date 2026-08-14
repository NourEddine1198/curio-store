import { db } from "@/lib/db";
import { sendTelegram, telegramConfigured } from "@/lib/telegram";

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
    await maybeAlert(input.reason);
  } catch (err) {
    console.error("[CheckoutFailure] could not record (checkout unaffected):", err);
  }
}

// ─── Telegram alerting ──────────────────────────────────────
// Thresholds are tuned to Curio's REAL volume, and that detail is the whole
// design. During the wilaya outage the store took ~9 orders a day, so the 9
// dead wilayas produced only ~1.4 refusals a day — an "N per hour" rule would
// have stayed silent for the entire five weeks. These windows are 24h so a
// slow bleed still trips the alarm within a day or two.
//
// Only reasons that are OUR fault alert. A customer mistyping a phone number
// is not news; the site refusing a wilaya it should accept is.
const ALERT_RULES: Record<string, { threshold: number; cooldownHours: number }> = {
  // A crash should never happen — tell him on the first one.
  server_error: { threshold: 1, cooldownHours: 3 },
  wilaya_unavailable: { threshold: 2, cooldownHours: 12 },
  wilaya_no_price: { threshold: 2, cooldownHours: 12 },
  product_unavailable: { threshold: 2, cooldownHours: 12 },
  product_unknown: { threshold: 2, cooldownHours: 12 },
  out_of_stock: { threshold: 3, cooldownHours: 12 },
  coupon_rejected: { threshold: 3, cooldownHours: 12 },
};

const COOLDOWN_PREFIX = "alert:checkout:";

/**
 * Decide whether this failure is worth waking the founder for, and send it.
 *
 * Cheap by default: a non-alertable reason (a typo) returns before touching
 * the database again, so the common case costs nothing. The Telegram call
 * only runs when a threshold is actually crossed — at most once per reason
 * per cooldown window.
 *
 * Swallows everything: an alert failure must never surface to the customer.
 */
async function maybeAlert(reason: string): Promise<void> {
  const rule = ALERT_RULES[reason];
  if (!rule || !telegramConfigured()) return;

  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await db.checkoutFailure.findMany({
      where: { reason, silent: false, createdAt: { gte: since } },
      select: { wilayaCode: true, page: true, name: true, phone: true, message: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    if (recent.length < rule.threshold) return;

    // Cooldown, so one broken thing can't send fifty messages. Read-then-write
    // rather than upsert: the Neon HTTP driver opens a transaction for upsert,
    // which this serverless setup does not support.
    const key = COOLDOWN_PREFIX + reason;
    const existing = await db.siteSetting.findUnique({ where: { key } });
    const lastAt = existing?.value ? new Date(existing.value).getTime() : 0;
    if (Date.now() - lastAt < rule.cooldownHours * 3600 * 1000) return;

    const now = new Date().toISOString();
    if (existing) await db.siteSetting.update({ where: { key }, data: { value: now } });
    else await db.siteSetting.create({ data: { key, value: now } });

    const sent = await sendTelegram(buildAlert(reason, recent));
    if (!sent) {
      // Roll the stamp back so the next failure retries instead of the alert
      // being silently swallowed for 12 hours.
      if (existing) await db.siteSetting.update({ where: { key }, data: { value: existing.value } });
      else await db.siteSetting.delete({ where: { key } }).catch(() => {});
    }
  } catch (err) {
    console.error("[CheckoutFailure] alert check failed (checkout unaffected):", err);
  }
}

interface RecentFailure {
  wilayaCode: string | null; page: string | null; name: string | null;
  phone: string | null; message: string; createdAt: Date;
}

/**
 * Render the alert for the most recent alertable reason, without sending it.
 * Powers /api/alerts/test?preview=1 so the exact wording can be checked
 * against real data instead of guessed at — or triggered for real.
 */
export async function previewLatestAlert(): Promise<{ reason: string; text: string } | null> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const recent = await db.checkoutFailure.findMany({
    where: { silent: false, reason: { in: Object.keys(ALERT_RULES) }, createdAt: { gte: since } },
    select: { reason: true, wilayaCode: true, page: true, name: true, phone: true, message: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  if (!recent.length) return null;
  const reason = recent[0].reason;
  const sameReason = recent.filter((r) => r.reason === reason);
  return { reason, text: buildAlert(reason, sameReason) };
}

function buildAlert(reason: string, recent: RecentFailure[]): string {
  const uniq = (xs: (string | null)[]) =>
    Array.from(new Set(xs.filter((x): x is string => Boolean(x)))).slice(0, 8);

  const wilayas = uniq(recent.map((r) => r.wilayaCode));
  const pages = uniq(recent.map((r) => r.page));
  const latest = recent[0];
  // NOT NEXT_PUBLIC_SITE_URL — that points at the marketing site (curiodz.com),
  // which has no /dashboard and would send him to a 404. The Command Center is
  // served by THIS app, so use Netlify's own URL, falling back to the store's
  // known origin.
  const base = process.env.DASHBOARD_URL || process.env.URL || "https://stirring-marigold-3dd8e9.netlify.app";

  const lines = [
    "🚨 Curio — customers cannot check out",
    "",
    `${recent.length} in the last 24h hit:`,
    `"${FAILURE_LABELS[reason] || reason}"`,
    "",
    `What they saw: ${latest.message.slice(0, 160)}`,
  ];
  if (wilayas.length) lines.push(`Wilayas: ${wilayas.join(", ")}`);
  if (pages.length) lines.push(`Pages: ${pages.join(", ")}`);
  if (latest.phone) lines.push(`Latest: ${latest.name || "—"} ${latest.phone}`);
  lines.push("");
  lines.push("This is our side, not theirs. Their numbers are in the Command Center:");
  lines.push(base ? `${base.replace(/\/$/, "")}/dashboard` : "/dashboard");
  return lines.join("\n");
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
