import type { ParcelActivity, ParcelComment, ParcelDetail } from "@/lib/ecotrack";
import { algiersToDate } from "@/lib/ecotrack";

// ─────────────────────────────────────────────────────────────
// SUIVI BRAIN — turns Ecotrack's French/technical output into
// something a Darija-speaking agent can act on in one glance.
//
// Two jobs:
//   1. LABEL — every activity step and every canned driver reason
//      gets Darija wording. The vocabulary is small and closed
//      (6 steps, ~9 reasons), harvested from every live Curio
//      parcel on 17 Aug 2026, so this is near-complete rather
//      than guesswork. Anything unknown falls through to the raw
//      text — never hidden.
//   2. TRIAGE — decide whether a parcel needs a human today, and
//      say why in one Darija line. This is what the Suivi board
//      sorts on; without it the agent is reading 60 timelines.
// ─────────────────────────────────────────────────────────────

export type AlertLevel = "ok" | "watch" | "act";

// ── 1a. Journey steps ────────────────────────────────────────
export const ACTIVITY_AR: Record<string, { ar: string; tone: "neutral" | "good" | "bad" }> = {
  order_information_received_by_carrier: { ar: "إيكوتراك سجّل الطلب", tone: "neutral" },
  accepted_by_carrier:                   { ar: "إيكوتراك رفدو الكولي", tone: "neutral" },
  dispatched_to_driver:                  { ar: "مع الليفرور", tone: "neutral" },
  attempt_delivery:                      { ar: "حاول يوصّلها وما نجحش", tone: "bad" },
  notification_on_order:                 { ar: "ملاحظة جديدة على الطلب", tone: "neutral" },
  livred:                                { ar: "وصلت للزبون", tone: "good" },
};

export function activityLabel(step: string): { ar: string; tone: "neutral" | "good" | "bad" } {
  return ACTIVITY_AR[step] || { ar: step.replace(/_/g, " "), tone: "neutral" };
}

// ── 1b. The canned reasons a driver / station can pick ───────
// `act` = an agent must phone somebody. Matched on a normalized
// substring because Ecotrack mixes French, Arabic and accents.
// `auto` marks machine-generated entries. They must never raise an alert NOR
// clear one — an automatic SMS says nothing about whether a human problem was
// resolved, so letting it count would hide a real "customer not answering".
const REASON_RULES: { match: string; ar: string; level: AlertLevel; auto?: boolean }[] = [
  // Longer, more specific phrases first: matching is substring-based, so
  // "adresse" would otherwise swallow "adresse confirmée".
  { match: "ne repond pas",   ar: "الزبون ما يجاوبش", level: "act" },
  { match: "injoignable",     ar: "الهاتف مطفي", level: "act" },
  { match: "annule par le client", ar: "الزبون لغى الطلب", level: "act" },
  { match: "faux numero",     ar: "رقم غالط", level: "act" },
  { match: "adresse incorrecte", ar: "العنوان غالط", level: "act" },
  { match: "adresse introuvable", ar: "ما لقاش العنوان", level: "act" },
  { match: "suspendu",        ar: "الكولي موقّف", level: "act" },
  { match: "reporte",         ar: "التوصيل تأجّل", level: "watch" },
  { match: "client contacte", ar: "تكلّم مع الزبون واتفقو", level: "ok" },
  { match: "livraison prevue", ar: "التوصيل مبرمج اليوم", level: "ok" },
  { match: "sms envoye",      ar: "بعثولو SMS", level: "ok", auto: true },
  { match: "ecrire une remarque", ar: "ملاحظة", level: "watch" },
  { match: "autre",           ar: "ملاحظة", level: "watch" },
];

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function reasonMeta(reason: string): { ar: string; level: AlertLevel; auto: boolean } {
  const n = normalize(reason);
  if (!n) return { ar: "", level: "ok", auto: false };
  for (const r of REASON_RULES) if (n.includes(r.match)) return { ar: r.ar, level: r.level, auto: !!r.auto };
  // Unknown reason. This is NOT a closed vocabulary — Ecotrack's dashboard
  // lets a human type free text straight into `remarque` (Curio's own notes
  // arrive that way), so show it verbatim and flag it for a human to read.
  return { ar: reason, level: "watch", auto: false };
}

/** Who wrote this line. `Expéditeur` is us — Curio's own message. */
export function authorMeta(by: string): { ar: string; side: "us" | "driver" | "station" | "system" } {
  const n = normalize(by);
  if (n.startsWith("expediteur")) return { ar: "كيوريو (حنا)", side: "us" };
  if (n.startsWith("livreur")) return { ar: "الليفرور", side: "driver" };
  if (n.startsWith("station")) return { ar: "المحطة", side: "station" };
  return { ar: "إيكوتراك", side: "system" };
}

// ── 2. Triage ────────────────────────────────────────────────

/** No movement for this long, and not delivered → something is stuck. */
const STUCK_MS = 4 * 86400000;

export interface Triage {
  level: AlertLevel;
  reason: string;          // one Darija line for the board row
  attemptCount: number;
  lastMoveAt: Date | null;
  lastCommentAt: Date | null;
  postponedTo: Date | null;
}

