import { pbkdf2Sync, randomBytes, createHmac, timingSafeEqual } from "crypto";

// Agent authentication helpers — no external deps, all Node built-in crypto.
//   - Passwords: PBKDF2 hashed, stored as "salt:hash".
//   - Sessions: a stateless signed token "payloadB64.signature" (HMAC-SHA256),
//     verified against a server secret. No session table needed.

const ITER = 120000;
const KEYLEN = 32;
const DIGEST = "sha256";

// Token secret. Prefer a dedicated env var; fall back to ADMIN_KEY (always set
// in production). Tokens are only trusted if this secret matches.
function secret(): string {
  return process.env.AGENT_TOKEN_SECRET || process.env.ADMIN_KEY || "";
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, ITER, KEYLEN, DIGEST).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const test = pbkdf2Sync(password, salt, ITER, KEYLEN, DIGEST).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sign(payloadB64: string): string {
  return b64url(createHmac("sha256", secret()).update(payloadB64).digest());
}

// 7-day tokens.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signToken(agentId: string, role: string, nowMs: number): string {
  const payload = { id: agentId, role, exp: nowMs + TOKEN_TTL_MS };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export interface AgentToken {
  id: string;
  role: string;
  exp: number;
}

// Returns the decoded token if the signature is valid and not expired, else null.
export function verifyToken(token: string | null, nowMs: number): AgentToken | null {
  if (!token || !secret()) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (!payload || typeof payload.id !== "string") return null;
    if (typeof payload.exp !== "number" || payload.exp < nowMs) return null;
    return { id: payload.id, role: payload.role || "agent", exp: payload.exp };
  } catch {
    return null;
  }
}
