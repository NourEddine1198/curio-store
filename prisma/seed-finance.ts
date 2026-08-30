// ─────────────────────────────────────────────────────────────
// Seed the /finance layer: the three accounts, the categories the
// founders actually use, and their real cost rules.
//
// Safe to re-run. Every write is a read-then-write on a unique key,
// and existing rows keep their values — so re-seeding never
// overwrites a cost Nounouti has since corrected in the UI.
//
//   npx tsx prisma/seed-finance.ts
//
// Uses PrismaPg (a direct connection) rather than the app's Neon HTTP
// adapter: HTTP mode has no transactions, so upsert fails there.
// ─────────────────────────────────────────────────────────────
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { randomBytes } from "node:crypto";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const ACCOUNTS = [
  { key: "cash",      name: "Cash",       currency: "DZD", sort: 1 },
  { key: "baridimob", name: "BaridiMob",  currency: "DZD", sort: 2 },
  { key: "bank_eur",  name: "Bank (EUR)", currency: "EUR", sort: 3 },
];

// `auto: true` = the profit view computes this itself; movements filed
// here move the ledger only. See the schema comment on FinanceCategory.
const CATEGORIES = [
  // ── money in — all auto, because revenue is read from parcels ──
  { key: "courier_payout",     label: "Courier payout",            labelAr: "الفلوس من إيكوتراك", kind: "income",  bucket: "shipping",    auto: true,  sort: 10 },
  { key: "hand_delivery",      label: "Hand delivery cash",        labelAr: "توصيل باليد",        kind: "income",  bucket: "shipping",    auto: true,  sort: 11 },
  { key: "baridimob_customer", label: "Customer paid by BaridiMob", labelAr: "خلّص بـ BaridiMob", kind: "income",  bucket: "shipping",    auto: true,  sort: 12 },
  // auto:false — a genuine non-sale receipt (a supplier refund, a bulk cash
  // sale placed outside the site) has no parcel behind it, so the profit view
  // must take it from the ledger or it can never be counted at all.
  { key: "other_income",       label: "Other money in",            labelAr: "دخل آخر",            kind: "income",  bucket: "other",       auto: false, sort: 19 },

  // ── money out the profit view works out on its own ──
  { key: "print",          label: "Printing",           labelAr: "الطباعة",        kind: "expense", bucket: "cogs",        auto: true,  sort: 20 },
  { key: "wrapping",       label: "Wrapping",           labelAr: "التغليف",        kind: "expense", bucket: "shipping",    auto: true,  sort: 21 },
  { key: "confirmation",   label: "Confirmation agent",  labelAr: "خلاص التأكيد",   kind: "expense", bucket: "people",      auto: true,  sort: 22 },
  { key: "upsell_bonus",   label: "Upsell bonus",       labelAr: "بونص البيع",     kind: "expense", bucket: "people",      auto: true,  sort: 23 },
  { key: "courier_fees",   label: "Courier fees",       labelAr: "حقوق التوصيل",   kind: "expense", bucket: "shipping",    auto: true,  sort: 24 },
  { key: "return_fees",    label: "Return fees",        labelAr: "حقوق الإرجاع",   kind: "expense", bucket: "shipping",    auto: true,  sort: 25 },
  { key: "influencer",     label: "Influencer payouts", labelAr: "خلاص الأنفلونسر", kind: "expense", bucket: "marketing",  auto: true,  sort: 26 },

  // ── money out that only a human knows about ──
  { key: "ads_meta",       label: "Facebook ads",       labelAr: "إشهار فيسبوك",   kind: "expense", bucket: "marketing",   auto: false, sort: 30 },
  { key: "content_creator", label: "Content creator",   labelAr: "صانع المحتوى",   kind: "expense", bucket: "marketing",   auto: false, sort: 31 },
  { key: "consumables",    label: "Sacs, scotch, paper", labelAr: "سكوتش وسّاك وورق", kind: "expense", bucket: "consumables", auto: false, sort: 32 },
  { key: "delivery_guy",   label: "Delivery guy",       labelAr: "خلاص الليفرور",  kind: "expense", bucket: "shipping",    auto: true,  sort: 33 },
  { key: "other_expense",  label: "Something else",     labelAr: "حاجة أخرى",      kind: "expense", bucket: "other",       auto: false, sort: 39 },
];

