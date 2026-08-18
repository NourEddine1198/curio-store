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
    adresse: isOffice
      ? (order.officeName || order.officeCommune || "")
      : (order.address || ""),
    // Ecotrack needs the real baladiya name. For HOME use the chosen commune
    // (fall back to wilayaName only for legacy orders saved before this field
    // existed). For OFFICE use the stop-desk commune.
    commune: isOffice
      ? (order.officeCommune || "")
      : (order.commune || order.wilayaName),
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

// ─────────────────────────────────────────────────────────────
// READ-ONLY status lookups (for the Command Center dashboard).
//
// These only READ from Ecotrack — they never create or modify a
// parcel. The dashboard uses them to learn the true delivery
// outcome (delivered / returned / in transit), which our own
// database does NOT record. We do this independently of the live
// WhatsApp tracker — we never touch it.
// ─────────────────────────────────────────────────────────────

export type DeliveryBucket =
  | "delivered"
  | "returned"
  | "in_transit"
  | "cancelled"
  | "unknown";

/**
 * Map an Ecotrack status string (French slug, sometimes accented)
 * to a simple business bucket. Accent- and case-insensitive.
 *
 * Examples seen from Ecotrack:
 *   livré / livre / livré_non_encaissé / livré_et_encaissé  → delivered
 *   retourné / retour_au_vendeur / retour_vers_centre        → returned
 *   en_livraison / vers_wilaya / recu_par_le_centre          → in_transit
 *   annulé                                                   → cancelled
 */
export function bucketEcotrackStatus(raw: string): DeliveryBucket {
  const s = (raw || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip accents → "livré" becomes "livre"

  if (!s) return "unknown";
  // "livre…" = delivered. Note "en_livraison" starts with "en", so it is
  // correctly NOT matched here (it's still out for delivery = in transit).
  if (s.startsWith("livre")) return "delivered";
  if (s.startsWith("retour") || s.includes("retourn")) return "returned";
  if (s.includes("annul")) return "cancelled";
  return "in_transit";
}

/** Best-effort extraction of the status string from one tracking's payload. */
function extractStatus(info: unknown): string {
  if (typeof info === "string") return info;
  if (!info || typeof info !== "object") return "";
  const o = info as Record<string, unknown>;
  const direct =
    (o.status as string) ||
    (o.statut as string) ||
    (o.last_status as string) ||
    (o.OrderStatus as string);
  if (direct) return String(direct);
  // Fall back to the latest activity entry if present
  const activity = o.activity;
  if (Array.isArray(activity) && activity.length) {
    const last = activity[activity.length - 1] as Record<string, unknown>;
    return String(last?.status || last?.event || last?.label || "");
  }
  return "";
}

export interface EcotrackStatusResult {
  ok: boolean;
  error?: string;
  /** tracking code → raw status string */
  statuses: Record<string, string>;
  /** how many tracking codes we successfully resolved */
  resolved: number;
}

/**
 * Fetch current delivery status for a list of tracking codes.
 * Uses the read-only GET /get/orders/status endpoint (up to 100 per call).
 * Token is passed as the `api_token` query param (Ecotrack's read auth).
 */
export async function fetchOrderStatuses(
  trackings: string[]
): Promise<EcotrackStatusResult> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) {
    return { ok: false, error: "ECOTRACK_TOKEN is not set", statuses: {}, resolved: 0 };
  }

  const unique = Array.from(new Set(trackings.filter(Boolean)));
  if (unique.length === 0) return { ok: true, statuses: {}, resolved: 0 };

  const statuses: Record<string, string> = {};

  try {
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const url =
        `${BASE_URL}/get/orders/status` +
        `?api_token=${encodeURIComponent(token)}` +
        `&trackings=${encodeURIComponent(chunk.join(","))}`;

      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        return {
          ok: false,
          error: `Ecotrack status error (${res.status})`,
          statuses,
          resolved: Object.keys(statuses).length,
        };
      }

      const json = await res.json();
      const data = (json && json.data) || {};
      for (const [tracking, info] of Object.entries(data)) {
        statuses[tracking] = extractStatus(info);
      }
    }

    return { ok: true, statuses, resolved: Object.keys(statuses).length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      ok: false,
      error: `Network error: ${message}`,
      statuses,
      resolved: Object.keys(statuses).length,
    };
  }
}

