import { NextRequest, NextResponse } from "next/server";
import { syncAdSpend, metaConfigured } from "@/lib/meta-ads";
import { runMoneyWatch } from "@/lib/money-watch";

// POST /api/sync/finance — the nightly autopilot.
//
//   1. pull Meta's daily ad spend into the ledger (skipped without a token)
//   2. look for parcels set to collect nothing, or less than our books say,
//      and send one Telegram alert about the ones nobody has been told about
//
// Guarded by the same SYNC_SECRET as the other sync routes, so the Netlify
// scheduled function can call it without the admin key.
//
// The two steps are independent on purpose: no Meta token must never stop
// the money watch from running, because the watch is the half that catches
// cash walking out of the door.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const SYNC_SECRET = process.env.SYNC_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY;

function allowed(request: NextRequest): boolean {
  if (SYNC_SECRET && request.headers.get("x-sync-secret") === SYNC_SECRET) return true;
  // The owner can also run it by hand from the finance page.
  if (ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY) return true;
  return false;
}

export async function POST(request: NextRequest) {
  if (!allowed(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const days = Math.min(30, Math.max(1, Number(request.nextUrl.searchParams.get("days")) || 7));
  // A dry run reports what it WOULD shout about without marking anything as
  // seen — so the first look at this can't silently burn the one alert you
  // would have got about a real problem.
  const notify = request.nextUrl.searchParams.get("dry") !== "1";

  const out: Record<string, unknown> = { ranAt: new Date().toISOString(), days, notify };

  try {
    out.ads = metaConfigured()
      ? await syncAdSpend(days)
      : { ok: false, error: "META_TOKEN is not set — ad spend stays manual", skipped: true };
  } catch (error) {
    console.error("finance sync · ads:", error);
    out.ads = { ok: false, error: "ad sync threw" };
  }

  try {
    out.watch = await runMoneyWatch({ notify });
  } catch (error) {
    console.error("finance sync · watch:", error);
    out.watch = { ok: false, error: "money watch threw" };
  }

  return NextResponse.json(out);
}
