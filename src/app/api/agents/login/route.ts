import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword, signToken } from "@/lib/agent-auth";

// POST /api/agents/login  { username, password } → { token, agent }
// Public endpoint. Protected against brute force with a per-account lockout:
// after MAX_FAILED wrong attempts the account is locked for LOCK_MINUTES.
// PBKDF2 + timing-equalized verify guard against timing/offline attacks.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const username = (body?.username || "").trim().toLowerCase();
    const password = body?.password || "";
    if (!username || !password) {
      return NextResponse.json({ error: "دخل username و كلمة السر" }, { status: 400 });
    }

    const agent = await db.agent.findUnique({ where: { username } });
    const now = new Date();

    // Locked out? (don't reveal whether the username exists)
    if (agent?.lockedUntil && agent.lockedUntil > now) {
      return NextResponse.json(
        { error: "الحساب مقفول مؤقتا بسبب محاولات كثيرة. جرب بعد شوية." },
        { status: 429 }
      );
    }

    // Always run a verify (even when the user is missing) to equalize timing.
    const ok = agent ? verifyPassword(password, agent.passwordHash) : verifyPassword(password, "x:y");

    if (!agent || !ok || !agent.active) {
      // Count the failure + lock if over the threshold.
      if (agent) {
        const failed = (agent.failedAttempts || 0) + 1;
        try {
          if (failed >= MAX_FAILED) {
            await db.agent.update({
              where: { id: agent.id },
              data: { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) },
            });
          } else {
            await db.agent.update({ where: { id: agent.id }, data: { failedAttempts: failed } });
          }
        } catch { /* non-fatal */ }
      }
      return NextResponse.json({ error: "username أو كلمة السر غالطين" }, { status: 401 });
    }

    // Success → clear any failed-attempt state.
    if (agent.failedAttempts > 0 || agent.lockedUntil) {
      try { await db.agent.update({ where: { id: agent.id }, data: { failedAttempts: 0, lockedUntil: null } }); }
      catch { /* non-fatal */ }
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
