import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";

// GET /api/agent/orders?bucket=call|ship|done
//   call → orders to phone-confirm (PENDING)   [default]
//   ship → confirmed, ready to send to Ecotrack (CONFIRMED / PROCESSING)
//   done → already shipped (SHIPPED)
// Agent-authenticated (Bearer token from /api/agents/login).

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bucket = new URL(request.url).searchParams.get("bucket") || "call";
  const statusByBucket: Record<string, string[]> = {
    call: ["PENDING"],
    ship: ["CONFIRMED", "PROCESSING"],
    done: ["SHIPPED"],
  };
  const statuses = statusByBucket[bucket] || statusByBucket.call;

  try {
    // Cutover: only surface orders from when in-house confirmation began, so
    // the pre-cutover backlog (orders OrderDZ confirmed out-of-band) stays out
    // of the queue without altering any historical data.
    const cutoverRow = await db.siteSetting.findUnique({ where: { key: "confirmationCutoverAt" } });
    const cutoverAt = cutoverRow?.value ? new Date(cutoverRow.value) : null;
    const dateFilter = cutoverAt && !isNaN(cutoverAt.getTime()) ? { createdAt: { gte: cutoverAt } } : {};

    const orders = await db.order.findMany({
      where: { status: { in: statuses as never }, ...dateFilter },
      include: {
        items: { include: { product: { select: { name: true, slug: true } } } },
        assignedAgent: { select: { id: true, name: true } },
      },
      orderBy:
        bucket === "call"
          ? [{ nextCallAt: "asc" }, { createdAt: "desc" }] // due retries first, then newest orders
          : [{ createdAt: "desc" }],
      take: 200,
    });

    // Count for the bucket tabs
    const [callCount, shipCount] = await Promise.all([
      db.order.count({ where: { status: "PENDING", ...dateFilter } }),
      db.order.count({ where: { status: { in: ["CONFIRMED", "PROCESSING"] as never }, ...dateFilter } }),
    ]);

    return NextResponse.json({ orders, counts: { call: callCount, ship: shipCount } });
  } catch (error) {
    console.error("GET /api/agent/orders error:", error);
    return NextResponse.json({ error: "صار مشكل في تحميل الطلبات" }, { status: 500 });
  }
}
