import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/agent-stats — OWNER (admin key). Confirmation-team performance +
// funnel, scoped to the in-house era (createdAt >= confirmation cutover) so
// the pre-cutover OrderDZ backlog doesn't distort agent numbers.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;
const CANCEL_DISPOSITIONS = ["cancelled", "wrong_number", "duplicate"];

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const cutoverRow = await db.siteSetting.findUnique({ where: { key: "confirmationCutoverAt" } });
    const cutoverAt = cutoverRow?.value ? new Date(cutoverRow.value) : null;
    const dateFilter = cutoverAt && !isNaN(cutoverAt.getTime()) ? { createdAt: { gte: cutoverAt } } : {};

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

    const [agents, statusRows, dispRows, agentStatusRows, agentDispRows,
      confirmedToday, shippedToday, confirmedWeek, ordersWeek, waitlistParked] = await Promise.all([
      db.agent.findMany({ orderBy: { createdAt: "asc" } }),
      db.order.groupBy({ by: ["status"], where: dateFilter, _count: { _all: true } }),
      db.order.groupBy({ by: ["disposition"], where: dateFilter, _count: { _all: true } }),
      db.order.groupBy({ by: ["assignedAgentId", "status"], where: dateFilter, _count: { _all: true } }),
      db.order.groupBy({ by: ["assignedAgentId", "disposition"], where: dateFilter, _count: { _all: true } }),
      db.order.count({ where: { confirmedAt: { gte: todayStart } } }),
      db.order.count({ where: { shippedAt: { gte: todayStart } } }),
      db.order.count({ where: { confirmedAt: { gte: weekStart } } }),
      db.order.count({ where: { createdAt: { gte: weekStart } } }),
      // Waitlist ignores the cutover (most of it predates the console), so it
      // is counted separately and kept OUT of the funnel — parking an old
      // order is not agent performance and must not move the confirm rate.
      db.order.count({ where: { status: "WAITLIST" } }),
    ]);

    const countBy = (rows: { _count: { _all: number } }[], key: string, val: string) =>
      rows.filter((r) => (r as unknown as Record<string, unknown>)[key] === val)
        .reduce((s, r) => s + r._count._all, 0);

    // Overall funnel (since cutover) — v2 statuses grouped into stages,
    // with the working/journey detail exposed alongside.
    const c = (v: string) => countBy(statusRows, "status", v);
    const funnel = {
      total: statusRows.reduce((s, r) => s + r._count._all, 0),
      pending: c("PENDING"),
      waitlist: waitlistParked,
      working: c("NO_ANSWER") + c("CALLBACK"),
      confirmed: c("CONFIRMED") + c("PROCESSING"),
      shipped: c("SHIPPED") + c("OUT_FOR_DELIVERY") + c("AT_STOPDESK") + c("DELIVERY_FAILED") + c("IN_RETURN"),
      delivered: c("DELIVERED"),
      returned: c("RETURNED"),
      cancelled: c("CANCELLED") + c("WRONG") + c("DUPLICATE") + c("EXPIRED"),
      // detail (for drill-down displays)
      noAnswer: c("NO_ANSWER"),
      callback: c("CALLBACK"),
      expired: c("EXPIRED"),
      wrong: c("WRONG"),
      duplicate: c("DUPLICATE"),
      deliveryFailed: c("DELIVERY_FAILED"),
      atStopdesk: c("AT_STOPDESK"),
      outForDelivery: c("OUT_FOR_DELIVERY"),
      inReturn: c("IN_RETURN"),
    };
    const dispositions = {
      confirmed: countBy(dispRows, "disposition", "confirmed"),
      no_answer: countBy(dispRows, "disposition", "no_answer"),
      postponed: countBy(dispRows, "disposition", "postponed"),
      cancelled: countBy(dispRows, "disposition", "cancelled"),
      wrong_number: countBy(dispRows, "disposition", "wrong_number"),
      duplicate: countBy(dispRows, "disposition", "duplicate"),
    };

    // Per-agent
    const perAgent = agents.map((a) => {
      const dispFor = (d: string) =>
        agentDispRows.filter((r) => r.assignedAgentId === a.id && r.disposition === d)
          .reduce((s, r) => s + r._count._all, 0);
      const statusFor = (st: string) =>
        agentStatusRows.filter((r) => r.assignedAgentId === a.id && r.status === st)
          .reduce((s, r) => s + r._count._all, 0);

      const confirmed = dispFor("confirmed");
      const cancelled = CANCEL_DISPOSITIONS.reduce((s, d) => s + dispFor(d), 0);
      const noAnswer = dispFor("no_answer");
      const postponed = dispFor("postponed");
      const handled = agentDispRows.filter((r) => r.assignedAgentId === a.id).reduce((s, r) => s + r._count._all, 0);
      const decided = confirmed + cancelled;
      return {
        id: a.id, name: a.name, username: a.username, active: a.active, role: a.role,
        handled, confirmed, cancelled, noAnswer, postponed,
        shipped: statusFor("SHIPPED"),
        inQueue: statusFor("PENDING"),
        confirmRate: decided > 0 ? Math.round((confirmed / decided) * 100) : null,
      };
    });

    return NextResponse.json({
      cutoverAt: cutoverAt ? cutoverAt.toISOString() : null,
      today: { confirmed: confirmedToday, shipped: shippedToday },
      week: { confirmed: confirmedWeek, orders: ordersWeek },
      funnel,
      dispositions,
      agents: perAgent,
    });
  } catch (error) {
    console.error("GET /api/agent-stats error:", error);
    return NextResponse.json({ error: "Failed to load stats" }, { status: 500 });
  }
}
