// ─── Influencer selling links ───────────────────────────────
//
// An influencer has two different links and they are easy to mix up:
//
//   her SELLING link     curiodz.com/i/sara      → what she posts
//   her PRIVATE page     <api domain>/i/<token>  → where she watches her sales
//
// This file owns the selling one. The short link is a door: curiodz.com/i/<slug>
// asks the store where to send the visitor, then forwards them to the product
// page with her code already applied and the source tags attached. Keeping the
// destination in the database (instead of inside the link she posted) means we
// can move her link from Roubla to Dlala, or retire an offer, without asking
// her to edit a bio she may never edit.
//
// SECURITY: landingPath is stored as a PATH, never a full URL, and it is checked
// against the allowlist below on write and again on read. A redirect that takes
// an arbitrary destination from the database is an open redirect — one bad row
// (or one careless paste) would turn curiodz.com into a launchpad for phishing
// links that look like ours. Two checks, because the write path can change.

export const PUBLIC_SITE = "https://curiodz.com";

export const LANDING_OPTIONS = [
  { path: "/roubla/", label: "Roubla page" },
  { path: "/dlala/", label: "Dlala page" },
  { path: "/pack/", label: "The pair (Roubla + Dlala)" },
  { path: "/", label: "Homepage (all products)" },
] as const;

export const DEFAULT_LANDING = "/roubla/";

export function isAllowedLanding(path: unknown): path is string {
  return (
    typeof path === "string" &&
    LANDING_OPTIONS.some((o) => o.path === path)
  );
}

export function safeLanding(path: unknown): string {
  return isAllowedLanding(path) ? path : DEFAULT_LANDING;
}

// The short name in curiodz.com/i/<slug>. Lowercase latin letters, digits,
// dash and underscore only — anything an Algerian influencer has to dictate
// over the phone or a follower has to retype from a story must not contain
// case, spaces, or Arabic.
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;

export function normalizeSlug(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Reserved: /i/<cuid> is how the door recognises a PRIVATE page token and
// forwards it instead, so a selling slug must never look like one, and the
// obvious site words must stay free in case /i/ ever hosts something else.
const RESERVED_SLUGS = new Set([
  "admin", "api", "dlala", "roubla", "pack", "home", "gift", "vip",
  "salon", "origami", "index", "new", "edit", "login", "curio",
]);

export function slugProblem(slug: string): string | null {
  if (!SLUG_RE.test(slug)) {
    return "الرابط القصير: 2-30 حرف لاتيني صغير/رقم (a-z, 0-9, - أو _)";
  }
  if (RESERVED_SLUGS.has(slug)) return "هذا الاسم محجوز، اختار واحد آخر";
  return null;
}

// What she posts. Short and repointable.
export function sellingLink(slugOrCode: string): string {
  return PUBLIC_SITE + "/i/" + slugOrCode.toLowerCase();
}

// The address the door actually forwards to — also the "long link" we show in
// the portal as a fallback she can paste anywhere, and the one to use when a
// link must survive without JavaScript.
//
// The source tags mirror what the Meta ads already send (see
// assets/source-tracking.js on the site), so influencer orders land in the
// same reporting as everything else instead of looking like untagged traffic.
export function landingUrl(
  landingPath: string,
  couponCode: string | null
): string {
  const path = safeLanding(landingPath);
  const params = new URLSearchParams();
  if (couponCode) {
    params.set("code", couponCode);
    params.set("utm_source", "influencer");
    params.set("utm_medium", "influencer");
    params.set("utm_campaign", "inf-" + couponCode.toLowerCase());
  }
  const query = params.toString();
  return PUBLIC_SITE + path + (query ? "?" + query : "");
}
