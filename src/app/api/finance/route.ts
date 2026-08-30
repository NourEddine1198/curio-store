import { NextRequest, NextResponse } from "next/server";
import { buildFinanceReport, type PeriodKey } from "@/lib/finance";

// READ-ONLY. Runs read queries only — no create, update or delete
// anywhere in this route or the engine behind it.
//
// force-dynamic because Netlify will otherwise happily serve
// yesterday's profit from its cache.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;
const PERIODS: PeriodKey[] = ["month", "last30", "all"];

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("period");
  const period: PeriodKey = PERIODS.includes(raw as PeriodKey) ? (raw as PeriodKey) : "month";

  try {
    return NextResponse.json(await buildFinanceReport(period));
  } catch (error) {
    console.error("GET /api/finance error:", error);
    return NextResponse.json({ error: "Failed to build the finance report" }, { status: 500 });
  }
}
