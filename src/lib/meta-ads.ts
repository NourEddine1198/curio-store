// ─── Meta ad spend → the ledger ─────────────────────────────
// Facebook is the single largest variable cost and the only one nobody can
// count by hand. This pulls it daily, per campaign, and writes one euro
// movement per day into the ledger.
//
// Config (Netlify env):
//   META_TOKEN     — a SYSTEM USER token. A personal token expires in ~60
//                    days and the feed would die silently in October.
//   META_AD_ACCOUNT — defaults to Curio's account below.
// Without a token every function here reports "not configured" and writes
// nothing, so this can ship long before the token exists.
//
// ⚠️ THE AD ACCOUNT IS SHARED. It also runs non-Curio campaigns ("AI for
// kids", "imene campaign"). Pulling account-level spend would bill Curio for
// someone else's advertising, so everything is filtered to an allowlist.

import { db } from "@/lib/db";

const GRAPH = "https://graph.facebook.com/v25.0";
const DEFAULT_ACCOUNT = "1528260957700485";

/** Campaign ids confirmed as Curio's on 29 Aug 2026. */
export const CURIO_CAMPAIGNS = [
  "120253214644310635", // Dllala campaign
  "120253184092420635", // Roubla SECOND EDITION
  "120253354065470635", // Retargeting — Curio
  "120253273859670635", // Roubla test campaign
  "120253266742920635", // Dllala test campaign
];

/**
 * A new campaign made next month would not be in the list above, and its
 * spend would go uncounted — quietly overstating profit. So a name pattern
 * catches them too, and both are editable from the cost-rules screen rather
 * than needing a deploy.
 */
async function allowlist(): Promise<{ ids: Set<string>; pattern: RegExp | null }> {
  const rows = await db.financeSetting.findMany({
    where: { key: { in: ["ads.campaignIds", "ads.namePattern"] } },
  });
  const idsRaw = rows.find((r) => r.key === "ads.campaignIds")?.value;
  const patRaw = rows.find((r) => r.key === "ads.namePattern")?.value;
  const ids = new Set(
    (idsRaw ? idsRaw.split(/[,\s]+/) : CURIO_CAMPAIGNS).map((s) => s.trim()).filter(Boolean)
  );
  let pattern: RegExp | null = null;
  if (patRaw && patRaw.trim()) {
    try { pattern = new RegExp(patRaw.trim(), "i"); } catch { pattern = null; }
  }
  return { ids, pattern };
}

export function metaConfigured(): boolean {
  return Boolean(process.env.META_TOKEN);
}

interface DayRow { campaignId: string; campaignName: string; date: string; spendCents: number }

/**
 * Daily spend per campaign between two dates (inclusive), Curio only.
 * time_increment=1 makes Meta return one row per campaign per day, which is
 * what lets a day be re-pulled and corrected without touching its neighbours.
 */
