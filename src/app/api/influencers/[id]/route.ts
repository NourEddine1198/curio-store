import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  isAllowedLanding,
  normalizeSlug,
  slugProblem,
} from "@/lib/influencer-links";

// Edit / deactivate / delete one influencer. Admin-key gated.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;
const RESERVED_CODES = new Set(["INSTAGRAM", "HADIA400"]);
const BASES = new Set(["ORDER", "UNIT"]);
const TRIGGERS = new Set(["CONFIRMED", "PLACED"]);

function authorized(request: NextRequest): boolean {
  return !!ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// Same namespace guard as the create route: /i/<name> answers to a short link
// name OR a coupon code, so neither may collide with the other's.
async function linkNameTaken(slug: string, exceptId: string) {
  const clash = await db.influencer.findFirst({
    where: {
      OR: [{ linkSlug: slug }, { couponCode: slug.toUpperCase() }],
      NOT: { id: exceptId },
    },
    select: { id: true },
  });
  return !!clash;
}

function toNonNegativeInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const influencer = await db.influencer.findUnique({ where: { id } });
  if (!influencer)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  if (!body) return badRequest("invalid JSON");

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name.length < 2) return badRequest("الاسم مطلوب (حرفين على الأقل)");
    data.name = name;
  }
  for (const field of ["handle", "platform", "phone", "notes"] as const) {
    if (body[field] !== undefined) {
      data[field] =
        typeof body[field] === "string" ? body[field].trim() || null : null;
    }
  }
  if (body.active !== undefined) data.active = !!body.active;

  for (const field of [
    "customerDiscount",
    "commissionRate",
    "fixedFee",
    "maxUses",
  ] as const) {
    if (body[field] !== undefined) {
      const n = toNonNegativeInt(body[field]);
      if (n === null) return badRequest("المبالغ لازم تكون أرقام موجبة");
      data[field] = n;
    }
  }
  if (body.commissionBasis !== undefined) {
    if (!BASES.has(body.commissionBasis))
      return badRequest("commissionBasis غير صحيح");
    data.commissionBasis = body.commissionBasis;
  }
  if (body.countTrigger !== undefined) {
    if (!TRIGGERS.has(body.countTrigger))
      return badRequest("countTrigger غير صحيح");
    data.countTrigger = body.countTrigger;
  }
  if (body.applicableSlugs !== undefined) {
    data.applicableSlugs = Array.isArray(body.applicableSlugs)
      ? body.applicableSlugs.filter((s: unknown) => typeof s === "string" && s)
      : [];
  }

  if (body.landingPath !== undefined) {
    if (!isAllowedLanding(body.landingPath)) {
      return badRequest("وين يهبط الرابط: اختيار غير صحيح");
    }
    data.landingPath = body.landingPath;
  }

  // The short link name can change freely — unlike the code, it carries no
  // order history. The only cost is that links she already posted stop
  // working, which is her call to make with us, not a data problem.
  if (body.linkSlug !== undefined) {
    const slug = normalizeSlug(body.linkSlug);
    if (!slug) {
      data.linkSlug = null;
    } else if (slug !== (influencer.linkSlug ?? "")) {
      const problem = slugProblem(slug);
      if (problem) return badRequest(problem);
      if (await linkNameTaken(slug, id)) {
        return badRequest("هذا الرابط القصير مستعمل من قبل");
      }
      data.linkSlug = slug;
    }
  }

  // Changing the code is only allowed while no orders carry it —
  // otherwise history (and money owed) would silently detach.
  if (body.couponCode !== undefined) {
    const newCode = String(body.couponCode).trim().toUpperCase();
    if (newCode !== influencer.couponCode) {
      if (!CODE_RE.test(newCode))
        return badRequest("الكود: 3-20 حرف/رقم لاتيني (A-Z, 0-9, - أو _)");
      if (RESERVED_CODES.has(newCode))
        return badRequest("هذا الكود محجوز لنظام آخر");
      const ordersWithCode = await db.order.count({
        where: { couponCode: influencer.couponCode },
      });
      if (ordersWithCode > 0) {
        return badRequest(
          "ما نقدروش نبدلو الكود — عندو طلبات مسجلة. عطّل هذا المؤثر وزيد واحد جديد."
        );
      }
      const taken = await db.influencer.findUnique({
        where: { couponCode: newCode },
      });
      if (taken) return badRequest("هذا الكود مستعمل من قبل مؤثر آخر");
      if (await linkNameTaken(newCode.toLowerCase(), id)) {
        return badRequest("هذا الكود مستعمل كرابط قصير عند مؤثر آخر");
      }
      data.couponCode = newCode;
    }
  }

  const updated = await db.influencer.update({ where: { id }, data });
  return NextResponse.json({ influencer: updated });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!authorized(request))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const influencer = await db.influencer.findUnique({ where: { id } });
  if (!influencer)
    return NextResponse.json({ error: "not found" }, { status: 404 });

  // Never delete history: with attributed orders, deactivate instead.
  const ordersWithCode = await db.order.count({
    where: { couponCode: influencer.couponCode },
  });
  if (ordersWithCode > 0) {
    return badRequest(
      "عندو طلبات مسجلة — ما ينحذفش. عطّلو (active = off) باش يحبس الكود ويبقى التاريخ."
    );
  }

  await db.influencer.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
