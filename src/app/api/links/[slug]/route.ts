import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { countCapUses } from "@/lib/influencer-stats";
import {
  PUBLIC_SITE,
  landingUrl,
  normalizeSlug,
  safeLanding,
} from "@/lib/influencer-links";

// PUBLIC, read-only. The door at curiodz.com/i/<slug> asks this endpoint
// "where does this link go?" and forwards the visitor there.
//
// It answers with a ready URL rather than raw fields on purpose: the rule for
// building an influencer link (which tags, which order, which discount) then
// lives in ONE file (lib/influencer-links.ts) instead of being re-implemented
// inside a static page on the other repo, where it would quietly drift.
//
// A link must never be a dead end. Unknown slug, paused code, offer used up —
// every one of those still returns a URL, just without the coupon. Someone who
// tapped an influencer's story deserves to land on the product, not on an
// error; a full-price visitor is worth more than a bounce.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug: raw } = await params;
  const slug = normalizeSlug(raw);

  if (!slug || slug.length > 40) {
    return NextResponse.json({ ok: false, url: PUBLIC_SITE + "/" });
  }

  // The slug is either the short link name she was given, or — when nobody
  // set one — the coupon code itself, so a brand new influencer has a working
  // link the second she is created.
  const influencer = await db.influencer.findFirst({
    where: {
      OR: [{ linkSlug: slug }, { couponCode: slug.toUpperCase() }],
    },
    select: {
      couponCode: true,
      landingPath: true,
      active: true,
      maxUses: true,
    },
  });

  if (!influencer) {
    return NextResponse.json({
      ok: false,
      reason: "unknown",
      url: PUBLIC_SITE + "/",
    });
  }

  const path = safeLanding(influencer.landingPath);

  if (!influencer.active) {
    return NextResponse.json({
      ok: true,
      reason: "paused",
      url: landingUrl(path, null),
    });
  }

  if (influencer.maxUses > 0) {
    const used = await countCapUses(influencer.couponCode);
    if (used >= influencer.maxUses) {
      return NextResponse.json({
        ok: true,
        reason: "exhausted",
        url: landingUrl(path, null),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    code: influencer.couponCode,
    url: landingUrl(path, influencer.couponCode),
  });
}
