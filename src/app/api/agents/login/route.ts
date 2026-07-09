import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, signToken } from "@/lib/agent-auth";

// POST /api/agents/login  { username, password } → { token, agent }
// Public endpoint (this IS the login). Rate-limited only by obscurity for now;
// PBKDF2 makes brute force slow. Returns a 7-day signed token on success.

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const username = (body?.username || "").trim().toLowerCase();
    const password = body?.password || "";
    if (!username || !password) {
      return NextResponse.json({ error: "دخل username و كلمة السر" }, { status: 400 });
    }

    const agent = await db.agent.findUnique({ where: { username } });
    // Always run a verify to reduce timing signal, even when agent is missing.
    const ok = agent ? verifyPassword(password, agent.passwordHash) : verifyPassword(password, "x:y");

    if (!agent || !ok || !agent.active) {
      return NextResponse.json({ error: "username أو كلمة السر غالطين" }, { status: 401 });
    }

    const token = signToken(agent.id, agent.role, Date.now());
    return NextResponse.json({
      success: true,
      token,
      agent: { id: agent.id, name: agent.name, username: agent.username, role: agent.role },
    });
  } catch (error) {
    console.error("POST /api/agents/login error:", error);
    return NextResponse.json({ error: "صار مشكل، عاود حاول" }, { status: 500 });
  }
}
