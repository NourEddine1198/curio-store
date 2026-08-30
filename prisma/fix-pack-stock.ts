// One-time correction for the pack double-count.
//
// ⚠️ This deliberately does NOT rebuild the counters from the print run.
// The first attempt did, and it subtracted 555 Phase-1 orders from a
// Phase-2 print run — the very mistake the project notes warn about.
//
// Instead it corrects ONLY the known bug: a pack sale decremented the
// pack's own counter and never touched the two real boxes. So for every
// bundle unit that is currently held by a live order, its components are
// reduced by one each, and the bundle's meaningless counter is zeroed.
//
//   npx tsx prisma/fix-pack-stock.ts          → dry run
//   npx tsx prisma/fix-pack-stock.ts --apply  → writes
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { physicalUnitsOf, isComposite } from "../src/lib/product-composition";
import { RESTOCK_FAMILY } from "../src/lib/order-status";

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const APPLY = process.argv.includes("--apply");

(async () => {
  // RUN ONCE, AND ONLY BEFORE THE NEW CODE IS LIVE.
  // Once moveStock is deployed, a pack order deducts its two components
  // correctly at checkout. This script cannot tell those apart from the old
  // broken ones, so a second pass would deduct the same boxes twice.
  const doneRow = await db.financeSetting.findUnique({ where: { key: "stock.packFixAppliedAt" } });
  if (doneRow?.value) {
    console.log("Already applied on " + doneRow.value + ". Refusing to run again - a second");
    console.log("pass would deduct the same components twice.");
    process.exit(0);
  }

  const openRow = await db.financeSetting.findUnique({ where: { key: "books.openFrom" } });
  const booksOpen = new Date(`${openRow?.value || "2026-08-13"}T00:00:00.000Z`);

  const orders = await db.order.findMany({
    select: {
      orderNumber: true, status: true, shippedAt: true, createdAt: true,
      items: { select: { quantity: true, product: { select: { slug: true } } } },
    },
  });

  // Only bundles that actually ate CURRENT stock count: shipped since the
  // books opened, or still live and unshipped. A pack delivered in Phase 1
  // came off a different print run and is none of this correction's business.
  const owed: Record<string, number> = {};
  let bundleUnits = 0;
  const touched: number[] = [];
  for (const o of orders) {
    if (RESTOCK_FAMILY.includes(o.status as never)) continue;
    const usedCurrentStock = o.shippedAt ? o.shippedAt >= booksOpen : o.createdAt >= booksOpen;
    if (!usedCurrentStock) continue;
    for (const it of o.items) {
      const slug = it.product?.slug || "";
      if (!isComposite(slug)) continue;
      bundleUnits += it.quantity;
      touched.push(o.orderNumber);
      for (const [part, per] of Object.entries(physicalUnitsOf(slug))) {
        owed[part] = (owed[part] || 0) + per * it.quantity;
      }
    }
  }

  console.log(APPLY ? "APPLYING" : "DRY RUN — nothing will be written");
  console.log(`books opened ${booksOpen.toISOString().slice(0, 10)}`);
  console.log(`${bundleUnits} bundle units came off current stock, across ${new Set(touched).size} orders`);
  console.log("");

  const products = await db.product.findMany({ select: { id: true, slug: true, stock: true } });
  const changes: { id: string; slug: string; from: number; to: number; why: string }[] = [];
  console.log("product              now      →   corrected   why");
  console.log("──────────────────────────────────────────────────────────────────");
  for (const p of products) {
    if (isComposite(p.slug)) {
      if (p.stock !== 0) changes.push({ id: p.id, slug: p.slug, from: p.stock, to: 0, why: "no shelf of its own — availability is now derived from its parts" });
      console.log(`${p.slug.padEnd(20)} ${String(p.stock).padStart(5)}  →  ${"0".padStart(9)}   derived from components`);
      continue;
    }
    const debt = owed[p.slug] || 0;
    if (debt === 0) { console.log(`${p.slug.padEnd(20)} ${String(p.stock).padStart(5)}  →  ${String(p.stock).padStart(9)}   untouched`); continue; }
    // Never write a negative shelf. Goul is retired at zero, so the twelve
    // Eid bundles that carried one cannot be deducted from a pile that is
    // already empty — the debt is real but historical, and a negative
    // counter would only break the availability check.
    const raw = p.stock - debt;
    const to = Math.max(0, raw);
    if (raw < 0) console.log(`   note: ${p.slug} would go to ${raw}; clamped to 0 (retired product, historical debt)`);
    changes.push({ id: p.id, slug: p.slug, from: p.stock, to, why: `${debt} units went out inside bundles and were never deducted` });
    console.log(`${p.slug.padEnd(20)} ${String(p.stock).padStart(5)}  →  ${String(to).padStart(9)}   −${debt} sold inside bundles`);
  }

  console.log("");
  if (!changes.length) { console.log("nothing to change."); process.exit(0); }
  if (!APPLY) {
    console.log(`${changes.length} counters would change. Re-run with --apply to write.`);
    console.log("⚠ Then COUNT A FEW REAL BOXES. A stock number nobody has checked against a shelf is a different kind of fiction.");
    process.exit(0);
  }
  for (const c of changes) {
    await db.product.update({ where: { id: c.id }, data: { stock: c.to } });
    console.log(`  ${c.slug}: ${c.from} → ${c.to}  (${c.why})`);
  }
  await db.financeSetting.create({
    data: {
      key: "stock.packFixAppliedAt", value: new Date().toISOString().slice(0, 10),
      label: "Pack stock correction applied", unit: "date",
      note: "One-time fix for the bundle double-count. Its presence stops this script running twice.",
      sort: 9100,
    },
  }).catch(() => {});
  console.log("done, and marked so it cannot run twice.");
  console.log("Count a few real boxes and tell me if it disagrees.");
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
