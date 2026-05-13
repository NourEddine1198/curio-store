/**
 * Confirmi Voice Integration — Auto-dial customers with AI agent (Amina)
 *
 * WHAT THIS DOES: After an order is placed on curiodz.com, this fire-
 * and-forwards the order to Confirmi Voice. Confirmi schedules an
 * AI confirmation call ~60-120 seconds later — the customer's phone
 * rings, "Amina" walks them through their order in Algerian Darija.
 *
 * Pitch use case: founder hands curiodz.com to a prospect in a demo.
 * Prospect places an order with their own phone. ~1 minute later,
 * their phone rings and Amina confirms it in real Darija. Magic moment.
 *
 * SECURITY: HMAC-SHA256 signed body. Confirmi rejects unsigned/replayed
 * requests. The 5-min freshness window stops captured payloads from
 * being replayed later.
 *
 * NEVER blocks the customer — if Confirmi is unreachable, logs and
 * returns. The order is still persisted and OrderDZ still gets the
 * confirmation request.
 */

import { createHmac } from "crypto";

const CONFIRMI_URL = process.env.CONFIRMI_VOICE_URL || "";
const CONFIRMI_SECRET = process.env.CONFIRMI_VOICE_SECRET || "";
const CONFIRMI_SOURCE = process.env.CONFIRMI_VOICE_SOURCE || "curiodz";

interface OrderForConfirmiVoice {
  orderNumber: number;
  createdAt: Date;
  customerName: string;
  customerPhone: string;
  customerPhone2: string | null;
  wilayaCode: string;
  wilayaName: string;
  deliveryType: "HOME" | "OFFICE";
  address: string | null;
  officeName: string | null;
  officeCommune: string | null;
  deliveryPrice: number;
  total: number;
  notes: string | null;
  items: {
    productSlug: string;
    quantity: number;
    unitPrice: number;
  }[];
}

interface ConfirmiVoiceResult {
  success: boolean;
  scheduledDialId: string | null;
  status: string | null;
  error?: string;
}

export async function sendToConfirmiVoice(
  order: OrderForConfirmiVoice
): Promise<ConfirmiVoiceResult> {
  if (!CONFIRMI_URL || !CONFIRMI_SECRET) {
    console.log("[ConfirmiVoice] Skipping — env not configured");
    return { success: false, scheduledDialId: null, status: null, error: "not_configured" };
  }

  try {
    const body = {
      source: CONFIRMI_SOURCE,
      externalOrderId: String(order.orderNumber),
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerPhone2: order.customerPhone2 ?? null,
      wilayaCode: order.wilayaCode,
      wilayaName: order.wilayaName,
      deliveryType: order.deliveryType,
      address: order.address,
      officeName: order.officeName,
      officeCommune: order.officeCommune,
      deliveryPrice: order.deliveryPrice,
      total: order.total,
      notes: order.notes,
      items: order.items,
      createdAt: order.createdAt.toISOString(),
    };

    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", CONFIRMI_SECRET)
      .update(`${ts}.${raw}`)
      .digest("hex");

    // 2s timeout — Confirmi cold-start can take ~600ms, plenty of room.
    // Hard ceiling protects Netlify's 10s function budget on the Curio
    // side from a hung connection.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    let response: Response;
    try {
      response = await fetch(CONFIRMI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Confirmi-Timestamp": String(ts),
          "X-Confirmi-Signature": `sha256=${sig}`,
        },
        body: raw,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "<no body>");
      console.error(
        `[ConfirmiVoice] HTTP ${response.status}: ${errorText.slice(0, 200)}`
      );
      return {
        success: false,
        scheduledDialId: null,
        status: null,
        error: `http_${response.status}`,
      };
    }

    const data = await response.json();
    console.log(
      `[ConfirmiVoice] Order #${order.orderNumber} queued; status=${data.status} scheduledFor=${data.scheduledFor}`
    );
    return {
      success: true,
      scheduledDialId: data.scheduledDialId ?? null,
      status: data.status ?? null,
    };
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[ConfirmiVoice] Failed to send order:", msg);
    return {
      success: false,
      scheduledDialId: null,
      status: null,
      error: msg.includes("abort") ? "timeout" : "network_error",
    };
  }
}
