/**
 * OrderDZ Integration — Auto-send orders to confirmation company
 *
 * WHAT THIS DOES: When a customer places an order on curiodz.com, this
 * automatically sends the order to OrderDZ so they can call the customer
 * and confirm it. Like auto-forwarding an email to your receptionist.
 *
 * STATUS: Skeleton ready — update field names when OrderDZ sends their API docs.
 */

const ORDERDZ_API_URL = process.env.ORDERDZ_API_URL || "";
const ORDERDZ_API_KEY = process.env.ORDERDZ_API_KEY || "";

interface OrderForConfirmation {
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  customerPhone2: string | null;
  wilayaName: string;
  wilayaCode: string;
  deliveryType: string;
  address: string | null;
  officeName: string | null;
  officeCommune: string | null;
  total: number;
  items: {
    productName: string;
    quantity: number;
    unitPrice: number;
  }[];
}

interface OrderDZResult {
  success: boolean;
  externalId: string | null;
  error?: string;
}

/**
 * Send a new order to OrderDZ for phone confirmation.
 *
 * NEVER blocks the customer — if OrderDZ is down, the order still saves normally.
 * Returns the external ID from OrderDZ if successful, null if failed.
 */
export async function sendToOrderDZ(
  order: OrderForConfirmation
): Promise<OrderDZResult> {
  // If not configured yet, skip silently (expected until we get API details)
  if (!ORDERDZ_API_URL || !ORDERDZ_API_KEY) {
    console.log("[OrderDZ] Skipping — API not configured yet");
    return { success: false, externalId: null, error: "not_configured" };
  }

  try {
    // ──────────────────────────────────────────────────────────────
    // ADJUST THIS when OrderDZ sends their API docs.
    // The field names below are best guesses. Change to match their spec.
    // ──────────────────────────────────────────────────────────────
    const payload = {
      reference: String(order.orderNumber),
      customer_name: order.customerName,
      customer_phone: order.customerPhone,
      customer_phone2: order.customerPhone2,
      wilaya: order.wilayaName,
      wilaya_code: order.wilayaCode,
      delivery_type: order.deliveryType.toLowerCase(),
      address: order.address || order.officeName || "",
      commune: order.officeCommune || "",
      total_price: order.total,
      products: order.items.map((item) => ({
        name: item.productName,
        quantity: item.quantity,
        price: item.unitPrice,
      })),
    };

    const response = await fetch(ORDERDZ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ORDERDZ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[OrderDZ] API error ${response.status}: ${errorText}`);
      return {
        success: false,
        externalId: null,
        error: `api_error_${response.status}`,
      };
    }

    const data = await response.json();

    // ADJUST: Their response field for the order ID may differ
    const externalId =
      data.id || data.order_id || data.external_id || null;

    console.log(
      `[OrderDZ] Order #${order.orderNumber} sent. External ID: ${externalId}`
    );
    return { success: true, externalId };
  } catch (error) {
    console.error("[OrderDZ] Failed to send order:", error);
    return { success: false, externalId: null, error: "network_error" };
  }
}
