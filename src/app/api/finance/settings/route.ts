import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// The cost rules. GET reads them; PATCH changes one.
//
// This is the ONLY thing on /finance that writes, and it writes one
// row of one table. It cannot touch an order, a parcel or a payout.
//
// PATCH, not PUT: the store's CORS config has no PUT, and a route that
// works in curl but dies in the browser's preflight has cost this
// codebase a debugging session before.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;

function guard(request: NextRequest) {
  return !!ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY;
}

export async function GET(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    // The money watch parks "already alerted about this parcel" markers in
    // this table too. They are bookkeeping for the alarm, not cost rules, so
    // they never appear on the screen.
    const settings = await db.financeSetting.findMany({
      where: { NOT: { key: { startsWith: "watch.seen." } } },
      orderBy: { sort: "asc" },
    });
    return NextResponse.json({ settings });
  } catch (error) {
    console.error("GET /api/finance/settings error:", error);
    return NextResponse.json({ error: "Failed to read the cost rules" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    const value = typeof body?.value === "string" ? body.value.trim() : "";
    if (!key || !value) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 });
    }

    // Only a rule that already exists can be changed. Creating rules from
    // the browser would let a typo invent "wrap.rouba" that nothing reads,
    // and the real one would go on being wrong in silence.
    const existing = await db.financeSetting.findUnique({ where: { key } });
    if (!existing) return NextResponse.json({ error: "no such cost rule" }, { status: 404 });

    // Validate by shape, so a stray letter can't turn a cost into NaN and
    // quietly zero out a whole line of the profit.
    if (key === "books.openFrom") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        return NextResponse.json({ error: "use a date like 2026-08-13" }, { status: 400 });
      }
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ error: "must be a number, zero or more" }, { status: 400 });
      }
    }

    // A single-row update by primary key — no transaction, which the Neon
    // HTTP driver does not have.
    const updated = await db.financeSetting.update({ where: { key }, data: { value } });
    return NextResponse.json({ success: true, setting: updated });
  } catch (error) {
    console.error("PATCH /api/finance/settings error:", error);
    return NextResponse.json({ error: "Failed to save the cost rule" }, { status: 500 });
  }
}
