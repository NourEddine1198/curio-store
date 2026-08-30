import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { listUnsettledParcels } from "@/lib/finance";

// One «Décharge de paiement expéditeur» — the numbered slip the courier
// hands over with the cash.
//
// GET    → the payouts so far + every parcel still waiting to be settled
// POST   → record a payout: cash in, and those parcels stop being owed
// DELETE → undo one, in full (a mistyped slip must be fixable)
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;
const guard = (r: NextRequest) => !!ADMIN_KEY && r.headers.get("x-admin-key") === ADMIN_KEY;

export async function GET(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const [payouts, unsettled] = await Promise.all([
      db.courierPayout.findMany({
        orderBy: { collectedAt: "desc" },
        select: {
          id: true, reference: true, collectedAt: true, parcelCount: true,
          slipTotal: true, expectedTotal: true, trackingCodes: true, note: true,
        },
      }),
      listUnsettledParcels(),
    ]);
    return NextResponse.json({
      payouts: payouts.map((p) => ({ ...p, collectedAt: p.collectedAt.toISOString(), settledParcels: p.trackingCodes.length })),
      unsettled,
      unsettledTotal: unsettled.reduce((s, p) => s + p.net, 0),
    });
  } catch (error) {
    console.error("GET /api/finance/payouts error:", error);
    return NextResponse.json({ error: "Failed to read payouts" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
    const collectedAtRaw = typeof body?.collectedAt === "string" ? body.collectedAt.trim() : "";
    const slipTotal = Number(body?.slipTotal);
    const note = typeof body?.note === "string" ? body.note.trim() : null;
    const codes: string[] = Array.isArray(body?.trackingCodes)
      ? body.trackingCodes.filter((c: unknown) => typeof c === "string" && c.trim()).map((c: string) => c.trim())
      : [];

    if (!reference) return NextResponse.json({ error: "The slip reference is required" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(collectedAtRaw)) {
      return NextResponse.json({ error: "Use a date like 2026-08-30" }, { status: 400 });
    }
    if (!Number.isFinite(slipTotal) || slipTotal < 0) {
      return NextResponse.json({ error: "The slip total must be a number" }, { status: 400 });
    }
    if (codes.length === 0) {
      return NextResponse.json({ error: "Pick at least one parcel this payout covers" }, { status: 400 });
    }

    const dup = await db.courierPayout.findUnique({ where: { reference } });
    if (dup) {
      return NextResponse.json({ error: `Slip ${reference} is already recorded` }, { status: 409 });
    }

    // A parcel may only ever be settled once — that is the whole defence
    // against counting the same cash twice.
    const unsettled = await listUnsettledParcels();
    const available = new Map(unsettled.map((p) => [p.trackingCode, p]));
    const missing = codes.filter((c) => !available.has(c));
    if (missing.length) {
      return NextResponse.json(
        { error: `${missing.length} of those parcels ${missing.length === 1 ? "is" : "are"} already settled or not delivered`, missing },
        { status: 409 }
      );
    }

    const expectedTotal = codes.reduce((s, c) => s + (available.get(c)?.net ?? 0), 0);
    // Midday UTC: he types a calendar day, and this keeps it on that day in
    // Algiers (UTC+1) without a timezone edge landing it on the one before.
    const collectedAt = new Date(`${collectedAtRaw}T12:00:00.000Z`);

    const cash = await db.financeAccount.findUnique({ where: { key: "cash" } });
    if (!cash) return NextResponse.json({ error: "The cash account is missing — re-run the finance seed" }, { status: 500 });

    // The Neon HTTP driver has no transactions, so these two writes cannot be
    // atomic. Write the payout first; if the cash row then fails, undo the
    // payout rather than leaving parcels marked settled against money that
    // was never recorded as arriving.
    const payout = await db.courierPayout.create({
      data: {
        reference, collectedAt, slipTotal, expectedTotal,
        parcelCount: Number.isFinite(Number(body?.parcelCount)) ? Number(body.parcelCount) : codes.length,
        accountId: cash.id, trackingCodes: codes, note,
      },
    });

    try {
      await db.moneyMovement.create({
        data: {
          occurredAt: collectedAt,
          direction: "in",
          accountId: cash.id,
          amount: slipTotal,
          currency: "DZD",
          amountDzd: slipTotal,
          fxRate: null,
          categoryKey: "courier_payout",
          note: `Slip ${reference}${note ? ` — ${note}` : ""}`,
          payoutId: payout.id,
          createdBy: "owner",
        },
      });
    } catch (inner) {
      console.error("payout cash row failed, undoing payout:", inner);
      await db.courierPayout.delete({ where: { id: payout.id } }).catch(() => {});
      return NextResponse.json({ error: "Couldn't record the cash — nothing was saved" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      payout: { ...payout, collectedAt: payout.collectedAt.toISOString() },
      difference: slipTotal - expectedTotal,
    });
  } catch (error) {
    console.error("POST /api/finance/payouts error:", error);
    return NextResponse.json({ error: "Failed to record the payout" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!guard(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const payout = await db.courierPayout.findUnique({ where: { id } });
    if (!payout) return NextResponse.json({ error: "no such payout" }, { status: 404 });

    // Cash row first: if that succeeds and the payout delete fails, the
    // parcels stay settled and the money is gone from the ledger — visible
    // and fixable. The other order would silently double-count the parcels.
    const movements = await db.moneyMovement.findMany({ where: { payoutId: id }, select: { id: true } });
    for (const m of movements) await db.moneyMovement.delete({ where: { id: m.id } });
    await db.courierPayout.delete({ where: { id } });

    return NextResponse.json({ success: true, freedParcels: payout.trackingCodes.length });
  } catch (error) {
    console.error("DELETE /api/finance/payouts error:", error);
    return NextResponse.json({ error: "Failed to undo the payout" }, { status: 500 });
  }
}
