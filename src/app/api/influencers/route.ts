import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeStats, fetchOrdersForCodes } from "@/lib/influencer-stats";

// Admin-only influencer management: list with live stats, create new.
// Same auth as the Command Center: x-admin-key header vs ADMIN_KEY env.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;
// Legacy codes still hardcoded in the orders route — an influencer can't claim them.
const RESERVED_CODES = new Set(["INSTAGRAM", "HADIA400"]);
const BASES = new Set(["ORDER", "UNIT"]);
const TRIGGERS = new Set(["CONFIRMED", "PLACED"]);

function authorized(request: NextRequest): boolean {
  return !!ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY;
}

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function toNonNegativeInt(value: unknown, fallback = 0): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return unauthorized();

  const influencers = await db.influencer.findMany({
    orderBy: { createdAt: "asc" },
    include: { payments: { orderBy: { paidAt: "desc" } } },
  });
  const ordersByCode = await fetchOrdersForCodes(
    influencers.map((i) => i.couponCode)
  );

  const rows = influencers.map((inf) => {
    const paidTotal = inf.payments.reduce((n, p) => n + p.amount, 0);
    const stats = computeStats(
      ordersByCode.get(inf.couponCode) ?? [],
      inf,
      paidTotal
    );
    return { ...inf, stats };
  });

  return NextResponse.json({ influencers: rows });
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return unauthorized();

  const body = await request.json().catch(() => null);
  if (!body) return badRequest("invalid JSON");

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 2) return badRequest("الاسم مطلوب (حرفين على الأقل)");

  const rawCode = typeof body.couponCode === "string" ? body.couponCode : "";
  const couponCode = rawCode.trim().toUpperCase();
  if (!CODE_RE.test(couponCode)) {
    return badRequest("الكود: 3-20 حرف/رقم لاتيني (A-Z, 0-9, - أو _)");
  }
  if (RESERVED_CODES.has(couponCode)) {
    return badRequest("هذا الكود محجوز لنظام آخر");
  }

  const customerDiscount = toNonNegativeInt(body.customerDiscount);
  const commissionRate = toNonNegativeInt(body.commissionRate);
  const fixedFee = toNonNegativeInt(body.fixedFee);
  const maxUses = toNonNegativeInt(body.maxUses);
  if (
    customerDiscount === null ||
    commissionRate === null ||
    fixedFee === null ||
    maxUses === null
  ) {
    return badRequest("المبالغ لازم تكون أرقام موجبة");
  }

  const commissionBasis =
    typeof body.commissionBasis === "string" ? body.commissionBasis : "ORDER";
  if (!BASES.has(commissionBasis)) return badRequest("commissionBasis غير صحيح");

  const countTrigger =
    typeof body.countTrigger === "string" ? body.countTrigger : "CONFIRMED";
  if (!TRIGGERS.has(countTrigger)) return badRequest("countTrigger غير صحيح");

  const applicableSlugs = Array.isArray(body.applicableSlugs)
    ? body.applicableSlugs.filter((s: unknown) => typeof s === "string" && s)
    : [];

  // Read-then-create (Neon HTTP: no transactions) — friendly duplicate error.
  const existing = await db.influencer.findUnique({ where: { couponCode } });
  if (existing) return badRequest("هذا الكود مستعمل من قبل مؤثر آخر");

  const influencer = await db.influencer.create({
    data: {
      name,
      handle: typeof body.handle === "string" ? body.handle.trim() || null : null,
      platform:
        typeof body.platform === "string" ? body.platform.trim() || null : null,
      phone: typeof body.phone === "string" ? body.phone.trim() || null : null,
      couponCode,
      customerDiscount,
      applicableSlugs,
      maxUses,
      commissionRate,
      commissionBasis,
      countTrigger,
      fixedFee,
      notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
    },
  });

  return NextResponse.json({ influencer }, { status: 201 });
}