// ─────────────────────────────────────────────────────────────
// READ-ONLY detailed tracking info (the rescue-loop feed).
//
// GET /get/trackings/info returns, per tracking code: the parcel's
// French display status ("En livraison"), the activity timeline
// (last item can be "attempt_delivery" = failed attempt, or
// "livred"), the failed-attempt texts, and driver info. This is
// what OrderDZ's auto-tracking cron reads. Read-only.
// ─────────────────────────────────────────────────────────────

export interface EcotrackTrackingInfo {
  status: string; // French display status, e.g. "En livraison"
  lastActivityStatus: string | null; // e.g. "attempt_delivery" | "livred"
  attempts: { text: string; at: string | null; station: string | null }[];
  driverName: string | null;
  driverPhone: string | null;
  stopDesk: boolean | null;
}

export async function fetchTrackingsInfo(
  trackings: string[]
): Promise<{ ok: boolean; error?: string; info: Record<string, EcotrackTrackingInfo> }> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) return { ok: false, error: "ECOTRACK_TOKEN is not set", info: {} };

  const unique = Array.from(new Set(trackings.filter(Boolean)));
  const info: Record<string, EcotrackTrackingInfo> = {};

  try {
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const qs = chunk.map((t) => `trackings[]=${encodeURIComponent(t)}`).join("&");
      const res = await fetch(`${BASE_URL}/get/trackings/info?${qs}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, error: `Ecotrack trackings/info error (${res.status})`, info };
      const json = await res.json();
      const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
      for (const [tracking, rawU] of Object.entries(data)) {
        if (!rawU || typeof rawU !== "object") continue;
        const raw = rawU as Record<string, unknown>;
        const activity = Array.isArray(raw.activity) ? (raw.activity as Record<string, unknown>[]) : [];
        const last = activity.length ? activity[activity.length - 1] : null;
        const orderInfo = (raw.OrderInfo && typeof raw.OrderInfo === "object" ? raw.OrderInfo : {}) as Record<string, unknown>;
        const attemptsRaw = Array.isArray(raw.deliveryAttempts) ? (raw.deliveryAttempts as Record<string, unknown>[]) : [];
        info[tracking] = {
          status: String(raw.status || ""),
          lastActivityStatus: last ? String(last.status || "") || null : null,
          attempts: attemptsRaw
            .map((a) => ({
              text: String((a.text_tentative as string) || (a.content as string) || "").trim(),
              at: (a.created_at as string) || null,
              station: (a.station as string) || null,
            }))
            .filter((a) => a.text),
          driverName: (orderInfo.driver_name as string) || null,
          driverPhone: (orderInfo.driver_phone as string) || null,
          stopDesk: orderInfo.stop_desk == null ? null : Boolean(Number(orderInfo.stop_desk)),
        };
      }
    }
    return { ok: true, info };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Network error: ${message}`, info };
  }
}

// ─────────────────────────────────────────────────────────────
// SUIVI — the full picture of one parcel, for the follow-up phase.
//
// Neither endpoint alone is enough, so we merge both:
//
//   /get/trackings/info  → the `activity` journey, `done_by` (who
//                          spoke: Livreur / Station / Expéditeur =
//                          us), `postponed_to`, and the driver's
//                          PHONE. But it collapses the canned reason
//                          and the free-text comment into one field
//                          that is sometimes `content` and sometimes
//                          `text_tentative`.
//   /get/orders          → `status_reason`, which keeps them apart:
//                          `remarque` (canned) + `commentaires`
//                          (free text). Reliable to key alerts off.
//
// Verified against real Curio parcels on 17 Aug 2026. Read-only.
// ─────────────────────────────────────────────────────────────