// Every number Nounouti confirmed on 29 Aug 2026, plus the two that are
// still assumptions — flagged in `note` so the UI can show them as such.
const SETTINGS = [
  { key: "books.openFrom",       value: "2026-08-13", label: "Books open from",           unit: "date",
    note: "Start of Phase 2. Verified clean: 6 orders before it in August, 243 after.", sort: 1 },
  // Real per-product print costs, confirmed 30 Aug. They cross-check against
  // the committed total: 2,000 × 480 + 2,000 × 280 = 1,520,000, right up
  // against the 1.54M print order. Dividing the total by unit count — which
  // is what this used to do — averaged the two into 385 and made Roubla look
  // 95 DA cheaper and Dlala 105 DA dearer than they are, so per-product
  // profit was wrong in both directions at once.
  { key: "print.roubla",         value: "480",  label: "Printing — Roubla",              unit: "DA/game",
    note: "Confirmed 30 Aug.", sort: 10 },
  { key: "print.dlala",          value: "280",  label: "Printing — Dlala",               unit: "DA/game",
    note: "Confirmed 30 Aug.", sort: 11 },
  { key: "print.default",        value: "480",  label: "Printing — anything else",       unit: "DA/game",
    note: "ASSUMPTION — for legacy Phase-1 games (Goul, the Eid pack). Only 10 games so far, so it barely moves the total.", sort: 12 },
  { key: "wrap.roubla",          value: "80",   label: "Wrapping — Roubla",              unit: "DA/game",  note: "Confirmed 29 Aug. Per game, not per order.", sort: 13 },
  { key: "wrap.dlala",           value: "40",   label: "Wrapping — Dlala",               unit: "DA/game",  note: "Confirmed 29 Aug. A pack therefore costs 120.", sort: 14 },
  { key: "wrap.default",         value: "60",   label: "Wrapping — anything else",       unit: "DA/game",  note: "Fallback for legacy products (Goul, Eid pack).", sort: 15 },
  { key: "confirmation.perOrder", value: "80",  label: "Confirmation agent",             unit: "DA/delivered order", note: "Confirmed 29 Aug. Per ORDER, not per game. Paid monthly.", sort: 14 },
  { key: "upsell.bonus",         value: "150",  label: "Upsell bonus",                   unit: "DA/upsell",
    note: "For a game she sells on the phone. Exact from phase 4, when adding a line is logged.", sort: 15 },
  { key: "return.fee",           value: "50",   label: "Return fee",                     unit: "DA/return",
    note: "Confirmed 29 Aug. Ecotrack's tarif_retour. The old dashboard assumed 250.", sort: 16 },
  { key: "delivery.perDelivery", value: "350", label: "Our delivery guy",                unit: "DA/delivery",
    note: "Confirmed 30 Aug. Just the default — every order's fee is editable when you hand him the boxes, because a far commune is worth more.", sort: 16 },
  { key: "delivery.wilayas",     value: "16",   label: "Where our driver works",         unit: "wilaya codes",
    note: "Algiers only for now. Stop-desk orders are never offered to him whatever the wilaya — the customer collects those from a counter.", sort: 17 },
  { key: "fixed.rentPerMonth",   value: "0",    label: "Rent",                           unit: "DA/month",
    note: "Confirmed 29 Aug: there is no rent. The Command Center had been charging 15,000 a month that does not exist.", sort: 17 },
  { key: "wrap.perOrderBlended", value: "140",  label: "Wrapping — average per order",   unit: "DA/order",
    note: "For the Command Center only, which counts wrapping per order rather than per game. 21,340 DA over 152 parcels in August.", sort: 18 },
  // ── which campaigns on the SHARED ad account are Curio's ──
  // The account also runs non-Curio campaigns ("AI for kids", "imene
  // campaign"). Pulling account-level spend would bill Curio for someone
  // else's advertising, so the feed only counts what matches one of these.
  { key: "ads.campaignIds",      value: "120253214644310635 120253184092420635 120253354065470635 120253273859670635 120253266742920635",
    label: "Curio ad campaigns", unit: "Meta campaign ids",
    note: "Confirmed 29 Aug: Dllala, Roubla SECOND EDITION, Retargeting, and the two test campaigns. Add new ones here — no deploy needed.", sort: 30 },
  { key: "ads.namePattern",      value: "curio|roubla|dlala|dllala|origami",
    label: "…or any campaign named like",  unit: "pattern",
    note: "A safety net so a campaign created next month is not silently left out of the ad cost. Matching is case-insensitive.", sort: 31 },
  // ── Targets ──
  // Deliberately EMPTY except the one Nounouti already holds. A target you
  // invented is worse than none: the page would say "off track" against a
  // line nobody chose. Blank shows as "no target set" until he fills it in.
  { key: "target.adCostPerSale", value: "500", label: "Target — ad cost per delivered sale", unit: "DA",
    note: "His existing line. Green below it.", sort: 40 },
  { key: "target.returnRate",    value: "",    label: "Target — return-rate ceiling",        unit: "%",
    note: "Not set. Running at 9.7% against a 15% Phase-1 assumption — pick a ceiling and the page starts judging it.", sort: 41 },
  { key: "target.bundleShare",   value: "",    label: "Target — orders with 2+ games",       unit: "%",
    note: "Not set. Phase 1 ran at 59%, now 17%. The cheapest lever in the business.", sort: 42 },
  { key: "target.monthlyProfit", value: "",    label: "Target — profit per month",           unit: "DA",
    note: "Not set.", sort: 43 },
  { key: "target.printLeadWeeks", value: "",   label: "Print lead time",                     unit: "weeks",
    note: "Not set. Order placed to boxes on the shelf. Without it no reorder date can be worked out.", sort: 44 },
  { key: "fx.eurDzd",            value: "280",  label: "Euro rate",                      unit: "DA per €1",
    note: "ASSUMPTION — the parallel-market rate. Confirm what you actually pay per euro.", sort: 20 },
];

