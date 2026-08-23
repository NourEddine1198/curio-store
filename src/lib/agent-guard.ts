import { NextRequest, NextResponse } from "next/server";
import { verifyToken, AgentToken } from "./agent-auth";

// Pull + verify the agent from the Authorization: Bearer <token> header.
// Returns the decoded token (id, role) or null if missing/invalid/expired.
export function agentFromRequest(req: NextRequest): AgentToken | null {
  const h = req.headers.get("authorization") || "";
  const token = h.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return verifyToken(token, Date.now());
}

// ─── Ownership ──────────────────────────────────────────────
// Every order belongs to exactly one confirmation agent (stamped at checkout,
// changed by the owner in /admin/). The board already hides other people's
// orders, but the board is not the only door: an order can also be reached by
// typing its number into the URL. So every endpoint that acts on ONE order
// checks the same thing — that the order is actually this agent's.
export function ownsOrder(agentId: string, order: { assignedAgentId: string | null }): boolean {
  return order.assignedAgentId === agentId;
}

export function notMine() {
  return NextResponse.json(
    { error: "هذا الطلب ماشي في القائمة تاعك. قول للمسؤول يحوّلهولك." },
    { status: 403 }
  );
}