export interface ParcelActivity {
  date: string;   // "2026-08-16"
  time: string;   // "11:51:50"
  status: string; // order_information_received_by_carrier | accepted_by_carrier | dispatched_to_driver | attempt_delivery | notification_on_order | livred
  station: string;
}

export interface ParcelComment {
  at: string;          // "2026-08-16 11:51:50"
  reason: string;      // canned reason ("Client ne répond pas الزبون لا يرد")
  text: string;        // free text ("Hchiya wela ghadwa")
  station: string;
  driver: string;
  by: string;          // Livreur | Station | Expéditeur | "-"
  postponedTo: string | null;
}

export interface ParcelDetail {
  tracking: string;
  status: string;
  globalStatus: string;
  currentStation: string | null;
  driverName: string | null;
  driverPhone: string | null;
  stopDesk: boolean | null;
  montant: number;
  tarifLivraison: number;
  tarifRetour: number;
  activity: ParcelActivity[];
  comments: ParcelComment[];
}

/** Ecotrack sends "2026-08-16 11:51:50" in Africa/Algiers (UTC+1). */
export function algiersToDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi, se] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h - 1, +mi, +(se || 0)));
}

/**
 * Fetch the complete suivi picture for the given tracking codes.
 * Merges both endpoints; the list endpoint is optional — if a parcel has
 * aged out of it we still return everything trackings/info knows.
 */
export async function fetchParcelDetails(
  trackings: string[]
): Promise<{ ok: boolean; error?: string; parcels: Record<string, ParcelDetail> }> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) return { ok: false, error: "ECOTRACK_TOKEN is not set", parcels: {} };

  const unique = Array.from(new Set(trackings.filter(Boolean)));
  if (!unique.length) return { ok: true, parcels: {} };

  const parcels: Record<string, ParcelDetail> = {};

  // ── A. the rich per-parcel payload ──────────────────────────
  try {
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const qs = chunk.map((t) => `trackings[]=${encodeURIComponent(t)}`).join("&");
      const res = await fetch(`${BASE_URL}/get/trackings/info?${qs}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, error: `Ecotrack trackings/info error (${res.status})`, parcels };
      const json = (await res.json()) as Record<string, unknown>;

      for (const [tracking, rawU] of Object.entries(json)) {
        if (!rawU || typeof rawU !== "object") continue;
        const raw = rawU as Record<string, unknown>;
        const oi = (raw.OrderInfo && typeof raw.OrderInfo === "object" ? raw.OrderInfo : {}) as Record<string, unknown>;
        const activityRaw = Array.isArray(raw.activity) ? (raw.activity as Record<string, unknown>[]) : [];
        const attemptsRaw = Array.isArray(raw.deliveryAttempts) ? (raw.deliveryAttempts as Record<string, unknown>[]) : [];

        // The PLURAL endpoint omits `currentStation` (only the singular
        // /get/tracking/info returns it), so derive it from the last step
        // that names a station — same answer, no extra request per parcel.
        const lastStation = [...activityRaw].reverse().find((a) => String(a.station || "").trim());

        parcels[tracking] = {
          tracking,
          status: String(raw.status || ""),
          globalStatus: "",
          currentStation: (raw.currentStation as string) || (lastStation ? String(lastStation.station) : null),
          driverName: (oi.driver_name as string) || null,
          driverPhone: (oi.driver_phone as string) || null,
          stopDesk: oi.stop_desk == null ? null : Boolean(Number(oi.stop_desk)),
          montant: Number(oi.montant) || 0,
          tarifLivraison: Number(oi.tarif_prestation) || 0,
          tarifRetour: Number(oi.tarif_retour) || 0,
          activity: activityRaw.map((a) => ({
            date: String(a.date || ""),
            time: String(a.time || ""),
            status: String(a.status || ""),
            station: String(a.station || ""),
          })),
          // Provisional: one merged blob per attempt. Split properly in B.
          comments: attemptsRaw.map((a) => ({
            at: String(a.created_at || ""),
            reason: "",
            text: String(a.text_tentative ?? a.content ?? "").trim(),
            station: String(a.station || ""),
            driver: String(a.driver || ""),
            by: String(a.done_by || ""),
            postponedTo: (a.postponed_to as string) || null,
          })),
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Network error: ${message}`, parcels };
  }

  // ── B. overlay the split reason/free-text from the list ─────
  // Best-effort: the list only carries parcels still in process, and a
  // failure here must not cost us everything we already have.
  try {
    const list = await fetchAllEcotrackOrders();
    if (list.ok) {
      for (const row of list.rawRows) {
        const tracking = String(row.tracking || "");
        const p = parcels[tracking];
        if (!p) continue;
        p.globalStatus = String(row.global_status || "");
        const reasons = Array.isArray(row.status_reason) ? (row.status_reason as Record<string, unknown>[]) : [];
        if (!reasons.length) continue;
        // Match on the timestamp — the shared key between both payloads.
        const byAt = new Map(reasons.map((r) => [String(r.created_at || ""), r]));
        for (const c of p.comments) {
          const r = byAt.get(c.at);
          if (!r) continue;
          c.reason = String(r.remarque || "").trim();
          c.text = String(r.commentaires || "").trim();
          if (!c.driver) c.driver = String(r.livreur || "");
          if (!c.station) c.station = String(r.station || "");
        }
        // Reasons the per-parcel payload never mentioned (defensive).
        for (const [at, r] of Array.from(byAt.entries())) {
          if (p.comments.some((c) => c.at === at)) continue;
          p.comments.push({
            at,
            reason: String(r.remarque || "").trim(),
            text: String(r.commentaires || "").trim(),
            station: String(r.station || ""),
            driver: String(r.livreur || ""),
            by: "",
            postponedTo: null,
          });
        }
        p.comments.sort((a, b) => a.at.localeCompare(b.at));
      }
    }
  } catch {
    /* keep what part A gave us */
  }

  return { ok: true, parcels };
}

