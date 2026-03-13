import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Returns order details by orderNumber (for confirmation page)
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
        wilayaName: true,
        deliveryType: true,
        deliveryPrice: true,
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
