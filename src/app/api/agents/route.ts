import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/agent-auth";
import { resolveDefaultAgentId, DEFAULT_AGENT_KEY } from "@/lib/agent-routing";

// Agent management — OWNER only (guarded by the admin key).
//   GET    → list agents
//   POST   → create agent { name, username, password, role? }
//   PATCH  → update { id, name?, active?, role?, password? }

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

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

// Orders that still need a human. Terminal + junk states are excluded — an
// agent sitting on 300 DELIVERED orders is not a reason to hesitate before
// pausing them; an agent sitting on 12 unanswered ones is.
const OPEN_STATUSES = [
  "PENDING", "WAITLIST", "NO_ANSWER", "CALLBACK", "EXPIRED",
  "CONFIRMED", "PROCESSING", "SHIPPED", "IN_TRANSIT",
  "OUT_FOR_DELIVERY", "AT_STOPDESK", "DELIVERY_FAILED", "IN_RETURN",
] as const;

export async function GET(request: NextRequest) {
  if (!isOwner(request)) return unauthorized();
  const agents = await db.agent.findMany({ orderBy: { createdAt: "asc" } });

  // Two numbers per agent: everything they own, and what is still live.
  // Counted in SQL in one pass — a groupBy, not one query per agent.
  const [totalRows, openRows, defaultId] = await Promise.all([
    db.order.groupBy({ by: ["assignedAgentId"], _count: { _all: true } }),
    db.order.groupBy({
      by: ["assignedAgentId"],
      where: { status: { in: OPEN_STATUSES as never } },
      _count: { _all: true },
    }),
    resolveDefaultAgentId(),
  ]);
  const totalBy = new Map(totalRows.map((r) => [r.assignedAgentId, r._count._all]));
  const openBy = new Map(openRows.map((r) => [r.assignedAgentId, r._count._all]));

  return NextResponse.json({
    agents: agents.map((a) => ({
      ...publicAgent(a),
      orderCount: totalBy.get(a.id) || 0,
      openCount: openBy.get(a.id) || 0,
      isDefault: a.id === defaultId,
    })),
    // Who new orders flow to right now (the setting, or the oldest active
    // agent as the fallback), plus how many orders belong to nobody at all.
    defaultAgentId: defaultId,
    defaultAgentKey: DEFAULT_AGENT_KEY,
    unassignedCount: openBy.get(null) || 0,
  });
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

    const agent = await db.agent.create({
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

    // makeDefault: point NEW orders at this agent from now on. It lives here
    // rather than on /api/settings because that route only answers to PUT,
    // and PUT is not in the API's CORS allow-list — the admin page is on
    // curiodz.com while the API is on Netlify, so a PUT from the browser dies
    // in the preflight. Everything an owner does to an agent goes through
    // this one PATCH instead.
    const makeDefault = body.makeDefault === true;
    if (!makeDefault && Object.keys(data).length === 0) {
      return NextResponse.json({ error: "walou to update" }, { status: 400 });
    }

    const agent = Object.keys(data).length
      ? await db.agent.update({ where: { id }, data })
      : await db.agent.findUnique({ where: { id } });
    if (!agent) return NextResponse.json({ error: "العون غير موجود" }, { status: 404 });

    if (makeDefault) {
      if (!agent.active) {
        return NextResponse.json({ error: "عون موقّف ما يقدرش يستقبل الطلبات" }, { status: 400 });
      }
      // Read-then-write: the Neon HTTP driver has no transactions, and an
      // upsert asks for one.
      const existing = await db.siteSetting.findUnique({ where: { key: DEFAULT_AGENT_KEY } });
      if (existing) {
        await db.siteSetting.update({ where: { key: DEFAULT_AGENT_KEY }, data: { value: agent.id } });
      } else {
        await db.siteSetting.create({ data: { key: DEFAULT_AGENT_KEY, value: agent.id } });
      }
    }

    return NextResponse.json({ success: true, agent: publicAgent(agent) });
  } catch (error) {
    console.error("PATCH /api/agents error:", error);
    return NextResponse.json({ error: "فشل التعديل" }, { status: 500 });
  }
}
