import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadCostRules, toDzd } from "@/lib/finance";

// The ledger — money that actually moved.
//
// GET    → the movements in a window, plus the accounts and categories the
//          form needs, so the screen only has to make one call
// POST   → record one
// DELETE → remove one (a ledger you cannot correct is worse than none)
//
// A movement whose category is `auto` still lands here and still moves the
// account. The profit view simply ignores it, because it works that number
// out from the orders instead — which is how paying the agent her month in
// cash cannot double-count the 80-per-delivered-order already charged.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;
const guard = (r: NextRequest) => !!ADMIN_KEY && r.headers.get("x-admin-key") === ADMIN_KEY;

export async function GET(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const days = Math.min(365, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 60));
  const from = new Date(Date.now() - days * 86400000);

  try {
    const [movements, accounts, categories, rules] = await Promise.all([
      db.moneyMovement.findMany({
        where: { occurredAt: { gte: from } },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        take: 500,
        select: {
          id: true, occurredAt: true, direction: true, amount: true, currency: true,
          amountDzd: true, fxRate: true, categoryKey: true, note: true, payoutId: true,
          createdBy: true,
          account: { select: { key: true, name: true, currency: true } },
          toAccount: { select: { key: true, name: true } },
          category: { select: { label: true, labelAr: true, kind: true, auto: true } },
        },
      }),
      db.financeAccount.findMany({ where: { active: true }, orderBy: { sort: "asc" },
        select: { key: true, name: true, currency: true } }),
      db.financeCategory.findMany({ where: { active: true }, orderBy: { sort: "asc" },
        select: { key: true, label: true, labelAr: true, kind: true, auto: true } }),
      loadCostRules(),
    ]);

    return NextResponse.json({
      movements: movements.map((m) => ({ ...m, occurredAt: m.occurredAt.toISOString() })),
      accounts,
      categories,
      eurDzd: rules.eurDzd,
      days,
    });
  } catch (error) {
    console.error("GET /api/finance/movements error:", error);
    return NextResponse.json({ error: "Failed to read the ledger" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const direction = String(body?.direction || "");
    const accountKey = String(body?.accountKey || "");
    const categoryKey = String(body?.categoryKey || "");
    const occurredRaw = String(body?.occurredAt || "");
    const note = typeof body?.note === "string" ? body.note.trim() || null : null;
    const amount = Number(body?.amount);

    if (!["in", "out", "transfer"].includes(direction)) {
      return NextResponse.json({ error: "direction must be in, out or transfer" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredRaw)) {
      return NextResponse.json({ error: "Use a date like 2026-08-30" }, { status: 400 });
    }
    // Zero is not a movement, and a negative one is a direction mistake — both
    // would quietly distort a month's totals.
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "The amount must be more than zero" }, { status: 400 });
    }

    const account = await db.financeAccount.findUnique({ where: { key: accountKey } });
    if (!account) return NextResponse.json({ error: "no such account" }, { status: 400 });

    const category = await db.financeCategory.findUnique({ where: { key: categoryKey } });
    if (!category) return NextResponse.json({ error: "no such category" }, { status: 400 });

    let toAccountId: string | null = null;
    if (direction === "transfer") {
      const to = await db.financeAccount.findUnique({ where: { key: String(body?.toAccountKey || "") } });
      if (!to) return NextResponse.json({ error: "a transfer needs a destination account" }, { status: 400 });
      if (to.id === account.id) {
        return NextResponse.json({ error: "a transfer needs two different accounts" }, { status: 400 });
      }
      toAccountId = to.id;
    }

    const rules = await loadCostRules();
    // The rate on the day is a FACT. Freeze it here rather than converting at
    // read time, or every past month silently re-prices itself when the rate
    // moves — and August would stop matching what August actually cost.
    const fxRate = account.currency === "EUR" ? Math.round(rules.eurDzd * 100) : null;
    const amountDzd = toDzd(Math.round(amount), account.currency, rules.eurDzd);

    const movement = await db.moneyMovement.create({
      data: {
        occurredAt: new Date(`${occurredRaw}T12:00:00.000Z`),
        direction,
        accountId: account.id,
        toAccountId,
        amount: Math.round(amount),
        currency: account.currency,
        amountDzd,
        fxRate,
        categoryKey,
        note,
        createdBy: "owner",
      },
    });

    return NextResponse.json({
      success: true,
      movement: { ...movement, occurredAt: movement.occurredAt.toISOString() },
      countedInProfit: !category.auto,
    });
  } catch (error) {
    console.error("POST /api/finance/movements error:", error);
    return NextResponse.json({ error: "Failed to record it" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const m = await db.moneyMovement.findUnique({ where: { id }, select: { payoutId: true } });
    if (!m) return NextResponse.json({ error: "no such movement" }, { status: 404 });
    // Deleting a payout's cash row on its own would leave its parcels marked
    // settled with no money against them. Undo the whole payout instead.
    if (m.payoutId) {
      return NextResponse.json(
        { error: "This is a courier payout's cash. Undo the payout itself so its parcels go back to being owed." },
        { status: 409 }
      );
    }
    await db.moneyMovement.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/finance/movements error:", error);
    return NextResponse.json({ error: "Failed to delete it" }, { status: 500 });
  }
}
