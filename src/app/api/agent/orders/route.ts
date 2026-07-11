import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import {
  ALL_STATUSES,
  EXPIRE_AFTER_MS,
  PENDING_STALE_MS,
  MAX_CALL_ATTEMPTS,
  type StatusKey,
} from "@/lib/order-status";

// ─────────────────────────────────────────────────────────────
// GET /api/agent/orders — the agent BOARD (OrderDZ-style).
//   ?status=all|PENDING|NO_ANSWER|...   one tab per status
//   ?q=...                              search (name / phone / wilaya / commune / #id)
//   ?page=1                             pagination (25 per page)
//   ?wilaya=16&deliveryType=HOME&product=roubla&from=...&to=...
// Returns { orders, counts, total, page, pages, dueNow }.
// Also runs the lazy auto-expire sweep (NO_ANSWER silent 3 days → EXPIRED).
// Agent-authenticated (Bearer token from /api/agents/login).
// ─────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const PER_PAGE = 25;

export async function GET(request: NextRequest) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = new URL(request.url).searchParams;
  const tab = (sp.get("status") || "all").toUpperCase();
  const q = (sp.get("q") || "").trim();
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const wilaya = (sp.get("wilaya") || "").trim();
  const deliveryType = (sp.get("deliveryType") || "").trim().toUpperCase();
  const product = (sp.get("product") || "").trim();
  const from = (sp.get("from") || "").trim();
  const to = (sp.get("to") || "").trim();

  try {
    // ── Cutover: only in-house-era orders appear on the board ──
    const [cutoverRow, reasonsRow] = await Promise.all([
      db.siteSetting.findUnique({ where: { key: "confirmationCutoverAt" } }),
      db.siteSetting.findUnique({ where: { key: "cancelReasons" } }),
    ]);
    const cutoverAt = cutoverRow?.value ? new Date(cutoverRow.value) : null;
    let cancelReasons: string[] = [];
    try { if (reasonsRow?.value) cancelReasons = JSON.parse(reasonsRow.value); } catch { /* keep empty */ }

    // ── Lazy auto-expire sweep (OrderDZ rule: 3 days silent → EXPIRED) ──
    // Runs on queue load; bounded; restores stock (unit back on the shelf).
    const expireBefore = new Date(Date.now() - EXPIRE_AFTER_MS);
    const toExpire = await db.order.findMany({
      where: {
        status: "NO_ANSWER",
        OR: [
          { lastCallAt: { lte: expireBefore } },
          { lastCallAt: null, updatedAt: { lte: expireBefore } },
        ],
      },
      select: { id: true, orderNumber: true, items: { select: { productId: true, quantity: true } } },
      take: 50,
    });
    for (const o of toExpire) {
      const res = await db.order.updateMany({
        where: { id: o.id, status: "NO_ANSWER" }, // guarded — don't clobber concurrent work
        data: { status: "EXPIRED" },
      });
      if (res.count > 0) {
        for (const it of o.items) {
          await db.product.update({ where: { id: it.productId }, data: { stock: { increment: it.quantity } } });
        }
        await db.orderEvent.create({
          data: { orderId: o.id, kind: "system", status: "EXPIRED", actor: "system", note: "انتهى أوتوماتيك: 3 أيام بلا محاولة جديدة" },
        });
      }
    }

    // ── Build the shared filter (everything EXCEPT the status tab) ──
    const AND: Record<string, unknown>[] = [];
    if (cutoverAt && !isNaN(cutoverAt.getTime())) AND.push({ createdAt: { gte: cutoverAt } });
    if (wilaya) AND.push({ wilayaCode: wilaya });
    if (deliveryType === "HOME" || deliveryType === "OFFICE") AND.push({ deliveryType });
    if (product) AND.push({ items: { some: { product: { slug: product } } } });
    if (from) { const d = new Date(from); if (!isNaN(d.getTime())) AND.push({ createdAt: { gte: d } }); }
    if (to) { const d = new Date(to + "T23:59:59"); if (!isNaN(d.getTime())) AND.push({ createdAt: { lte: d } }); }

    if (q) {
      const digits = q.replace(/\D/g, "");
      const or: Record<string, unknown>[] = [
        { customerName: { contains: q, mode: "insensitive" } },
        { wilayaName: { contains: q } },
        { commune: { contains: q, mode: "insensitive" } },
        { officeCommune: { contains: q, mode: "insensitive" } },
        { officeName: { contains: q, mode: "insensitive" } },
      ];
      if (digits.length >= 6) {
        or.push({ customerPhone: { contains: digits } });
        or.push({ customerPhone2: { contains: digits } });
      } else if (digits.length > 0 && digits === q) {
        const n = parseInt(digits, 10);
        if (!isNaN(n)) or.push({ orderNumber: n });
      }
      AND.push({ OR: or });
    }
    const baseWhere = AND.length ? { AND } : {};

    // ── Tab filter ──
    const isTab = (ALL_STATUSES as readonly string[]).includes(tab);
    const tabStatuses: StatusKey[] | null = !isTab
      ? null
      : tab === "CONFIRMED"
        ? (["CONFIRMED", "PROCESSING"] as StatusKey[]) // legacy PROCESSING folded in
        : ([tab] as StatusKey[]);
    const where = tabStatuses ? { ...baseWhere, status: { in: tabStatuses as never } } : baseWhere;

    // ── Sort per tab (work order matters) ──
    const orderBy =
      tab === "PENDING"
        ? [{ createdAt: "asc" as const }] // FIFO — oldest client waits longest
        : tab === "NO_ANSWER" || tab === "CALLBACK"
          ? [{ nextCallAt: { sort: "asc" as const, nulls: "first" as const } }, { createdAt: "asc" as const }]
          : [{ createdAt: "desc" as const }];

    // ── Counts for every tab (one groupBy, respects search + filters) ──
    const [countRows, orders] = await Promise.all([
      db.order.groupBy({ by: ["status"], where: baseWhere, _count: { _all: true } }),
      db.order.findMany({
        where,
        orderBy,
        skip: (page - 1) * PER_PAGE,
        take: PER_PAGE,
        select: {
          orderNumber: true, createdAt: true, status: true, total: true,
          customerName: true, customerPhone: true, wilayaName: true, wilayaCode: true,
          deliveryType: true, commune: true, officeName: true, officeCommune: true,
          callAttempts: true, lastCallAt: true, nextCallAt: true, callbackNote: true,
          cancelReason: true, trackingCode: true, notes: true,
          items: { select: { quantity: true, product: { select: { name: true, slug: true } } } },
          _count: { select: { events: { where: { kind: "comment" } } } },
        },
      }),
    ]);

    const counts: Record<string, number> = {};
    let all = 0;
    for (const r of countRows) {
      counts[r.status] = (counts[r.status] || 0) + r._count._all;
      all += r._count._all;
    }
    counts.CONFIRMED = (counts.CONFIRMED || 0) + (counts.PROCESSING || 0);
    counts.ALL = all;
    const total = !tabStatuses ? all : counts[tab] || 0;

    // ── "Previous orders" chip: same phone across the whole store ──
    const phones = Array.from(new Set(orders.map((o) => o.customerPhone).filter(Boolean)));
    const phoneRows = phones.length
      ? await db.order.groupBy({ by: ["customerPhone"], where: { customerPhone: { in: phones } }, _count: { _all: true } })
      : [];
    const phoneCount: Record<string, number> = {};
    for (const r of phoneRows) phoneCount[r.customerPhone] = r._count._all;

    // ── Attention (red dot): DELIVERY_FAILED with no follow-up yet ──
    const failedIds = orders.filter((o) => o.status === "DELIVERY_FAILED").map((o) => o.orderNumber);
    const failedNeedsAction = new Set<number>(failedIds);
    if (failedIds.length) {
      const failedOrders = await db.order.findMany({
        where: { orderNumber: { in: failedIds } },
        select: {
          orderNumber: true,
          events: { orderBy: { createdAt: "desc" }, take: 1, select: { kind: true } },
        },
      });
      for (const fo of failedOrders) {
        const last = fo.events[0];
        if (last && (last.kind === "comment" || last.kind === "attempt")) failedNeedsAction.delete(fo.orderNumber);
      }
    }

    const now = Date.now();
    const rows = orders.map((o) => {
      let attention = false;
      if ((o.status === "NO_ANSWER" || o.status === "CALLBACK") && o.nextCallAt && o.nextCallAt.getTime() <= now) attention = true;
      if (o.status === "PENDING" && now - o.createdAt.getTime() >= PENDING_STALE_MS) attention = true;
      if (o.status === "DELIVERY_FAILED" && failedNeedsAction.has(o.orderNumber)) attention = true;
      if (o.status === "EXPIRED" && (o.callAttempts || 0) < MAX_CALL_ATTEMPTS) attention = true;
      return {
        ...o,
        commentsCount: o._count.events,
        prevOrders: Math.max(0, (phoneCount[o.customerPhone] || 1) - 1),
        attention,
        _count: undefined,
      };
    });

    // Orders due for a call right now (badge in the header)
    const dueNow =
      (await db.order.count({
        where: { ...baseWhere, status: { in: ["NO_ANSWER", "CALLBACK"] as never }, nextCallAt: { lte: new Date() } },
      })) + (counts.DELIVERY_FAILED || 0);

    return NextResponse.json({
      orders: rows,
      counts,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / PER_PAGE)),
      perPage: PER_PAGE,
      dueNow,
      cancelReasons,
      expired: toExpire.length || undefined,
    });
  } catch (error) {
    console.error("GET /api/agent/orders error:", error);
    return NextResponse.json({ error: "صار مشكل في تحميل الطلبات" }, { status: 500 });
  }
}
