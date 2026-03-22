import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendToOrderDZ } from "@/lib/orderdz";

// Admin key — MUST be set in environment. No default = no access.
const ADMIN_KEY = process.env.ADMIN_KEY;

// POST /api/orders/[orderNumber]/orderdz — Push order to OrderDZ for confirmation
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  // Admin auth — key must be set in env, no fallback
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

    // Fetch order with items + product info (slug needed for SKU mapping)
    const order = await db.order.findUnique({
      where: { orderNumber: num },
      include: {
        items: {
          include: {
            product: { select: { name: true, slug: true } },
          },
        },
      },
    });

    if (!order) {
      return NextResponse.json({ error: "الطلب غير موجود" }, { status: 404 });
    }

    // No status restriction — allow pushing any order (old orders may be in various states)

    // Build the items array that sendToOrderDZ expects
    const confirmationItems = order.items.map((item) => ({
      productName: item.product.name,
      slug: item.product.slug,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    }));

    // Send to OrderDZ
    const result = await sendToOrderDZ({
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerPhone2: order.customerPhone2,
      wilayaName: order.wilayaName,
      wilayaCode: order.wilayaCode,
      deliveryType: order.deliveryType,
      address: order.address,
      officeName: order.officeName,
      officeCommune: order.officeCommune,
      deliveryPrice: order.deliveryPrice,
      total: order.total,
      notes: order.notes,
      items: confirmationItems,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "فشل الإرسال إلى OrderDZ" },
        { status: 502 }
      );
    }

    // Save external ID if returned
    if (result.externalId) {
      await db.order.update({
        where: { orderNumber: num },
        data: { externalId: result.externalId },
      });
    }

    // Re-fetch with full includes for the response
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
      externalId: result.externalId || null,
      order: updated,
    });
  } catch (error) {
    console.error("POST /api/orders/[orderNumber]/orderdz error:", error);
    return NextResponse.json(
      { error: "صار مشكل في إرسال الطلب إلى OrderDZ" },
      { status: 500 }
    );
  }
}
