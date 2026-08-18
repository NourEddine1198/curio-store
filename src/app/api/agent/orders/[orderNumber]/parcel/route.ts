import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";
import { fetchParcelDetails } from "@/lib/ecotrack";
import { triageParcel } from "@/lib/suivi";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

// ─────────────────────────────────────────────────────────────
// The suivi feed for ONE order.
//   GET  — the cached parcel (instant; written by the cron)
//   POST — force a live refresh of just this parcel, for when the
//          agent is on the phone with the station and needs this
//          second's truth. Rate-limited per parcel.
// ─────────────────────────────────────────────────────────────

const MIN_GAP_MS = 60 * 1000; // one live refresh per parcel per minute

async function loadOrder(num: number) {
  return db.order.findUnique({
    where: { orderNumber: num },
    select: { id: true, orderNumber: true, trackingCode: true, status: true, shippedAt: true },
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  try {
    const order = await loadOrder(num);
    if (!order) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    if (!order.trackingCode) return NextResponse.json({ parcel: null, reason: "no_tracking" });

    const parcel = await db.parcelTracking.findUnique({ where: { trackingCode: order.trackingCode } });
    return NextResponse.json({ parcel, reason: parcel ? null : "not_synced_yet" });
  } catch (error) {
    console.error("GET /api/agent/orders/[n]/parcel error:", error);
    return NextResponse.json({ error: "ما نجمناش نجيبو التتبع" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ orderNumber: string }> }) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const num = parseInt((await params).orderNumber, 10);
  if (isNaN(num)) return NextResponse.json({ error: "رقم غير صحيح" }, { status: 400 });

  try {
    const order = await loadOrder(num);
    if (!order) return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    if (!order.trackingCode) {
      return NextResponse.json({ error: "هذا الطلب مازال ما تبعثش لإيكوتراك" }, { status: 400 });
    }

    const existing = await db.parcelTracking.findUnique({ where: { trackingCode: order.trackingCode } });
    if (existing && Date.now() - existing.syncedAt.getTime() < MIN_GAP_MS) {
      return NextResponse.json({ parcel: existing, throttled: true });
    }

    const res = await fetchParcelDetails([order.trackingCode]);
    const p = res.parcels[order.trackingCode];
    if (!res.ok || !p) {
      return NextResponse.json(
        { error: res.error || "إيكوتراك ما عطاناش معلومات على هذا الكولي" },
        { status: 502 }
      );
    }

    const t = triageParcel(p, new Date(), order.shippedAt);
    const data = {
      orderId: order.id,
      status: p.status,
      globalStatus: p.globalStatus,
      currentStation: p.currentStation,
      driverName: p.driverName,
      driverPhone: p.driverPhone,
      stopDesk: p.stopDesk,
      montant: p.montant,
      tarifLivraison: p.tarifLivraison,
      tarifRetour: p.tarifRetour,
      activity: p.activity as unknown as object,
      comments: p.comments as unknown as object,
      attemptCount: t.attemptCount,
      lastMoveAt: t.lastMoveAt,
      lastCommentAt: t.lastCommentAt,
      postponedTo: t.postponedTo,
      alertLevel: t.level,
      alertReason: t.reason || null,
      syncedAt: new Date(),
    };

    // Read-then-write (no upsert — Neon HTTP has no transactions).
    const parcel = existing
      ? await db.parcelTracking.update({ where: { id: existing.id }, data })
      : await db.parcelTracking.create({ data: { trackingCode: order.trackingCode, ...data } });

    return NextResponse.json({ parcel });
  } catch (error) {
    console.error("POST /api/agent/orders/[n]/parcel error:", error);
    return NextResponse.json({ error: "فشل تحديث التتبع" }, { status: 500 });
  }
}
