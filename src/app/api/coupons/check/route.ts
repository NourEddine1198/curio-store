import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// PUBLIC, read-only: the checkout asks "is this code valid for this cart,
// and how much does it take off?" so the page can show the discount before
// submit. The orders API re-validates on submit — this endpoint only affects
// what the customer SEES, never what they pay.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// Mirrors the legacy hardcoded coupons in /api/orders (kept in sync by hand —
// they are stable, printed-material codes).
const LEGACY: Record<string, { discount: number; slugs: string[] }> = {
  INSTAGRAM: { discount: 900, slugs: ["eid-2026-bundle"] },
  HADIA400: { discount: 400, slugs: ["roubla"] },
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
    const ok = slugs.length === 0 || slugs.some((s) => legacy.slugs.includes(s));
    return NextResponse.json(
      ok
        ? { valid: true, discount: legacy.discount }
        : { valid: false, reason: "products" }
    );
  }

  const influencer = await db.influencer.findUnique({
    where: { couponCode: code },
    select: { active: true, customerDiscount: true, applicableSlugs: true },
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
  return NextResponse.json({
    valid: true,
    discount: influencer.customerDiscount,
  });
}
