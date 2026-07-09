import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dbPg } from "@/lib/db-pg";
import { hashPassword } from "@/lib/agent-auth";

// Agent management — OWNER only (guarded by the admin key).
//   GET    → list agents
//   POST   → create agent { name, username, password, role? }
//   PATCH  → update { id, name?, active?, role?, password? }

export const dynamic = "force-dynamic";

const ADMIN_KEY = process.env.ADMIN_KEY;
function isOwner(req: NextRequest) {
  return Boolean(ADMIN_KEY) && req.headers.get("x-admin-key") === ADMIN_KEY;
}
function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
function publicAgent(a: { id: string; name: string; username: string; role: string; active: boolean; createdAt: Date }) {
  return { id: a.id, name: a.name, username: a.username, role: a.role, active: a.active, createdAt: a.createdAt };
}

export async function GET(request: NextRequest) {
  if (!isOwner(request)) return unauthorized();
  const agents = await db.agent.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ agents: agents.map(publicAgent) });
}

export async function POST(request: NextRequest) {
  if (!isOwner(request)) return unauthorized();
  try {
    const body = await request.json();
    const name = (body?.name || "").trim();
    const username = (body?.username || "").trim().toLowerCase();
    const password = body?.password || "";
    const role = body?.role === "owner" ? "owner" : "agent";

    if (name.length < 2) return NextResponse.json({ error: "الاسم مطلوب" }, { status: 400 });
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return NextResponse.json({ error: "username: 3-32 حرف (حروف صغيرة/أرقام)" }, { status: 400 });
    }
    if (String(password).length < 6) {
      return NextResponse.json({ error: "كلمة السر 6 حروف على الأقل" }, { status: 400 });
    }

    const existing = await db.agent.findUnique({ where: { username } });
    if (existing) return NextResponse.json({ error: "username موجود من قبل" }, { status: 409 });

    const agent = await dbPg.agent.create({
      data: { name, username, passwordHash: hashPassword(password), role },
    });
    return NextResponse.json({ success: true, agent: publicAgent(agent) }, { status: 201 });
  } catch (error) {
    console.error("POST /api/agents error:", error);
    return NextResponse.json({ error: "فشل إنشاء العون" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isOwner(request)) return unauthorized();
  try {
    const body = await request.json();
    const id = body?.id;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim().length >= 2) data.name = body.name.trim();
    if (typeof body.active === "boolean") data.active = body.active;
    if (body.role === "owner" || body.role === "agent") data.role = body.role;
    if (typeof body.password === "string" && body.password.length >= 6) {
      data.passwordHash = hashPassword(body.password);
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "walou to update" }, { status: 400 });
    }

    const agent = await dbPg.agent.update({ where: { id }, data });
    return NextResponse.json({ success: true, agent: publicAgent(agent) });
  } catch (error) {
    console.error("PATCH /api/agents error:", error);
    return NextResponse.json({ error: "فشل التعديل" }, { status: 500 });
  }
}
