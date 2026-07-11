import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { createParcel } from "@/lib/ecotrack";

// POST /api/agent/ship-bulk { orderNumbers: number[] }
// Sends several CONFIRMED orders to Ecotrack in one go (before the
// courier pickup). Sequential on purpose — kind to Ecotrack's API and
// each order gets its own clear result. Agent-authenticated.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const MAX_BATCH = 60;

export async function POST(request: NextRequest) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let nums: number[] = [];
  try {
    const body = await request.json();
    nums = Array.isArray(body?.orderNumbers) ? body.orderNumbers.map((n: unknown) => parseInt(String(n), 10)).filter((n: number) => !isNaN(n)) : [];
  } catch { /* fall through */ }
  if (!nums.length) return NextResponse.json({ error: "ما اخترتيش حتى طلب" }, { status: 400 });
  if (nums.length > MAX_BATCH) return NextResponse.json({ error: `برشة! ابعثي ${MAX_BATCH} كحد أقصى في المرة` }, { status: 400 });

  const agentRow = await db.agent.findUnique({ where: { id: agent.id }, select: { name: true } });
  const agentName = agentRow?.name || "agent";

  const results: { orderNumber: number; ok: boolean; trackingCode?: string; error?: string }[] = [];

  for (const num of nums) {
    try {
      const order = await db.order.findUnique({
        where: { orderNumber: num },
        include: { items: { include: { product: { select: { name: true } } } } },
      });
      if (!order) { results.push({ orderNumber: num, ok: false, error: "غير موجود" }); continue; }
      if (!["CONFIRMED", "PROCESSING"].includes(order.status)) {
        results.push({ orderNumber: num, ok: false, error: "ماشي مأكد" });
        continue;
      }
      if (order.trackingCode) { results.push({ orderNumber: num, ok: false, error: "عندو كود تتبع من قبل" }); continue; }

      const r = await createParcel(order);
      if (!r.success) { results.push({ orderNumber: num, ok: false, error: r.error || "فشل" }); continue; }

      const data: Record<string, unknown> = { status: "SHIPPED", shippedAt: new Date() };
      if (r.trackingCode) data.trackingCode = r.trackingCode;
      data.webhookPayload = r.rawResponse as never;
      await db.order.update({ where: { orderNumber: num }, data });
      await db.orderEvent.create({
        data: { orderId: order.id, kind: "status", status: "SHIPPED", actor: agentName, note: r.trackingCode ? `إيكوتراك — ${r.trackingCode}` : "إيكوتراك" },
      });
      results.push({ orderNumber: num, ok: true, trackingCode: r.trackingCode });
    } catch (e) {
      console.error(`ship-bulk #${num} error:`, e);
      results.push({ orderNumber: num, ok: false, error: "مشكل تقني" });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return NextResponse.json({ success: true, sent, failed: results.length - sent, results });
}