// ─────────────────────────────────────────────────────────────
// WRITE-BACK — the three routes Ecotrack actually exposes.
//
// Discovered 17 Aug 2026 by probing (there is no documentation).
// Verified with a deliberately non-existent tracking code, so the
// server described its own validation without touching a parcel:
//   POST   /update/order   — edit amount / address / phone / name
//   POST   /demande/retour — ask them to send the box back
//   DELETE /delete/order   — cancel a parcel outright  (NOT wired
//                            up: agents must not be able to nuke a
//                            live parcel from the console)
//
// There is NO route to post a comment. 22 plausible names all 404.
// Replying to the driver still means opening the Ecotrack dashboard.
// ─────────────────────────────────────────────────────────────

/** Ask Ecotrack to return the parcel to us instead of retrying. */
export async function askParcelReturn(
  tracking: string
): Promise<{ success: boolean; error?: string }> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) return { success: false, error: "ECOTRACK_TOKEN is not set" };
  try {
    const res = await fetch(`${BASE_URL}/demande/retour`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tracking }),
    });
    const data = await res.json().catch(() => null);
    // Ecotrack answers 200 with {"askret":"fail"} when it refuses —
    // an HTTP-only check would report success on a no-op.
    const askret = String((data as Record<string, unknown> | null)?.askret ?? "").toLowerCase();
    if (!res.ok) return { success: false, error: `Ecotrack error (${res.status})` };
    // Require an AFFIRMATIVE token. On an undocumented API that already
    // answers 200 while refusing, "no askret key at all" (HTML, empty body,
    // a changed field name) must not be read as success — that would post
    // "we asked for the return" to the timeline and nobody would ask again.
    if (askret !== "success" && askret !== "ok" && askret !== "true" && askret !== "1") {
      console.error("askParcelReturn: unrecognised Ecotrack response", { tracking, body: data });
      return {
        success: false,
        error: `إيكوتراك ما قبلش طلب الإرجاع${askret ? ` (${askret})` : " — جواب غير مفهوم"}`,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: `Network error: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

export interface ParcelUpdateFields {
  tracking: string;
  client: string;
  tel: string;
  wilaya: number;
  commune: string;
  adresse: string;
  montant: number;
  tel2?: string | null;
  type?: number;
  stopDesk?: boolean;
  produit?: string;
  remarque?: string;
}

/**
 * Edit a parcel that is already at Ecotrack.
 * Every field below is REQUIRED by their validator — this is a full
 * re-statement of the parcel, not a patch, so callers must send the
 * current values for anything they are not changing.
 */
export async function updateParcel(
  f: ParcelUpdateFields
): Promise<{ success: boolean; error?: string; rawResponse?: unknown }> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) return { success: false, error: "ECOTRACK_TOKEN is not set" };
  try {
    const res = await fetch(`${BASE_URL}/update/order`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        tracking: f.tracking,
        type: f.type ?? 1,
        client: f.client,
        tel: f.tel,
        wilaya: f.wilaya,
        commune: f.commune,
        adresse: f.adresse,
        montant: f.montant,
        // /update/order is a full re-statement, not a patch — anything we
        // omit risks being blanked. The backup number is precisely what the
        // driver falls back on when the first phone doesn't answer, so it
        // must be restated even when the agent isn't changing it.
        ...(f.tel2 ? { telephone_2: f.tel2 } : {}),
        ...(f.stopDesk == null ? {} : { stop_desk: f.stopDesk ? 1 : 0 }),
        ...(f.produit ? { produit: f.produit } : {}),
        ...(f.remarque ? { remarque: f.remarque } : {}),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const d = data as Record<string, unknown> | null;
      const errs = d?.errors && typeof d.errors === "object"
        ? Object.values(d.errors as Record<string, string[]>).flat().join(" · ")
        : "";
      return { success: false, error: errs || String(d?.message || `Ecotrack error (${res.status})`), rawResponse: data };
    }
    return { success: true, rawResponse: data };
  } catch (err) {
    return { success: false, error: `Network error: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

// ─────────────────────────────────────────────────────────────
// READ-ONLY order list + phone reconciliation (the real bridge).
//
// Curio's flow is: website → OrderDZ → (confirmed) → Ecotrack.
// The store DB therefore does NOT hold the delivery outcome. The
// reliable way to learn it is Ecotrack's order LIST endpoint, which
// returns global_status / livred_at / phone for every in-process
// order. We match those to store orders by PHONE (the dependable
// shared key — `reference` is inconsistent). All read-only.
// ─────────────────────────────────────────────────────────────

export interface EcotrackOrder {
  reference: string | null;
  tracking: string; // Ecotrack tracking code (captured for matching/audit)
  produit: string; // product description string (agent-editable in OrderDZ — weak signal)
  phone: string; // normalized to last 9 digits
  phone2: string;
  status: string; // detailed French status
  globalStatus: string; // "livre" | "retour" | "en_process" | ...
  livredAt: string | null;
  returnAskedAt: string | null;
  montant: number;
  createdAt: string | null;
  bucket: DeliveryBucket;
}

/**
 * STRICT terminal classifier — for the irreversible FREEZE decision only.
 * Trusts ONLY the clean `global_status` prefix; ignores bare `livred_at` /
 * `return_asked_at` and the detailed-status fallback, so a return REQUEST or a
 * mid-transit return leg is NEVER frozen. Returns null if not clearly terminal.
 */
export function strictTerminalBucket(o: { globalStatus?: string | null }): "delivered" | "returned" | null {
  const g = (o.globalStatus || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip accents → "livré" → "livre"
  if (g.startsWith("retour")) return "returned";
  if (g.startsWith("livre")) return "delivered";
  return null;
}

export interface EcotrackListResult {
  ok: boolean;
  error?: string;
  orders: EcotrackOrder[];
  pages: number;
  /**
   * Untouched rows as Ecotrack sent them. `orders` above is the narrow
   * reconciliation view; the suivi merge needs fields it drops — chiefly
   * `status_reason`, the comment thread with the canned reason and the
   * free text kept apart.
   */
  rawRows: Record<string, unknown>[];
}

/** Normalize an Algerian phone to its last 9 digits (drops 0 / +213 prefixes). */
export function normalizePhone(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.slice(-9);
}

/**
 * Classify an Ecotrack order into a business bucket, preferring the
 * clean `global_status`, then timestamps, then the detailed status.
 */
export function bucketEcotrackOrder(o: {
  globalStatus?: string;
  status?: string;
  livredAt?: string | null;
  returnAskedAt?: string | null;
}): DeliveryBucket {
  const g = (o.globalStatus || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (g.startsWith("retour")) return "returned";
  if (g.startsWith("livre")) return "delivered";
  if (g.includes("annul")) return "cancelled";
  if (g.startsWith("en_process") || g === "process") {
    // Still in process — but timestamps can disambiguate edge cases.
    if (o.returnAskedAt) return "returned";
    if (o.livredAt) return "delivered";
    return "in_transit";
  }
  // Fall back to the detailed status string.
  const s = bucketEcotrackStatus(o.status || "");
  if (s !== "unknown") return s;
  if (o.returnAskedAt) return "returned";
  if (o.livredAt) return "delivered";
  return "in_transit";
}

/**
 * Fetch all in-process orders from Ecotrack (paginated, ~40/page).
 * Read-only GET. `maxPages` caps the work as volume grows.
 */
export async function fetchAllEcotrackOrders(maxPages = 60): Promise<EcotrackListResult> {
  const token = process.env.ECOTRACK_TOKEN;
  if (!token) return { ok: false, error: "ECOTRACK_TOKEN is not set", orders: [], pages: 0, rawRows: [] };

  const orders: EcotrackOrder[] = [];
  const rawRows: Record<string, unknown>[] = [];
  let page = 1;
  try {
    for (; page <= maxPages; page++) {
      const url = `${BASE_URL}/get/orders?api_token=${encodeURIComponent(token)}&page=${page}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        return { ok: false, error: `Ecotrack list error (${res.status})`, orders, pages: page - 1, rawRows };
      }
      const json = await res.json();
      const data: Record<string, unknown>[] = json?.data || [];
      rawRows.push(...data);
      for (const o of data) {
        const eo = {
          reference: (o.reference as string) ?? null,
          // Field names below confirmed against a real /get/orders response in the
          // dry-run; `tracking` falls back across the likely keys defensively.
          tracking: String(o.tracking || o.tracking_code || o.code || ""),
          produit: String(o.produit || o.products || ""),
          phone: normalizePhone(o.phone as string),
          phone2: normalizePhone(o.phone_2 as string),
          status: (o.status as string) || "",
          globalStatus: (o.global_status as string) || "",
          livredAt: (o.livred_at as string) || null,
          returnAskedAt: (o.return_asked_at as string) || null,
          montant: Number(o.montant) || 0,
          createdAt: (o.created_at as string) || null,
        };
        orders.push({ ...eo, bucket: bucketEcotrackOrder(eo) });
      }
      const total = Number(json?.total) || 0;
      const per = Number(json?.per_page) || 40;
      if (data.length === 0 || page * per >= total) break;
    }
    return { ok: true, orders, pages: page, rawRows };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, error: `Network error: ${message}`, orders, pages: page - 1, rawRows };
  }
}
