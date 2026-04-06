/**
 * OrderDZ Integration — Auto-send orders to confirmation company
 *
 * WHAT THIS DOES: When a customer places an order on curiodz.com, this
 * automatically sends the order to OrderDZ so they can call the customer
 * and confirm it (COD confirmation). Like auto-forwarding an order to
 * your call center receptionist.
 *
 * API: https://orderdz.com/api/v1/orders/create
 * Auth: Bearer token
 */

const ORDERDZ_BASE_URL =
  process.env.ORDERDZ_API_URL || "https://orderdz.com/api/v1";
const ORDERDZ_API_KEY = process.env.ORDERDZ_API_KEY || "";

// ─── SKU Mapping ─────────────────────────────────────────────
// Maps our product slugs to OrderDZ's internal SKU codes.
// If we add a new product, add its SKU here too.
const SKU_MAP: Record<string, string> = {
  "goul-bla-matgoul": "PRDPQBZQ",
  roubla: "PRDAISNA",
  "eid-2026-bundle": "PRDAYLRL",
};

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
  deliveryPrice: number;
  total: number;
  notes: string | null;
  items: {
    productName: string;
    slug: string;
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
  // If not configured, skip silently
  if (!ORDERDZ_API_KEY) {
    console.log("[OrderDZ] Skipping — API key not configured");
    return { success: false, externalId: null, error: "not_configured" };
  }

  try {
    const payload = {
      order_id: String(order.orderNumber),
      customer_name: order.customerName,
      customer_phone: order.customerPhone,
      customer_phone2: order.customerPhone2 || "",
      state_id: parseInt(order.wilayaCode, 10),
      state_name: order.wilayaName,
      city_name: order.officeCommune || "",
      customer_address:
        order.address || order.officeName || "",
      stop_desk: order.deliveryType === "OFFICE" ? 1 : 0,
      shipping_price: order.deliveryPrice,
      total: order.total,
      notes: order.notes || "",
      items: order.items.map((item) => ({
        item_name: item.productName,
        price: item.unitPrice,
        quantity: item.quantity,
        sku: SKU_MAP[item.slug] || "",
        variants: "",
        offer: "",
      })),
    };

    const url = `${ORDERDZ_BASE_URL}/orders/create`;

    const response = await fetch(url, {
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
        error: `api_error_${response.status}: ${errorText}`,
      };
    }

    const data = await response.json();

    // Check if OrderDZ actually accepted the order (not just HTTP 200)
    if (data.success === false) {
      // Log the FULL response so we can debug validation errors
      console.error(`[OrderDZ] Rejected order #${order.orderNumber}:`, JSON.stringify(data));
      // Build a detailed error message including validation details
      const details = data.errors
        ? JSON.stringify(data.errors)
        : data.data
          ? JSON.stringify(data.data)
          : data.message || "unknown";
      return {
        success: false,
        externalId: null,
        error: `rejected: ${details}`,
      };
    }

    // Extract OrderDZ's ID from their response
    const externalId =
      data.data?.order_id ||
      data.data?.id ||
      data.order_id ||
      data.id ||
      null;

    console.log(
      `[OrderDZ] Order #${order.orderNumber} sent successfully. External ID: ${externalId}`
    );
    return { success: true, externalId: String(externalId) };
  } catch (error) {
    console.error("[OrderDZ] Failed to send order:", error);
    return { success: false, externalId: null, error: "network_error" };
  }
}
