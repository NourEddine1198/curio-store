import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * WEBHOOK: OrderDZ -> Curio
 *
 * WHAT THIS DOES: OrderDZ calls this URL after they call a customer.
 * If the customer confirmed, the order status becomes CONFIRMED.
 * If cancelled/unreachable, it becomes CANCELLED and stock is restored.
 *
 * URL to give OrderDZ:
 *   https://stirring-marigold-3dd8e9.netlify.app/api/webhooks/confirmation
 *
 * Protected by a secret key so only OrderDZ can call it.
 */

const WEBHOOK_SECRET = process.env.ORDERDZ_WEBHOOK_SECRET || "";

export async function POST(request: NextRequest) {
  // --- Validate the secret ---
  const secret =
    request.headers.get("x-webhook-secret") ||
    request.headers.get("authorization")?.replace("Bearer ", "");

  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    console.warn("[Webhook] Rejected — invalid or missing secret");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // ──────────────────────────────────────────────────────────
    // ADJUST field names when OrderDZ sends their API docs.
    // ──────────────────────────────────────────────────────────
    const orderRef =
      body.reference || body.order_id || body.order_number;
    const result = (
      body.status ||
      body.result ||
      body.confirmation_status ||
      ""
    ).toLowerCase();

    if (!orderRef) {
      return NextResponse.json(
        { error: "Missing order reference" },
        { status: 400 }
      );
    }
    if (!result) {
      return NextResponse.json(
        { error: "Missing confirmation result" },
        { status: 400 }
      );
    }

    // --- Find the order (by order number or external ID) ---
    const orderNumber = parseInt(orderRef, 10);

    const order = !isNaN(orderNumber)
      ? await db.order.findUnique({ where: { orderNumber } })
      : await db.order.findFirst({ where: { externalId: orderRef } });

    if (!order) {
      console.warn(`[Webhook] Order not found: ${orderRef}`);
      return NextResponse.json(
        { error: "Order not found" },
        { status: 404 }
      );
    }

    // --- Map their result to our status ---
    let newStatus: "CONFIRMED" | "CANCELLED";

    const confirmed = [
      "confirmed",
      "confirm",
      "oui",
      "yes",
      "approved",
    ];
    const cancelled = [
      "cancelled",
      "cancel",
      "no",
      "rejected",
      "no_answer",
      "unreachable",
      "annule",
    ];

    if (confirmed.includes(result)) {
      newStatus = "CONFIRMED";
    } else if (cancelled.includes(result)) {
      newStatus = "CANCELLED";
    } else {
      console.warn(
        `[Webhook] Unknown result "${result}" for order #${order.orderNumber}`
      );
      await db.order.update({
        where: { id: order.id },
        data: { webhookPayload: body },
      });
      return NextResponse.json(
        { error: `Unknown result: ${result}` },
        { status: 400 }
      );
    }

    // --- Update the order ---
    const updateData: Record<string, unknown> = {
      status: newStatus,
      confirmedBy: "orderdz",
      webhookPayload: body,
    };

    if (newStatus === "CONFIRMED") {
      updateData.confirmedAt = new Date();
    }

    // If cancelling, restore stock so those games can be sold again
    if (newStatus === "CANCELLED" && order.status !== "CANCELLED") {
      const items = await db.orderItem.findMany({
        where: { orderId: order.id },
      });
      for (const item of items) {
        await db.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }
    }

    await db.order.update({
      where: { id: order.id },
      data: updateData,
    });

    console.log(
      `[Webhook] Order #${order.orderNumber} -> ${newStatus} (by OrderDZ)`
    );

    return NextResponse.json({
      success: true,
      orderNumber: order.orderNumber,
      status: newStatus,
    });
  } catch (error) {
    console.error("[Webhook] Error processing confirmation:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