async function main() {
  // ── retire rules that have been replaced ──
  // `print.perGame` averaged Roubla and Dlala into one number. Leaving it in
  // the table would put a dead field on the cost-rules screen that looks
  // editable but is read by nothing.
  const RETIRED = ["print.perGame"];
  for (const key of RETIRED) {
    const gone = await db.financeSetting.deleteMany({ where: { key } });
    if (gone.count) console.log(`── retired ──
   - ${key} (replaced by per-product printing)`);
  }

  console.log("── accounts ──");
  for (const a of ACCOUNTS) {
    const found = await db.financeAccount.findUnique({ where: { key: a.key } });
    if (found) { console.log(`   = ${a.key} (kept)`); continue; }
    await db.financeAccount.create({ data: a });
    console.log(`   + ${a.key} — ${a.name} (${a.currency})`);
  }

  console.log("── categories ──");
  let catNew = 0;
  for (const c of CATEGORIES) {
    const found = await db.financeCategory.findUnique({ where: { key: c.key } });
    if (found) continue;
    await db.financeCategory.create({ data: c });
    catNew++;
  }
  console.log(`   + ${catNew} new, ${CATEGORIES.length - catNew} already there`);

  // The VALUE belongs to Nounouti — a number he corrected in the UI is never
  // overwritten. The label, unit, note and sort order are documentation and
  // belong to this file, so re-seeding refreshes them.
  console.log("── cost rules ──");
  for (const s of SETTINGS) {
    const found = await db.financeSetting.findUnique({ where: { key: s.key } });
    if (!found) {
      await db.financeSetting.create({ data: s });
      console.log(`   + ${s.key} = ${s.value}`);
      continue;
    }
    const stale = found.label !== s.label || found.unit !== s.unit || found.note !== s.note || found.sort !== s.sort;
    if (stale) {
      await db.financeSetting.update({
        where: { key: s.key },
        data: { label: s.label, unit: s.unit, note: s.note, sort: s.sort },
      });
      console.log(`   ~ ${s.key} = ${found.value} (kept your value, refreshed the wording)`);
    } else {
      console.log(`   = ${s.key} = ${found.value}`);
    }
  }

  // ── One real movement we already know for certain ──────────
  // Meta's API on 29 Aug 2026 reported €202.50 across the four Curio
  // campaigns (Roubla SECOND EDITION, Dllala, and the two test
  // campaigns) for 13–29 Aug. Seeding it means the profit figure is
  // true the first time the page opens, instead of flattering by
  // 56,700 DA because the largest variable cost is missing.
  //
  // Recorded as one lump on the 29th. Phase 4 replaces it with a
  // daily feed — and must delete this row when it backfills, or the
  // two will stack.
  const ADS_CENTS = 20250;                      // €202.50
  const ADS_NOTE = "Meta API, 13–29 Aug, Curio campaigns only — lump; phase 4 replaces with daily rows";
  const bank = await db.financeAccount.findUnique({ where: { key: "bank_eur" } });
  const already = await db.moneyMovement.findFirst({ where: { categoryKey: "ads_meta", note: ADS_NOTE } });
  // Once the Meta feed has written real daily rows, the lump is not just
  // redundant — it double-counts the same euros. The sync deletes it on its
  // first successful run, and re-seeding must not resurrect it.
  const daily = await db.moneyMovement.count({
    where: { categoryKey: "ads_meta", note: { startsWith: "[meta-sync" } },
  });
  if (daily > 0) {
    console.log("── ads ──");
    console.log(`   = ${daily} real daily rows from Meta; the seed lump stays retired`);
  } else if (bank && !already) {
    const fx = await db.financeSetting.findUnique({ where: { key: "fx.eurDzd" } });
    const rate = Number(fx?.value) || 280;              // DA per €1
    // cents → euros → dinars
    const amountDzd = Math.round((ADS_CENTS / 100) * rate);
    await db.moneyMovement.create({
      data: {
        occurredAt: new Date("2026-08-29T12:00:00.000Z"),
        direction: "out",
        accountId: bank.id,
        amount: ADS_CENTS,
        currency: "EUR",
        amountDzd,
        fxRate: Math.round(rate * 100),   // stored ×100 so the rate itself stays an integer
        categoryKey: "ads_meta",
        note: ADS_NOTE,
        createdBy: "seed",
      },
    });
    console.log(`── ads ──\n   + €${(ADS_CENTS / 100).toFixed(2)} = ${amountDzd.toLocaleString()} DA @ ${rate}`);
  } else if (already) {
    console.log("── ads ──\n   = already recorded (kept)");
  }

  // ── The brief token ──
  // A long random secret, generated once. It goes in a URL Nounouti pastes
  // into chats, so it must never be the admin key — this one can only read,
  // and revoking it costs nothing.
  const existing = await db.financeSetting.findUnique({ where: { key: "analytics.briefToken" } });
  if (!existing || existing.value.length < 24) {
    // A bearer secret needs a real CSPRNG, not Math.random.
    const token = randomBytes(24).toString("base64url");
    await db.financeSetting.upsert({
      where: { key: "analytics.briefToken" },
      update: { value: token },
      create: {
        key: "analytics.briefToken", value: token,
        label: "Claude brief token", unit: "secret",
        note: "The secret in the /api/analytics/brief link. Change this value to revoke every link you have shared.",
        sort: 50,
      },
    });
    console.log("── brief token ──");
    console.log("   + generated — the link is on the cost-rules screen");
  }

  const accounts = await db.financeAccount.count();
  const cats = await db.financeCategory.count();
  const settings = await db.financeSetting.count();
  const moves = await db.moneyMovement.count();
  console.log(`\nready — ${accounts} accounts · ${cats} categories · ${settings} cost rules · ${moves} movements`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await db.$disconnect(); });
