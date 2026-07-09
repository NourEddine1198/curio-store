import { NextRequest } from "next/server";
import { verifyToken, AgentToken } from "./agent-auth";

// Pull + verify the agent from the Authorization: Bearer <token> header.
// Returns the decoded token (id, role) or null if missing/invalid/expired.
export function agentFromRequest(req: NextRequest): AgentToken | null {
  const h = req.headers.get("authorization") || "";
  const token = h.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  return verifyToken(token, Date.now());
}
