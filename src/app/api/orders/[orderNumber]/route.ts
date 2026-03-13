import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Simple admin password — checked via X-Admin-Key header
const ADMIN_KEY = process.env.ADMIN_KEY || "curio-admin-2026";

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

// ─── GET /api/orders/[orderNumber] — Order details (public) ───

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  try {
    const { orderNumber } = await params;
    const num = parseInt(orderNumber, 10);

    if (isNaN(num)) {
      return NextResponse.json({ error: "رقم الطلب غير صحيح" }, { status: 400 });
    }

    const order = await db.order.findUnique({
      where: { orderNumber: num },
      select: {
        orderNumber: true,
        status: true,
        customerName: true,
        customerPhone: true,
        wilayaName: true,
        wilayaCode: true,
        deliveryType: true,
        deliveryPrice: true,
        address: true,
        officeName: true,
        officeCommune: true,
        subtotal: true,
        total: true,
        createdAt: true,
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
  // Check admin key
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

      // If cancelling, restore stock
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

    const updated = await db.order.update({
      where: { orderNumber: num },
      data: updateData,
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
    const debugMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "صار مشكل في تحديث الطلب", debug: debugMsg },
      { status: 500 }
    );
  }
}
