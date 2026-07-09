import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dbPg } from "@/lib/db-pg";

// Small key/value settings store (owner only). Used for things like the
// confirmation cutover date. GET returns all; PUT upserts one { key, value }.
export const dynamic = "force-dynamic";

const ADMIN_KEY = process.env.ADMIN_KEY;
function isOwner(req: NextRequest) {
  return Boolean(ADMIN_KEY) && req.headers.get("x-admin-key") === ADMIN_KEY;
}

export async function GET(request: NextRequest) {
  if (!isOwner(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await db.siteSetting.findMany();
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return NextResponse.json({ settings: map });
}

export async function PUT(request: NextRequest) {
  if (!isOwner(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    const key = String(body?.key || "").trim();
    const value = String(body?.value ?? "");
    if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });
    const row = await dbPg.siteSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return NextResponse.json({ success: true, setting: { key: row.key, value: row.value } });
  } catch (error) {
    console.error("PUT /api/settings error:", error);
    return NextResponse.json({ error: "Failed to save setting" }, { status: 500 });
  }
}
