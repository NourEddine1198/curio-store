import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ALL_STATUSES, stockMove } from "@/lib/order-status";

// Admin key — MUST be set in environment. No default = no access.
const ADMIN_KEY = process.env.ADMIN_KEY;

// The admin can set any status (the agent console is more restricted).
const VALID_STATUSES: readonly string[] = ALL_STATUSES;

// ─── GET /api/orders/[orderNumber] — Order summary ───────
// PUBLIC but SAFE: returns only non-identifying fields (order number, status,
// total, delivery type/price, item names). Customer identity + location
// (name, wilaya, phone, address) are ADMIN-ONLY — otherwise the sequential
// orderNumber could be enumerated to harvest every buyer's name + region.
// Admin gets full details here (with x-admin-key) or via GET /api/orders.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  try {
    const { orderNumber } = await params;
    const num = parseInt(orderNumber, 10);

    if (isNaN(num)) {
      return NextResponse.json({ error: "رقم الطلب غير صحيح" }, { status: 400 });
    }

    // Check if this is an admin request (full details) or public (safe summary)
    const key = request.headers.get("x-admin-key");
    const isAdmin = ADMIN_KEY && key === ADMIN_KEY;

    const order = await db.order.findUnique({
      where: { orderNumber: num },
      select: {
        orderNumber: true,
        status: true,
        total: true,
        createdAt: true,
        deliveryType: true,
        deliveryPrice: true,
        // Identity + location + everything else: ADMIN ONLY.
        ...(isAdmin && {
          customerName: true,
          wilayaName: true,
          wilayaCode: true,
          customerPhone: true,
          customerPhone2: true,
          commune: true,
          address: true,
          officeName: true,
          officeCommune: true,
          subtotal: true,
          notes: true,
          confirmedAt: true,
          confirmedBy: true,
          shippedAt: true,
          trackingCode: true,
          ip: true,
          // Which confirmation agent owns this order — the admin's dropdown
          // reads it to show the current owner before changing it.
          assignedAgentId: true,
          assignedAgent: { select: { id: true, name: true } },
        }),
        items: {
          select: {
            quantity: true,
            unitPrice: true,
            product: {
              select: { name: true, slug: true },
            },
          },
        },
      },
    });

    if (!order) {
      return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    }

    return NextResponse.json(order);
  } catch (error) {
    console.error("GET /api/orders/[orderNumber] error:", error);
    return NextResponse.json(
      { error: "صار مشكل في تحميل الطلب" },
      { status: 500 }
    );
  }
}

// ─── PATCH /api/orders/[orderNumber] — Update order (admin) ───

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  // Admin key MUST be set in env — no default, no fallback
  if (!ADMIN_KEY) {
    console.error("ADMIN_KEY env var not set — admin access disabled");
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  const key = request.headers.get("x-admin-key");
  if (key !== ADMIN_KEY) {
    return NextResponse.json({ error: "غير مصرح" }, { status: 401 });
  }

  try {
    const { orderNumber } = await params;
    const num = parseInt(orderNumber, 10);

    if (isNaN(num)) {
      return NextResponse.json({ error: "رقم الطلب غير صحيح" }, { status: 400 });
    }

    const body = await request.json();
    const { status, notes, trackingCode, confirmedBy, assignedAgentId } = body;

    // Find the order first
    const existing = await db.order.findUnique({
      where: { orderNumber: num },
    });

    if (!existing) {
      return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    }

    // Build update data
    const updateData: Record<string, unknown> = {};

    if (status && VALID_STATUSES.includes(status)) {
      updateData.status = status;

      // Auto-set timestamps based on status
      if (status === "CONFIRMED" && !existing.confirmedAt) {
        updateData.confirmedAt = new Date();
        if (confirmedBy) updateData.confirmedBy = confirmedBy;
      }
      if (status === "SHIPPED" && !existing.shippedAt) {
        updateData.shippedAt = new Date();
      }
      if (status === "DELIVERED" && !existing.deliveredAt) {
        updateData.deliveredAt = new Date();
      }
      if (status === "RETURNED" && !existing.returnedAt) {
        updateData.returnedAt = new Date();
      }

      // Stock is decremented on order creation now, not on confirmation.
      // Shared family rule (same as the agent console): entering
      // CANCELLED/EXPIRED/WRONG/DUPLICATE restores stock once; leaving
      // that family takes it again. Prevents double-restocks.
      const move = stockMove(existing.status, status);
      if (move) {
        const items = await db.orderItem.findMany({
          where: { orderId: existing.id },
        });
        for (const item of items) {
          await db.product.update({
            where: { id: item.productId },
            data: { stock: move === "restore" ? { increment: item.quantity } : { decrement: item.quantity } },
          });
        }
      }
    }

    if (notes !== undefined) updateData.notes = notes;
    if (trackingCode !== undefined) updateData.trackingCode = trackingCode;

    // ── Move the order to a different confirmation agent ──
    // Orders route themselves to the default agent at checkout; this is the
    // owner's override for the exceptions ("this one is mine, not hers").
    // The agent console scopes every board and every action to the assigned
    // agent, so this single field decides who can see and call this customer.
    // "" / null hands the order back to nobody — it then shows on no board.
    let agentMoveNote: string | null = null;
    if (assignedAgentId !== undefined) {
      const wantedId = assignedAgentId ? String(assignedAgentId) : null;
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
      if (wantedId !== existing.assignedAgentId) {
        const prev = existing.assignedAgentId
          ? await db.agent.findUnique({ where: { id: existing.assignedAgentId }, select: { name: true } })
          : null;
        updateData.assignedAgentId = wantedId;
        agentMoveNote = `تحويل الطلب: ${prev?.name || "بلا عون"} ← ${wantedName}`;
      }
    }

    // Neon HTTP adapter doesn't support transactions.
    // update() + include = implicit transaction → fails.
    // Split into: update (no include) then findUnique (with include).
    await db.order.update({
      where: { orderNumber: num },
      data: updateData,
    });

    // Audit trail for the agent console's timeline
    if (updateData.status && updateData.status !== existing.status) {
      await db.orderEvent.create({
        data: { orderId: existing.id, kind: "status", status: String(updateData.status), actor: "owner" },
      });
    }
    if (agentMoveNote) {
      await db.orderEvent.create({
        data: { orderId: existing.id, kind: "system", note: agentMoveNote, actor: "owner" },
      });
    }

    const updated = await db.order.findUnique({
      where: { orderNumber: num },
      include: {
        items: {
          include: {
            product: { select: { name: true, slug: true, nameEn: true } },
          },
        },
        assignedAgent: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ success: true, order: updated });
  } catch (error) {
    console.error("PATCH /api/orders/[orderNumber] error:", error);
    return NextResponse.json(
      { error: "صار مشكل في تحديث الطلب" },
      { status: 500 }
    );
  }
}
