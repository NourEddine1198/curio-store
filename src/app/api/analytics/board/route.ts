import { NextRequest, NextResponse } from "next/server";
import { buildScoreboard } from "@/lib/scoreboard";
import type { PeriodKey } from "@/lib/finance";

// The scoreboard as JSON, for the /analytics page.
// Admin-key gated — the brief token is for the read-only text brief only,
// and this payload is the same numbers a person is looking at anyway.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = request.nextUrl.searchParams.get("period");
  const period = (["month", "last30", "all"].includes(raw || "") ? raw : "month") as PeriodKey;
  try {
    return NextResponse.json(await buildScoreboard(period));
  } catch (error) {
    console.error("GET /api/analytics/board error:", error);
    return NextResponse.json({ error: "Failed to build the scoreboard" }, { status: 500 });
  }
}
