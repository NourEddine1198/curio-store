import { NextRequest, NextResponse } from "next/server";
import { runTrackingSync } from "@/lib/tracking-sync";

// POST /api/sync/tracking — runs the Ecotrack tracking sync (the rescue
// loop). Called hourly by the Netlify scheduled function, or manually.
// Guarded by the same SYNC_SECRET as the legacy delivery sync.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const SYNC_SECRET = process.env.SYNC_SECRET;

export async function POST(request: NextRequest) {
  if (!SYNC_SECRET) {
    return NextResponse.json({ error: "SYNC_SECRET not set — sync disabled" }, { status: 401 });
  }
  if (request.headers.get("x-sync-secret") !== SYNC_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runTrackingSync();
    return NextResponse.json(report, { status: report.ok ? 200 : 502 });
  } catch (error) {
    console.error("POST /api/sync/tracking error:", error);
    return NextResponse.json({ error: "tracking sync failed" }, { status: 500 });
  }
}
