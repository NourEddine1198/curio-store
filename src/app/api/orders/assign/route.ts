import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// ─── POST /api/orders/assign — move a BATCH of orders to one agent ───
//
// The per-order dropdown in /admin/ handles the one-off ("this order is
// mine"). This is the other half: tick ten rows, pick a name, done. Same
// rules, same timeline entry — just without ten round trips.
//
// Body: { orderNumbers: number[], agentId: string | null }
//   agentId null/"" → hand the orders back to nobody (they show on no board).
//
// Owner only (admin key). Sequential on purpose: the Neon HTTP driver has no
// transactions, so updateMany + a per-order timeline row is not available —
// and a partial result the owner can SEE beats a silent all-or-nothing.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;
const MAX_BATCH = 200;

export async function POST(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const nums: number[] = Array.isArray(body?.orderNumbers)
      ? Array.from(
          new Set(
            body.orderNumbers
              .map((n: unknown) => parseInt(String(n), 10))
              .filter((n: number) => !isNaN(n))
          )
        )
      : [];

    if (!nums.length) return NextResponse.json({ error: "ما خترت حتى طلب" }, { status: 400 });
    if (nums.length > MAX_BATCH) {
      return NextResponse.json({ error: `ماكس ${MAX_BATCH} طلب في المرة` }, { status: 400 });
    }

    const wantedId = body?.agentId ? String(body.agentId) : null;
    let wantedName = "بلا عون";
    if (wantedId) {
      const target = await db.agent.findUnique({
        where: { id: wantedId },
        select: { id: true, name: true, active: true },
      });
      if (!target) return NextResponse.json({ error: "العون غير موجود" }, { status: 400 });
      if (!target.active) return NextResponse.json({ error: "هذا العون موقّف" }, { status: 400 });
      wantedName = target.name;
    }

    // Name every agent once instead of once per order.
    const agents = await db.agent.findMany({ select: { id: true, name: true } });
    const nameOf = new Map(agents.map((a) => [a.id, a.name]));

    let moved = 0;
    let unchanged = 0;
    const missing: number[] = [];

    for (const num of nums) {
      const order = await db.order.findUnique({
        where: { orderNumber: num },
        select: { id: true, assignedAgentId: true },
      });
      if (!order) { missing.push(num); continue; }
      if (order.assignedAgentId === wantedId) { unchanged++; continue; }

      await db.order.update({ where: { id: order.id }, data: { assignedAgentId: wantedId } });
      await db.orderEvent.create({
        data: {
          orderId: order.id,
          kind: "system",
          actor: "owner",
          note: `تحويل الطلب: ${(order.assignedAgentId && nameOf.get(order.assignedAgentId)) || "بلا عون"} ← ${wantedName}`,
        },
      });
      moved++;
    }

    return NextResponse.json({ success: true, moved, unchanged, missing, agentName: wantedName });
  } catch (error) {
    console.error("POST /api/orders/assign error:", error);
    return NextResponse.json({ error: "صار مشكل في التحويل" }, { status: 500 });
  }
}
