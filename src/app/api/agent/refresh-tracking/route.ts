import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { runTrackingSync } from "@/lib/tracking-sync";

// POST /api/agent/refresh-tracking — the agent's "تحديث التتبع" button.
// Runs the same Ecotrack sync as the hourly cron, but rate-limited so
// repeated clicks don't hammer Ecotrack (once every 5 minutes max).

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const MIN_GAP_MS = 5 * 60 * 1000;

export async function POST(request: NextRequest) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const last = await db.siteSetting.findUnique({ where: { key: "trackingSyncLastRunAt" } });
    if (last?.value) {
      const at = new Date(last.value).getTime();
      const wait = at + MIN_GAP_MS - Date.now();
      if (!isNaN(at) && wait > 0) {
        return NextResponse.json(
          { error: `التتبع تحدّث قبل شوية — عاودي بعد ${Math.ceil(wait / 60000)} دقايق`, retryInMs: wait },
          { status: 429 }
        );
      }
    }
    const report = await runTrackingSync();
    return NextResponse.json(report, { status: report.ok ? 200 : 502 });
  } catch (error) {
    console.error("POST /api/agent/refresh-tracking error:", error);
    return NextResponse.json({ error: "فشل تحديث التتبع" }, { status: 500 });
  }
}
