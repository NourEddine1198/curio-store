import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────
// Command Center "reads" — the AI co-founder routine's output.
//  GET  /api/reads?limit=10[&kind=daily]  → recent reads.
//        Used by the dashboard (to show the latest) AND by the routine
//        (to remember past reads and spot what changed). Needs ADMIN_KEY.
//  POST /api/reads  → store a new read. Written only by the routine.
//        Needs SYNC_SECRET. Body: { kind, title, content, metrics }.
// Read/append only — never touches orders, stock, ads, or money.
// ─────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;
const SYNC_SECRET = process.env.SYNC_SECRET;

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limit = Math.min(30, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10) || 10));
  const kind = url.searchParams.get("kind");
  try {
    const reads = await db.commandRead.findMany({
      where: kind ? { kind } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json({ reads });
  } catch (error) {
    console.error("GET /api/reads error:", error);
    return NextResponse.json({ error: "failed to load reads" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!SYNC_SECRET || request.headers.get("x-sync-secret") !== SYNC_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    const kind = body.kind === "weekly" ? "weekly" : "daily";
    const title = String(body.title || "").slice(0, 300);
    const content = String(body.content || "");
    if (!content) return NextResponse.json({ error: "missing content" }, { status: 400 });
    const read = await db.commandRead.create({
      data: { kind, title, content, metrics: body.metrics ?? undefined },
    });
    return NextResponse.json({ ok: true, id: read.id, createdAt: read.createdAt });
  } catch (error) {
    console.error("POST /api/reads error:", error);
    return NextResponse.json({ error: "failed to store read" }, { status: 500 });
  }
}
