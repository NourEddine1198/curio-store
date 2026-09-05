import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countCapUses } from "@/lib/influencer-stats";

// PUBLIC, read-only: the checkout asks "is this code valid for this cart,
// and how much does it take off?" so the page can show the discount before
// submit. The orders API re-validates on submit — this endpoint only affects
// what the customer SEES, never what they pay.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Mirrors the legacy hardcoded coupons in /api/orders (kept in sync by hand —
// they are stable, printed-material codes).
//
// Anything in ACTIVE_COUPONS over there MUST be listed here too. The product
// pages ask this endpoint whether an offer is still alive before they show the
// discounted price; a code missing from this map answers "not valid", so the
// page quietly falls back to full price while the checkout would happily have
// honoured it. Expiry has to be mirrored for the same reason — otherwise the
// page keeps promising a price the server has already stopped accepting.
const LEGACY: Record<
  string,
  { discount: number; slugs: string[]; expiresAt?: Date }
> = {
  INSTAGRAM: { discount: 900, slugs: ["eid-2026-bundle"] },
  HADIA400: { discount: 400, slugs: ["roubla"] },
  // Event / stand codes behind the printed QR (see /api/orders).
  SALON400: {
    discount: 400,
    slugs: ["roubla"],
    expiresAt: new Date("2026-09-12T23:00:00Z"),
  },
  SALON450: {
    discount: 450,
    slugs: ["dlala"],
    expiresAt: new Date("2026-09-12T23:00:00Z"),
  },
};

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const raw = typeof body?.code === "string" ? body.code : "";
  const code = raw.trim().toUpperCase();
  const slugs: string[] = Array.isArray(body?.slugs)
    ? body.slugs.filter((s: unknown) => typeof s === "string")
    : [];

  if (!code || code.length > 30) {
    return NextResponse.json({ valid: false });
  }

  const legacy = LEGACY[code];
  if (legacy) {
    if (legacy.expiresAt && new Date() > legacy.expiresAt) {
      return NextResponse.json({ valid: false, reason: "expired" });
    }
    const ok = slugs.length === 0 || slugs.some((s) => legacy.slugs.includes(s));
    return NextResponse.json(
      ok
        ? { valid: true, discount: legacy.discount }
        : { valid: false, reason: "products" }
    );
  }

  const influencer = await db.influencer.findUnique({
    where: { couponCode: code },
    select: {
      active: true,
      customerDiscount: true,
      applicableSlugs: true,
      maxUses: true,
    },
  });
  if (!influencer || !influencer.active) {
    return NextResponse.json({ valid: false });
  }
  if (
    influencer.applicableSlugs.length > 0 &&
    slugs.length > 0 &&
    !slugs.some((s) => influencer.applicableSlugs.includes(s))
  ) {
    return NextResponse.json({ valid: false, reason: "products" });
  }
  // Capped codes: report exhaustion (reason "exhausted") so pages can show
  // a friendly "offer finished" instead of the discount; while alive, also
  // expose how many are left so pages can show real scarcity.
  if (influencer.maxUses > 0) {
    const used = await countCapUses(code);
    if (used >= influencer.maxUses) {
      return NextResponse.json({ valid: false, reason: "exhausted" });
    }
    return NextResponse.json({
      valid: true,
      discount: influencer.customerDiscount,
      remaining: influencer.maxUses - used,
    });
  }
  return NextResponse.json({
    valid: true,
    discount: influencer.customerDiscount,
  });
}
