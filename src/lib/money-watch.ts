// ─── The money watch ────────────────────────────────────────
// Order #758 went out on 20 August, was delivered on the 23rd, and the
// courier was told to collect ZERO. The customer has the box, paid nothing,
// and we still owe the 850 DA delivery. Nobody noticed for a week, and it
// was the THIRD parcel of its kind — the 15 August reconciliation caught two
// others before they shipped.
//
// Every one of those was findable the day it happened. This is the thing
// that looks.
//
// It only reads and alerts; it never edits an order or a parcel. And it
// remembers what it has already shouted about, because an alarm that repeats
// every fifteen minutes is an alarm that gets muted.

import { db } from "@/lib/db";
import { sendTelegram, telegramConfigured } from "@/lib/telegram";

/** A parcel worth waking someone for. */
interface Finding {
  kind: "zero_amount" | "short_amount";
  trackingCode: string;
  orderNumber: number | null;
  customerName: string;
  ours: number;
  theirs: number;
  delivered: boolean;
  fee: number;
}

const seenKey = (f: Finding) => `watch.seen.${f.kind}.${f.trackingCode}`;

export interface WatchResult {
  ok: boolean;
  checked: number;
  found: number;
  alerted: number;
  telegram: boolean;
  findings: Finding[];
}

export async function runMoneyWatch(opts: { notify?: boolean } = {}): Promise<WatchResult> {
  const notify = opts.notify !== false;

  const parcels = await db.parcelTracking.findMany({
    select: {
      trackingCode: true, montant: true, tarifLivraison: true, globalStatus: true,
      order: { select: { orderNumber: true, customerName: true, total: true } },
    },
  });

  const findings: Finding[] = [];
  for (const p of parcels) {
    if (!p.order) continue;
    const delivered = (p.globalStatus || "").toLowerCase().normalize("NFD")
      .replace(/[̀-ͯ]/g, "").startsWith("livre");

    // Zero is the dangerous one: the box leaves and the driver is told to
    // collect nothing at all.
    if (p.montant === 0 && p.order.total > 0) {
      findings.push({
        kind: "zero_amount", trackingCode: p.trackingCode,
        orderNumber: p.order.orderNumber, customerName: p.order.customerName,
        ours: p.order.total, theirs: 0, delivered, fee: p.tarifLivraison,
      });
      continue;
    }
    // A smaller gap is usually an edit that landed after the parcel was made.
    if (p.montant > 0 && p.montant < p.order.total) {
      findings.push({
        kind: "short_amount", trackingCode: p.trackingCode,
        orderNumber: p.order.orderNumber, customerName: p.order.customerName,
        ours: p.order.total, theirs: p.montant, delivered, fee: p.tarifLivraison,
      });
    }
  }

  // Only shout about what we have not shouted about before.
  const keys = findings.map(seenKey);
  const already = keys.length
    ? await db.financeSetting.findMany({ where: { key: { in: keys } }, select: { key: true } })
    : [];
  const seen = new Set(already.map((r) => r.key));
  const fresh = findings.filter((f) => !seen.has(seenKey(f)));

  let alerted = 0;
  let telegram = false;

  if (fresh.length && notify) {
    const lines = fresh.map((f) => {
      const who = `#${f.orderNumber ?? "—"} ${f.customerName}`;
      if (f.kind === "zero_amount") {
        return f.delivered
          ? `• ${who} — DELIVERED and the courier collected 0 DA. Our books say ${f.ours.toLocaleString()}. We still owe ${f.fee} delivery. Gone.`
          : `• ${who} — parcel is set to collect 0 DA, our books say ${f.ours.toLocaleString()}. NOT delivered yet — fix the amount in Ecotrack now.`;
      }
      return `• ${who} — courier collects ${f.theirs.toLocaleString()}, our books say ${f.ours.toLocaleString()} (${(f.theirs - f.ours).toLocaleString()})${f.delivered ? " — already delivered" : " — not delivered yet, still fixable"}`;
    });

    const fixable = fresh.filter((f) => !f.delivered).length;
    const text =
      `💸 Curio — money about to walk out the door\n\n` +
      lines.join("\n") +
      `\n\n${fixable > 0 ? `${fixable} of these are NOT delivered yet — you can still fix the amount in the Ecotrack dashboard.` : "All of these have already been delivered."}` +
      `\n\nSeen on /finance under "orders where the courier and our books disagree".`;

    telegram = telegramConfigured() ? await sendTelegram(text) : false;

    // Mark them seen even if Telegram is not configured — the finance page
    // lists them anyway, and a repeating alarm is a muted alarm.
    for (const f of fresh) {
      await db.financeSetting.create({
        data: {
          key: seenKey(f),
          value: new Date().toISOString(),
          label: null,
          unit: null,
          note: `auto: money-watch alerted on ${f.trackingCode}`,
          sort: 9000,
        },
      }).catch(() => {});
      alerted++;
    }
  }

  return { ok: true, checked: parcels.length, found: findings.length, alerted, telegram, findings };
}
