import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createParcel } from "@/lib/ecotrack";

const ADMIN_KEY = process.env.ADMIN_KEY || "curio-admin-2026";

// POST /api/orders/[orderNumber]/ship — Send order to Ecotrack
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  // Admin auth
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

    // Fetch order with items + product names (needed for the produit field)
    const order = await db.order.findUnique({
      where: { orderNumber: num },
      include: {
        items: {
          include: {
            product: { select: { name: true } },
          },
        },
      },
    });

    if (!order) {
      return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    }

    // Only allow shipping CONFIRMED or PROCESSING orders
    if (!["CONFIRMED", "PROCESSING"].includes(order.status)) {
      return NextResponse.json(
        { error: `لا يمكن شحن طلب في حالة "${order.status}". يجب أن يكون مأكد أو قيد التحضير.` },
        { status: 400 }
      );
    }

    // Send to Ecotrack
    const result = await createParcel(order);

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "فشل الإرسال إلى Ecotrack", rawResponse: result.rawResponse },
        { status: 502 }
      );
    }

    // Update order: save tracking code, set status to SHIPPED, set shippedAt
    const updateData: Record<string, unknown> = {
      status: "SHIPPED",
      shippedAt: new Date(),
    };

    if (result.trackingCode) {
      updateData.trackingCode = result.trackingCode;
    }

    // Store the full Ecotrack response for debugging
    updateData.webhookPayload = result.rawResponse;

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

    return NextResponse.json({
      success: true,
      trackingCode: result.trackingCode || null,
      order: updated,
    });
  } catch (error) {
    console.error("POST /api/orders/[orderNumber]/ship error:", error);
    return NextResponse.json(
      { error: "صار مشكل في شحن الطلب" },
      { status: 500 }
    );
  }
}
