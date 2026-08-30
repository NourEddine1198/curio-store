import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildScoreboard, type Scoreboard } from "@/lib/scoreboard";
import type { PeriodKey } from "@/lib/finance";

// The machine brief — what a fresh Claude session reads.
//
// Reached by a SECRET TOKEN in the URL, not the admin key: you paste this
// link into a chat, and a link you paste around should never be the same
// credential that can edit orders. The token is revocable on its own and
// this route can only read.
//
//   /api/analytics/brief?token=…            → plain text (default; what an LLM wants)
//   /api/analytics/brief?token=…&format=json → the same numbers as JSON
//   &period=month | last30 | all
//
// Text is the default on purpose. A model reads a labelled brief with its
// caveats attached far more reliably than it reads nested JSON, and the
// caveats are the half that stops it drawing a confident wrong conclusion.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

const ADMIN_KEY = process.env.ADMIN_KEY;

/** Constant-time-ish compare so a wrong token can't be guessed by timing. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorised(request: NextRequest): Promise<boolean> {
  if (ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY) return true;
  const given = request.nextUrl.searchParams.get("token") || "";
  if (!given) return false;
  const row = await db.financeSetting.findUnique({ where: { key: "analytics.briefToken" } });
  const real = row?.value || "";
  // A short or missing token must never pass — an empty setting would
  // otherwise make the brief public the moment someone tried "?token=".
  if (real.length < 24) return false;
  return sameToken(given, real);
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function renderText(s: Scoreboard): string {
  const L: string[] = [];
  const rule = (t: string) => L.push("", `── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

  L.push("CURIO — BUSINESS BRIEF");
  L.push(`Generated ${s.generatedAt} · window: ${s.window.label} (${s.window.from} → ${s.window.to}, ${s.window.days} days)`);
  L.push("");
  L.push("You are reading a machine brief written for an AI assistant. Every number");
  L.push("below carries its formula and its limits. Read the CAVEATS section before");
  L.push("drawing conclusions — several numbers look more solid than they are.");

  rule("THE TWO NUMBERS THAT MATTER");
  const ns = s.northStars;
  L.push(`Profit per delivered order : ${fmt(ns.profitPerDeliveredOrder.value)} ${ns.profitPerDeliveredOrder.unit}`);
  L.push(`   formula: ${ns.profitPerDeliveredOrder.formula}`);
  L.push(`Return on ad spend         : ${ns.returnOnAdSpend.value}${ns.returnOnAdSpend.unit.startsWith("×") ? "×" : ""}`);
  L.push(`   formula: ${ns.returnOnAdSpend.formula}`);
  L.push(`   note: ${ns.returnOnAdSpend.caveat}`);

  rule("FUNNEL");
  const f = s.funnel;
  L.push(`placed ${f.placed} → confirmed ${f.confirmed} (${f.confirmRate}% of real leads) → shipped ${f.shipped} → delivered ${f.delivered}`);
  L.push(`returned ${f.returned} · cancelled/expired ${f.lost} · junk (wrong number, duplicate) ${f.junk} · still open ${f.stillOpen}`);
  L.push(`delivery rate ${f.deliveryRate}% · return rate ${f.returnRate}%   [both of resolved orders only]`);

  rule("MONEY");
  const m = s.money;
  L.push(`collected ${fmt(m.collected)} − courier fees ${fmt(m.courierFees)} = net ${fmt(m.netRevenue)} DA`);
  for (const [k, v] of Object.entries(m.costs)) if (v) L.push(`   − ${k.padEnd(18)} ${fmt(v).padStart(9)}`);
  L.push(`PROFIT ${fmt(m.profit)} DA`);
  L.push(`Ecotrack still owes ${fmt(m.receivable)} DA · ${fmt(m.inTransit)} DA in transit (not owed yet)`);

  rule("PRODUCTS");
  for (const p of s.products) {
    L.push(`${p.name} (${p.slug})`);
    L.push(`   delivered ${p.unitsDelivered} units · ${p.unitsPerWeek}/week · gross margin ${fmt(p.grossMarginPerUnit)} DA/unit`);
    L.push(`      (gross margin = product revenue − printing − wrapping. It does NOT include the`);
    L.push(`       courier fee, the agent fee, ads or returns, so it is always higher than the`);
    L.push(`       profit-per-delivered-order figure at the top.)`);
    L.push(`   stock ${fmt(p.stock)}${p.composite ? " (BUNDLE — derived from its components; do NOT add it to their stock)" : ""}${p.weeksOfStock != null ? ` · ${p.weeksOfStock} weeks left` : ""}${p.reorderBy ? ` · REORDER BY ${p.reorderBy}` : ""}`);
  }

  rule("BASKET — the cheapest lever you have");
  const b = s.basket;
  L.push(`average order value ${fmt(b.aov)} DA · ${b.gamesPerOrder} games per order`);
  L.push(`orders with more than one game: ${b.bundleShare}%` +
    (b.phase1BundleShare != null ? `   [Phase 1 was ${b.phase1BundleShare}% — see caveats]` : ""));
  L.push(`upsells: ${b.websiteUpsells} taken on the website, ${b.phoneUpsells} sold by the agent on the phone`);

  rule("GEOGRAPHY — by delivery tier, not by wilaya");
  for (const t of s.tiers) {
    L.push(`${t.tier.padEnd(13)} ${String(t.wilayas).padStart(2)} wilayas · placed ${String(t.placed).padStart(3)} · delivered ${t.deliveryRate}% · returned ${t.returnRate}% · ${fmt(t.revenue)} DA`);
  }
  L.push(`home delivery  : ${s.channel.home.placed} placed, ${s.channel.home.rate}% delivered`);
  L.push(`stop-desk      : ${s.channel.stopdesk.placed} placed, ${s.channel.stopdesk.rate}% delivered`);

  rule("ADVERTISING");
  L.push(`spend ${fmt(s.ads.spend)} DA · ${fmt(s.ads.costPerDeliveredOrder)} DA per delivered sale · blended return ${s.ads.blendedReturn}×`);
  L.push(`traceable to a campaign: ${s.ads.tracedOrders} orders (${s.ads.tracedShare}%)`);
  for (const c of s.ads.perCampaign.slice(0, 8)) {
    L.push(`   ${c.campaign.padEnd(22)} ${String(c.orders).padStart(3)} orders · ${c.delivered} delivered · ${fmt(c.revenue)} DA`);
  }

  rule("REPEAT BUYING");
  L.push(`${s.repeat.repeatBuyers} of ${s.repeat.customers} customers have ordered more than once (${s.repeat.repeatShare}%)`);
  L.push(`${s.repeat.ordersFromReturning} orders in this window came from someone who had bought before`);

  rule("TARGETS");
  for (const t of s.targets) {
    const verdict = t.met === null ? "NO TARGET SET" : t.met ? "on track" : "OFF TRACK";
    L.push(`${t.label.padEnd(32)} actual ${fmt(t.actual)}${t.unit === "%" ? "%" : " " + t.unit}` +
      (t.target != null ? ` · target ${t.direction === "below" ? "≤" : "≥"} ${fmt(t.target)} · ${verdict}` : ` · ${verdict}`));
  }

  rule("WEEK BY WEEK");
  L.push("week starting   placed  delivered      revenue     ad spend");
  for (const w of s.weekly) {
    L.push(`${w.weekStart}     ${String(w.placed).padStart(4)}   ${String(w.delivered).padStart(6)}   ${fmt(w.revenue).padStart(10)}   ${fmt(w.adSpend).padStart(10)}`);
  }

  if (s.changes.length) {
    rule("WHAT MOVED — latest week vs the one before");
    for (const c of s.changes) {
      L.push(`${c.label.padEnd(20)} ${fmt(c.before)} → ${fmt(c.now)} ${c.unit} (${c.changePct >= 0 ? "+" : ""}${c.changePct}%)`);
    }
  }

  rule("CAVEATS — read these before concluding anything");
  s.caveats.forEach((c, i) => L.push(`${i + 1}. ${c}`));

  rule("DEFINITIONS");
  for (const [k, v] of Object.entries(s.definitions)) L.push(`${k}: ${v}`);

  L.push("");
  L.push("── END. This brief is read-only and computed live; nothing here is stored.");
  return L.join("\n");
}

export async function GET(request: NextRequest) {
  if (!(await authorised(request))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get("period");
  const period = (["month", "last30", "all"].includes(raw || "") ? raw : "month") as PeriodKey;

  try {
    const board = await buildScoreboard(period);
    if (request.nextUrl.searchParams.get("format") === "json") {
      return NextResponse.json(board);
    }
    return new NextResponse(renderText(board), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("GET /api/analytics/brief error:", error);
    return NextResponse.json({ error: "Failed to build the brief" }, { status: 500 });
  }
}
