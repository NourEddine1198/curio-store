import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Admin key — MUST be set in environment. No default = no access.
const ADMIN_KEY = process.env.ADMIN_KEY;

// Valid status transitions
const VALID_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "RETURNED",
];

// ─── GET /api/orders/[orderNumber] — Order summary ───────
// PUBLIC but SAFE: only returns order number, status, and total.
// No personal data (name, phone, address) is exposed.
// Admin gets full details via the admin GET /api/orders endpoint.

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
        // Public display fields (needed for thank-you page)
        customerName: true,
        wilayaName: true,
        wilayaCode: true,
        deliveryType: true,
        deliveryPrice: true,
        // Sensitive data: admin only
        ...(isAdmin && {
          customerPhone: true,
          customerPhone2: true,
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
    const { status, notes, trackingCode, confirmedBy } = body;

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

      // CANCELLED → restore stock (from any previous status, since stock was taken at order creation)
      if (status === "CANCELLED" && existing.status !== "CANCELLED") {
        const items = await db.orderItem.findMany({
          where: { orderId: existing.id },
        });
        for (const item of items) {
          await db.product.update({
            where: { id: item.productId },
            data: { stock: { increment: item.quantity } },
          });
        }
      }
    }

    if (notes !== undefined) updateData.notes = notes;
    if (trackingCode !== undefined) updateData.trackingCode = trackingCode;

    // Neon HTTP adapter doesn't support transactions.
    // update() + include = implicit transaction → fails.
    // Split into: update (no include) then findUnique (with include).
    await db.order.update({
      where: { orderNumber: num },
      data: updateData,
    });

    const updated = await db.order.findUnique({
      where: { orderNumber: num },
      include: {
        items: {
          include: {
            product: { select: { name: true, slug: true, nameEn: true } },
          },
        },
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