/**
 * @param shippedAt when we handed the parcel over. Used as the movement
 *   baseline for a parcel that has NO activity at all — the worst case,
 *   because "Prêt à expédier" three weeks after shipping means Ecotrack
 *   never picked the box up and nothing in the timeline will ever say so.
 */
export function triageParcel(p: ParcelDetail, now = new Date(), shippedAt?: Date | null): Triage {
  const activity: ParcelActivity[] = p.activity || [];
  const comments: ParcelComment[] = p.comments || [];

  const attemptCount = activity.filter((a) => a.status === "attempt_delivery").length;
  // Check "coming back" BEFORE "delivered": an exchange parcel is flagged
  // livré for the outbound leg while the return leg is still travelling, so
  // testing delivered first would call #689 finished while a box is in the air.
  const returning =
    /^retour/.test(normalize(p.globalStatus)) || /^retour/.test(normalize(p.status));
  // `globalStatus` comes from the list endpoint, which drops old parcels and
  // returns nothing at all if one page fails — so it can be "" on a genuinely
  // delivered parcel. Fall back to the display status too, or a delivered box
  // with no `livred` step would age into the stuck rule and go red.
  const delivered =
    !returning &&
    (activity.some((a) => a.status === "livred") ||
      /^livre/.test(normalize(p.globalStatus)) ||
      /^livre/.test(normalize(p.status)));

  const moveDates = activity
    .map((a) => algiersToDate(`${a.date} ${a.time}`))
    .filter((d): d is Date => !!d);
  const lastMoveAt = moveDates.length ? moveDates[moveDates.length - 1] : (shippedAt ?? null);

  const commentDates = comments.map((c) => algiersToDate(c.at)).filter((d): d is Date => !!d);
  const lastCommentAt = commentDates.length ? commentDates[commentDates.length - 1] : null;

  const postponedRaw = [...comments].reverse().find((c) => c.postponedTo)?.postponedTo || null;
  const postponedTo = algiersToDate(postponedRaw);

  const base = { attemptCount, lastMoveAt, lastCommentAt, postponedTo };

  // Delivered or already coming home — nothing for suivi to chase.
  if (delivered) return { ...base, level: "ok", reason: "" };
  if (returning) return { ...base, level: "watch", reason: "راجع لينا — استنى وصولو" };

  // The LATEST human entry decides — including a good one. An earlier
  // "customer not answering" followed by "spoke to the customer, agreed" is
  // resolved; keeping the parcel red would send the agent to phone someone
  // who is already sorted, which is how a follow-up board becomes noise.
  // Automatic entries are skipped so an SMS can neither raise nor clear.
  const latest = [...comments].reverse().find((c) => {
    const m = reasonMeta(c.reason);
    return !m.auto && (c.reason || c.text);
  });
  let resolved = false;
  if (latest) {
    const meta = reasonMeta(latest.reason);
    if (meta.level === "act") {
      const who = latest.driver ? ` (${latest.driver})` : "";
      return { ...base, level: "act", reason: `${meta.ar}${who}` };
    }
    if (meta.level === "watch") {
      // A canned "watch" reason counts even with no free text — a postponed
      // delivery used to fall through here and land on the board as "ok".
      const detail = latest.text ? `${meta.ar}: ${latest.text}` : meta.ar;
      return { ...base, level: "watch", reason: detail };
    }
    if (latest.text) return { ...base, level: "watch", reason: `ملاحظة: ${latest.text}` };
    resolved = true; // an "ok" reason — the failed attempts below are answered
  }

  // A delivery promised for a date that has now passed is a broken promise.
  if (postponedTo && postponedTo.getTime() < now.getTime() - 86400000) {
    return { ...base, level: "act", reason: "فات وقت التوصيل لي وعدو بيه" };
  }

  // Repeated failed attempts that nobody has since resolved.
  if (!resolved) {
    if (attemptCount >= 2) return { ...base, level: "act", reason: `${attemptCount} محاولات وما وصلاتش` };
    if (attemptCount === 1) return { ...base, level: "watch", reason: "محاولة وحدة فشلت" };
  }

  // Silent for days — including the never-collected case, where the parcel
  // still reads "Prêt à expédier" long after we handed it over.
  if (lastMoveAt && now.getTime() - lastMoveAt.getTime() > STUCK_MS) {
    const days = Math.floor((now.getTime() - lastMoveAt.getTime()) / 86400000);
    const neverMoved = activity.length <= 1;
    return {
      ...base,
      level: "act",
      reason: neverMoved
        ? `${days} أيام وإيكوتراك مازال ما رفدوش الكولي`
        : `ماشي يتحرّك من ${days} أيام`,
    };
  }

  return { ...base, level: "ok", reason: "" };
}

/**
 * Delivered, cash collected by Ecotrack, not yet paid over to us.
 * Not an alert — money we are owed. Surfaced separately on the board.
 */
export function isCollectedNotPaid(statusFr: string): boolean {
  const n = normalize(statusFr);
  return n.includes("encaisse") && n.includes("non paye");
}
