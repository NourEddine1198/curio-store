import type { Order, OrderItem, Product } from "@/generated/prisma/client";

// Ecotrack API client — sends parcels to Ecotrack for shipping

const BASE_URL = "https://anderson-ecommerce.ecotrack.dz/api/v1";

type OrderWithItems = Order & {
  items: (OrderItem & { product: Pick<Product, "name"> })[];
};

interface EcotrackPayload {
  nom_client: string;
  telephone: string;
  telephone_2?: string;
  adresse: string;
  commune: string;
  code_wilaya: number;
  montant: number;
  type: number;
  stop_desk: number;
  reference: string;
  produit: string;
  remarque?: string;
}

interface EcotrackResult {
  success: boolean;
  trackingCode?: string;
  error?: string;
  rawResponse?: unknown;
}

export async function createParcel(order: OrderWithItems): Promise<EcotrackResult> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) {
    return { success: false, error: "ECOTRACK_TOKEN is not set in environment variables" };
  }

  // Build product description from items
  const produit = order.items
    .map((item) => item.product.name + (item.quantity > 1 ? ` x${item.quantity}` : ""))
    .join(", ");

  // Map our order to Ecotrack's expected fields
  const isOffice = order.deliveryType === "OFFICE";

  const payload: EcotrackPayload = {
    nom_client: order.customerName,
    telephone: order.customerPhone,
    adresse: isOffice ? (order.officeName || "") : (order.address || ""),
    commune: order.officeCommune || "",
    code_wilaya: parseInt(order.wilayaCode, 10),
    montant: order.total,
    type: 1, // 1 = Livraison (standard delivery)
    stop_desk: isOffice ? 1 : 0,
    reference: String(order.orderNumber),
    produit,
  };

  if (order.customerPhone2) {
    payload.telephone_2 = order.customerPhone2;
  }
  if (order.notes) {
    payload.remarque = order.notes;
  }

  try {
    const res = await fetch(`${BASE_URL}/create/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      // Ecotrack returned an error status
      const errorMsg =
        typeof data === "object" && data !== null
          ? data.message || data.error || JSON.stringify(data)
          : String(data);
      return { success: false, error: `Ecotrack error (${res.status}): ${errorMsg}`, rawResponse: data };
    }

    // Extract tracking code from Ecotrack's response
    // Common fields: data.tracking, data.id, data.code — adjust if their response differs
    const tracking =
      data?.tracking || data?.data?.tracking || data?.code || data?.data?.code || data?.id || data?.data?.id;

    if (!tracking) {
      // Request succeeded but we couldn't find a tracking code — still save what we got
      return {
        success: true,
        trackingCode: undefined,
        error: "Order sent but tracking code not found in response",
        rawResponse: data,
      };
    }

    return { success: true, trackingCode: String(tracking), rawResponse: data };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Network error: ${message}` };
  }
}