export async function fetchDailySpend(
  since: string, until: string
): Promise<{ ok: boolean; error?: string; rows: DayRow[] }> {
  const token = process.env.META_TOKEN;
  if (!token) return { ok: false, error: "META_TOKEN is not set", rows: [] };
  const account = process.env.META_AD_ACCOUNT || DEFAULT_ACCOUNT;

  const { ids, pattern } = await allowlist();
  const url =
    `${GRAPH}/act_${account}/insights` +
    `?level=campaign&time_increment=1` +
    `&fields=campaign_id,campaign_name,spend` +
    `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message || `Meta error (${res.status})`;
      return { ok: false, error: msg, rows: [] };
    }
    const rows: DayRow[] = [];
    for (const r of json?.data || []) {
      const id = String(r.campaign_id || "");
      const name = String(r.campaign_name || "");
      const mine = ids.has(id) || (pattern ? pattern.test(name) : false);
      if (!mine) continue;
      // Meta returns spend as a decimal string of the account currency (EUR).
      const cents = Math.round(Number(r.spend || 0) * 100);
      if (!Number.isFinite(cents) || cents <= 0) continue;
      rows.push({ campaignId: id, campaignName: name, date: String(r.date_start), spendCents: cents });
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error", rows: [] };
  }
}

/** The note that identifies a row this sync owns, so re-running replaces
 *  rather than stacking. Includes the day so each is individually replaceable. */
const tag = (date: string) => `[meta-sync ${date}]`;

/** The seeded lump from before the feed existed. It covers 13–29 Aug, so the
 *  moment daily rows land for that period the two would double-count. */
const SEED_LUMP_NOTE = "Meta API, 13–29 Aug, Curio campaigns only — lump; phase 4 replaces with daily rows";

export interface SyncResult {
  ok: boolean;
  error?: string;
  days: number;
  totalCents: number;
  totalDzd: number;
  replaced: number;
  removedLump: boolean;
}

/**
 * Pull `days` back and write one euro movement per day.
 *
 * Re-running is safe and is the point: Meta revises recent spend for a day or
 * two after the fact, so yesterday's number is not final. Each day's row is
 * deleted and rewritten rather than added to.
 */
export async function syncAdSpend(days = 7): Promise<SyncResult> {
  const empty: SyncResult = { ok: false, days: 0, totalCents: 0, totalDzd: 0, replaced: 0, removedLump: false };
  if (!metaConfigured()) return { ...empty, error: "META_TOKEN is not set" };

  const until = new Date(Date.now() + 60 * 60000).toISOString().slice(0, 10);   // today, Algiers
  const since = new Date(Date.now() + 60 * 60000 - (days - 1) * 86400000).toISOString().slice(0, 10);

  const pulled = await fetchDailySpend(since, until);
  if (!pulled.ok) return { ...empty, error: pulled.error };

  const account = await db.financeAccount.findUnique({ where: { key: "bank_eur" } });
  if (!account) return { ...empty, error: "the bank_eur account is missing — run the finance seed" };

  const fxRow = await db.financeSetting.findUnique({ where: { key: "fx.eurDzd" } });
  const eurDzd = Number(fxRow?.value) || 280;

  // Collapse campaigns into one row per day: the ledger cares what left the
  // account, and the per-campaign split lives in Meta where it belongs.
  const byDay = new Map<string, number>();
  for (const r of pulled.rows) byDay.set(r.date, (byDay.get(r.date) || 0) + r.spendCents);

  let replaced = 0;
  let totalCents = 0;
  for (const [date, cents] of Array.from(byDay.entries())) {
    const note = tag(date);
    const existing = await db.moneyMovement.findMany({
      where: { categoryKey: "ads_meta", note: { startsWith: note } },
      select: { id: true },
    });
    for (const e of existing) { await db.moneyMovement.delete({ where: { id: e.id } }); replaced++; }

    await db.moneyMovement.create({
      data: {
        occurredAt: new Date(`${date}T12:00:00.000Z`),
        direction: "out",
        accountId: account.id,
        amount: cents,
        currency: "EUR",
        amountDzd: Math.round((cents / 100) * eurDzd),
        fxRate: Math.round(eurDzd * 100),
        categoryKey: "ads_meta",
        note: `${note} Curio campaigns`,
        createdBy: "meta-sync",
      },
    });
    totalCents += cents;
  }

  // Once real daily rows exist, the hand-seeded lump has to go or the same
  // euros are counted twice.
  // Only retire the lump once the daily rows actually COVER the period it
  // stood for. Deleting it after a 7-day pull would have erased 13-24 Aug
  // from the ledger entirely and silently inflated August's profit.
  const LUMP_COVERS_FROM = "2026-08-13";
  let removedLump = false;
  if (byDay.size > 0 && since <= LUMP_COVERS_FROM) {
    const lump = await db.moneyMovement.findFirst({ where: { note: SEED_LUMP_NOTE } });
    if (lump) { await db.moneyMovement.delete({ where: { id: lump.id } }); removedLump = true; }
  }

  return {
    ok: true,
    days: byDay.size,
    totalCents,
    totalDzd: Math.round((totalCents / 100) * eurDzd),
    replaced,
    removedLump,
  };
}
