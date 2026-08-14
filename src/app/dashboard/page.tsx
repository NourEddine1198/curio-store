"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ─────────────────────────────────────────────────────────────
// Curio — Command Center (READ-ONLY) · "Soft + Warm" rebuild
// Three altitudes: Pulse (glance) · Daily (per product) · War Room
// (weekly deep-dive). Reads real data via /api/dashboard. Cost
// numbers are editable + saved in THIS browser. Ad metrics are
// clearly-labeled estimates until Meta is connected.
// ─────────────────────────────────────────────────────────────

const ADMIN_KEY_STORAGE = "curio-admin-key";
const SETTINGS_STORAGE = "curio-cc-settings-v2";

type PeriodKey = "today" | "week" | "month" | "all";
type TrendKey = "today" | "week" | "month";

interface Funnel {
  pending: number; confirmed: number; in_transit: number;
  delivered: number; returned: number; cancelled: number;
}
interface PerProduct { orders: number; deliveredUnits: number; deliveredRevenue: number; returned: number; attempts: number; }
interface PeriodMetrics {
  label: string; days: number; orders: number; funnel: Funnel;
  confirmedRevenue: number; deliveredRevenue: number;
  confirmedCount: number; deliveredCount: number; returnedCount: number; inTransitCount: number; attempts: number;
  returns: { count: number; ratePct: number };
  perProductDeliveredUnits: Record<string, number>;
  perProduct: Record<string, PerProduct>;
}
interface FailWindow {
  count: number;
  lostPct: number;
  byReason: { reason: string; count: number }[];
}
interface CallbackRow {
  phone: string; name: string | null; reason: string; message: string;
  wilayaCode: string | null; page: string | null; at: string; tries: number;
}
interface CheckoutFailures {
  today: FailWindow; week: FailWindow; month: FailWindow;
  botsToday: number; botsMonth: number;
  callback: CallbackRow[];
  oldest: string | null;
}
interface DashboardData {
  generatedAt: string;
  totalOrdersAllTime: number;
  trend: Record<TrendKey, { current: number; previous: number }>;
  periods: Record<PeriodKey, PeriodMetrics>;
  weekly: { weekStart: string; orders: number; deliveredRevenue: number }[];
  inventory: { slug: string; name: string; nameEn: string | null; stock: number; price: number }[];
  checkoutFailures?: CheckoutFailures;
  ecotrack: { ok: boolean; error: string | null; ordersInEcotrack: number; matchedToStore: number; globalStatusCounts: Record<string, number> };
}

// Plain English for each machine reason code. Mirrors FAILURE_LABELS in
// src/lib/checkout-failures.ts — an unknown code falls back to the raw code
// rather than hiding the row.
const FAIL_LABELS: Record<string, string> = {
  name_missing: "Name missing or too short",
  phone_invalid: "Phone number invalid",
  phone2_invalid: "Backup phone invalid",
  wilaya_missing: "No wilaya chosen",
  wilaya_unavailable: "Wilaya refused — not in our delivery list",
  wilaya_no_price: "Wilaya has no delivery price set",
  delivery_type_invalid: "Delivery type invalid",
  address_too_short: "Address missing or too short",
  commune_missing: "No commune chosen",
  office_missing: "No stop-desk chosen",
  items_empty: "Empty cart",
  items_too_many: "Too many different products",
  product_unavailable: "A product was inactive or unknown",
  product_unknown: "Product not found",
  out_of_stock: "Not enough stock",
  coupon_rejected: "Coupon rejected",
  rate_limit_ip: "Blocked — too many orders from one connection",
  rate_limit_phone: "Blocked — too many orders from one phone",
  server_error: "Server error — our fault",
  bot_honeypot: "Bot trap: hidden field filled",
  bot_speed_trap: "Bot trap: submitted in under 3 seconds",
};
const failLabel = (r: string) => FAIL_LABELS[r] || r;

// Reasons that mean WE broke, not the customer mistyping. These are the ones
// worth waking up for — the wilaya bug lived in this family for five weeks.
const OUR_FAULT = new Set([
  "wilaya_unavailable", "wilaya_no_price", "product_unavailable",
  "product_unknown", "out_of_stock", "server_error", "coupon_rejected",
]);

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const h = Math.floor(mins / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

interface ProductSetting { label: string; unitCost: number; printRun: number; }
interface Settings {
  products: Record<string, ProductSetting>;
  defaultUnitCost: number; wrapping: number; confirmation: number; codFee: number;
  returnFee: number; rentPerMonth: number; adCostPerOrder: number; cashOnHand: number;
  adTargetPerSale: number; reorderDays: number;
}

const DEFAULT_SETTINGS: Settings = {
  products: {
    roubla: { label: "Roubla", unitCost: 610, printRun: 2000 },
    dlala: { label: "Dlala", unitCost: 610, printRun: 1000 },
    origami: { label: "Origami", unitCost: 760, printRun: 3000 },
    "goul-bla-matgoul": { label: "Goul Bla Matgoul", unitCost: 610, printRun: 0 },
    "eid-2026-bundle": { label: "Eid Pack", unitCost: 1220, printRun: 0 },
  },
  defaultUnitCost: 610, wrapping: 30, confirmation: 120, codFee: 0,
  returnFee: 250, rentPerMonth: 15000, adCostPerOrder: 450, cashOnHand: 0,
  adTargetPerSale: 500, reorderDays: 21,
};

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed, products: { ...DEFAULT_SETTINGS.products, ...(parsed.products || {}) } };
  } catch { return DEFAULT_SETTINGS; }
}

function fmt(n: number): string { if (!isFinite(n)) return "—"; return Math.round(n).toLocaleString("en-US"); }
function fmtC(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1) + "M";
  if (abs >= 10_000) return (n / 1000).toFixed(0) + "k";
  return fmt(n);
}
function trendPct(cur: number, prev: number): { txt: string; dir: "up" | "down" | "flat" } {
  if (prev === 0) return { txt: cur > 0 ? "new" : "—", dir: cur > 0 ? "up" : "flat" };
  const pct = ((cur - prev) / prev) * 100;
  const dir = pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat";
  return { txt: (pct >= 0 ? "+" : "") + pct.toFixed(0) + "%", dir };
}

interface ProfitBreakdown { revenue: number; cogs: number; adCost: number; wrapping: number; confirmation: number; cod: number; returnCost: number; rent: number; profit: number; }
function computeProfit(p: PeriodMetrics, s: Settings, metaSpend: number | null): ProfitBreakdown {
  let cogs = 0;
  for (const [slug, units] of Object.entries(p.perProductDeliveredUnits || {})) {
    cogs += units * (s.products[slug]?.unitCost ?? s.defaultUnitCost);
  }
  const adCost = metaSpend != null ? metaSpend : s.adCostPerOrder * p.attempts;
  const wrapping = s.wrapping * p.attempts;
  const confirmation = s.confirmation * p.deliveredCount;
  const cod = s.codFee * p.deliveredCount;
  const returnCost = s.returnFee * p.returnedCount;
  const rent = s.rentPerMonth * (p.days / 30);
  const profit = p.deliveredRevenue - cogs - confirmation - cod - wrapping - adCost - returnCost - rent;
  return { revenue: p.deliveredRevenue, cogs, adCost, wrapping, confirmation, cod, returnCost, rent, profit };
}
function productProfit(pp: PerProduct, slug: string, s: Settings): number {
  const unitCost = s.products[slug]?.unitCost ?? s.defaultUnitCost;
  return pp.deliveredRevenue - pp.deliveredUnits * unitCost - s.adCostPerOrder * pp.attempts
    - s.wrapping * pp.attempts - s.confirmation * pp.orders - s.codFee * pp.orders - s.returnFee * pp.returned;
}

export default function CommandCenter() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  useEffect(() => {
    setSettings(loadSettings());
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const fetchData = useCallback(async (key: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/dashboard", { headers: { "X-Admin-Key": key } });
      if (res.status === 401) {
        setAdminKey(""); window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setLoginError(true); setData(null); return;
      }
      if (!res.ok) throw new Error("server " + res.status);
      setData((await res.json()) as DashboardData);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (adminKey) fetchData(adminKey); }, [adminKey, fetchData]);

  function tryLogin() {
    const key = keyInput.trim(); if (!key) return;
    setLoginError(false); window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key); setAdminKey(key);
  }
  function logout() { window.sessionStorage.removeItem(ADMIN_KEY_STORAGE); setAdminKey(""); setData(null); setKeyInput(""); }
  function saveSettings(next: Settings) { setSettings(next); window.localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(next)); }
  function updateSetting(field: keyof Settings, value: number) { saveSettings({ ...settings, [field]: value }); }
  function updateProduct(slug: string, field: keyof ProductSetting, value: number) {
    const prev = settings.products[slug] || { label: slug, unitCost: settings.defaultUnitCost, printRun: 0 };
    saveSettings({ ...settings, products: { ...settings.products, [slug]: { ...prev, [field]: value } } });
  }
  function copySettings() {
    navigator.clipboard?.writeText(JSON.stringify(settings)).then(
      () => { setSyncMsg("Copied! Paste it on your other device."); setTimeout(() => setSyncMsg(""), 4000); },
      () => setSyncMsg("Copy failed — select the text manually.")
    );
  }
  function pasteSettings() {
    const txt = window.prompt("Paste your settings code here:"); if (!txt) return;
    try { saveSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(txt), products: { ...DEFAULT_SETTINGS.products, ...(JSON.parse(txt).products || {}) } }); setSyncMsg("Settings applied ✓"); setTimeout(() => setSyncMsg(""), 4000); }
    catch { setSyncMsg("That didn't look like a valid settings code."); }
  }

  const metaSpend: number | null = null; // Meta not connected yet — profit/ads use estimates.

  const cur = data?.periods[period];
  const today = data?.periods.today;
  const week = data?.periods.week;
  const all = data?.periods.all;
  const profit = useMemo(() => (cur ? computeProfit(cur, settings, metaSpend) : null), [cur, settings]);
  const labelFor = useCallback((slug: string, name?: string) => settings.products[slug]?.label || name || slug, [settings]);

  // Days of cover per product (velocity from the 30-day window).
  const coverFor = useCallback((slug: string, stock: number): number => {
    const m = data?.periods.month;
    const units = m?.perProduct[slug]?.deliveredUnits ?? 0;
    const perDay = units / (m?.days || 30);
    return perDay > 0 ? stock / perDay : Infinity;
  }, [data]);

  // Break-even on the combined print runs (estimate, all-time).
  const breakEven = useMemo(() => {
    if (!all) return null;
    const pb = computeProfit(all, settings, null);
    const contribution = all.deliveredCount > 0 ? (pb.profit + pb.rent) / all.deliveredCount : 0;
    let runCost = 0;
    for (const ps of Object.values(settings.products)) runCost += (ps.printRun || 0) * (ps.unitCost || 0);
    const beUnits = contribution > 0 ? runCost / contribution : Infinity;
    const pct = isFinite(beUnits) && beUnits > 0 ? Math.min(100, (all.deliveredCount / beUnits) * 100) : 0;
    return { contribution, runCost, beUnits, delivered: all.deliveredCount, pct };
  }, [all, settings]);

  // Cash frozen in unsold stock.
  const frozenStock = useMemo(() => {
    if (!data) return 0;
    return data.inventory.reduce((sum, p) => sum + p.stock * (settings.products[p.slug]?.unitCost ?? settings.defaultUnitCost), 0);
  }, [data, settings]);

  // Checkout failures for the currently selected window ("all" has no
  // equivalent — the log only keeps 30 days, so it reads as the month).
  const fails = useMemo(() => {
    const cf = data?.checkoutFailures;
    if (!cf) return null;
    return period === "today" ? cf.today : period === "week" ? cf.week : cf.month;
  }, [data, period]);

  // Auto-insights for the "Ask Claude" panel (rule-based now; AI later).
  const insights = useMemo(() => {
    const out: { icon: string; head: string; body: string }[] = [];
    if (!cur || !data || !profit) return out;

    // Highest priority: customers being turned away right now. A single
    // our-fault reason repeating is what a real outage looks like.
    const cf = data.checkoutFailures;
    if (cf && cf.today.count > 0) {
      const worst = cf.today.byReason.find((r) => OUR_FAULT.has(r.reason));
      if (worst && worst.count >= 3) {
        out.push({ icon: "🚨", head: "Checkout is turning people away", body: `${worst.count} customers today hit "${failLabel(worst.reason)}". That is our bug, not theirs — check it before spending another dinar on ads.` });
      } else {
        out.push({ icon: "🚨", head: "Lost checkouts today", body: `${cf.today.count} ${cf.today.count === 1 ? "person" : "people"} tried to order and couldn't (${cf.today.lostPct.toFixed(0)}% of attempts). See "Lost checkouts" below for their numbers.` });
      }
    }

    for (const p of data.inventory) {
      const pp = cur.perProduct[p.slug];
      if (pp && pp.orders + pp.returned >= 4) {
        const rr = (pp.returned / (pp.orders + pp.returned)) * 100;
        if (rr > 18) out.push({ icon: "↩︎", head: "High returns", body: `${labelFor(p.slug, p.name)} returns are ${rr.toFixed(0)}% — tighten phone confirmation (re-check address & delivery day).` });
      }
      const cover = coverFor(p.slug, p.stock);
      if (isFinite(cover) && cover < settings.reorderDays) out.push({ icon: "📦", head: "Reprint soon", body: `${labelFor(p.slug, p.name)}: ~${Math.round(cover)} days of stock left — start a reprint now (lead times are long).` });
    }
    if (profit.profit < 0) out.push({ icon: "⚠️", head: "Running at a loss", body: `Net profit is negative for ${cur.label.toLowerCase()} — check total ad spend vs the estimate, and the return rate.` });
    if (out.length === 0) out.push({ icon: "✅", head: "All healthy", body: "Nothing urgent right now — profit positive, stock fine, returns in range." });
    return out.slice(0, 3);
  }, [cur, data, profit, settings, coverFor, labelFor]);

  // ─── LOGIN ───
  if (!adminKey) {
    return (
      <div className="cc"><Style />
        <div className="cc-login">
          <div className="cc-login-card">
            <div className="cc-logo">Curio</div>
            <h1>Command Center</h1>
            <p className="cc-muted">Enter your admin key to see the business.</p>
            <input className="cc-input" type="password" placeholder="Admin key" value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tryLogin()} autoFocus />
            {loginError && <div className="cc-err">Wrong key — try again.</div>}
            <button className="cc-btn cc-primary cc-wfull" onClick={tryLogin}>Open the Command Center</button>
            <p className="cc-tiny cc-muted">Read-only · nothing here can change your orders.</p>
          </div>
        </div>
      </div>
    );
  }

  const t = data && period !== "all" ? data.trend[period as TrendKey] : null;
  const tr = t ? trendPct(t.current, t.previous) : null;
  const todayProfit = today ? computeProfit(today, settings, metaSpend) : null;
  const weekProfit = week ? computeProfit(week, settings, metaSpend) : null;
  const todayTr = data ? trendPct(data.trend.today.current, data.trend.today.previous) : null;
  const maxWeekly = data ? Math.max(1, ...data.weekly.map((w) => w.orders)) : 1;
  const confRate = cur && cur.orders > 0 ? ((cur.funnel.confirmed + cur.funnel.in_transit + cur.funnel.delivered + cur.funnel.returned) / cur.orders) * 100 : 0;

  return (
    <div className="cc"><Style />
      {/* top bar */}
      <header className="cc-bar">
        <div className="cc-bar-l"><span className="cc-brand">Curio</span><span className="cc-bar-sub">Command Center</span></div>
        <div className="cc-bar-r">
          {data && <span className="cc-tiny cc-muted">updated {new Date(data.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
          <button className="cc-btn cc-ghost" onClick={() => fetchData(adminKey)} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button className="cc-btn cc-ghost" onClick={() => setShowSettings(true)}>⚙ Costs</button>
          <button className="cc-btn cc-ghost" onClick={logout}>Logout</button>
        </div>
      </header>

      {error && <div className="cc-wrap"><div className="cc-alert">Couldn&apos;t load: {error}. Try ↻.</div></div>}
      {!data && loading && <div className="cc-loading">Loading your business…</div>}

      {data && cur && profit && (
        <div className="cc-wrap">

          {/* ───── PULSE ───── */}
          <div className="cc-sect"><span className="cc-badge">The Pulse</span><h2>Your glance</h2><span className="cc-when">📱 today</span></div>
          <div className="cc-pulse">
            <div className="cc-lbl">Orders today</div>
            <div className="cc-hero"><span className="cc-heronum">{fmt(today?.orders ?? 0)}</span>{todayTr && todayTr.dir !== "flat" && <span className={"cc-up " + (todayTr.dir === "down" ? "cc-bad" : "")}>{todayTr.dir === "up" ? "▲" : "▼"} {todayTr.txt}</span>}</div>
            <div className="cc-profit">profit today&nbsp; <b>DA {fmtC(todayProfit?.profit ?? 0)}</b></div>
            <div className="cc-twins">
              <div className="cc-twin"><div className="cc-lbl">Orders / week</div><div className="cc-twv">{fmt(week?.orders ?? 0)}</div></div>
              <div className="cc-twin"><div className="cc-lbl">Profit / week</div><div className="cc-twv">{fmtC(weekProfit?.profit ?? 0)}</div></div>
            </div>
            <div className="cc-spark">{data.weekly.map((w, i) => (<i key={i} style={{ height: Math.max(8, (w.orders / maxWeekly) * 100) + "%" }} className={i === data.weekly.length - 1 ? "cc-spark-last" : ""} />))}</div>
            {insights[0] && insights[0].head === "All healthy"
              ? <div className="cc-chip cc-chip-good">✅ All good — nothing needs you right now.</div>
              : insights.slice(0, 2).map((ins, i) => (<div key={i} className="cc-chip cc-chip-warn">{ins.icon} {ins.body}</div>))}
          </div>

          {/* period toggle for Daily + War Room */}
          <div className="cc-periods">
            <span className="cc-tiny cc-muted">Daily &amp; War Room window:</span>
            {(["today", "week", "month", "all"] as PeriodKey[]).map((p) => (
              <button key={p} className={"cc-pbtn " + (period === p ? "cc-pbtn-on" : "")} onClick={() => setPeriod(p)}>
                {p === "today" ? "Today" : p === "week" ? "7 days" : p === "month" ? "30 days" : "All time"}
              </button>
            ))}
          </div>

          {/* ───── DAILY ───── */}
          <div className="cc-sect"><span className="cc-badge">The Daily</span><h2>How&apos;s each product doing?</h2><span className="cc-when">{cur.label}</span></div>
          <div className="cc-grid2">
            {data.inventory.map((p) => {
              const pp = cur.perProduct[p.slug] || { orders: 0, deliveredUnits: 0, deliveredRevenue: 0, returned: 0, attempts: 0 };
              const prof = productProfit(pp, p.slug, settings);
              const denom = pp.orders + pp.returned;
              const rr = denom > 0 ? (pp.returned / denom) * 100 : 0;
              const adSale = settings.adCostPerOrder;
              const accent = ["#e0a91a", "#e0654c", "#3a5b8c", "#7a5ea8", "#2f8f6a"][data.inventory.indexOf(p) % 5];
              const status = pp.orders === 0 ? { c: "st-steady", t: "no sales" } : rr > 15 ? { c: "st-warn", t: "returns ▲" } : prof >= 0 ? { c: "st-good", t: "▲ healthy" } : { c: "st-warn", t: "watch" };
              return (
                <div key={p.slug} className="cc-pcard">
                  <div className="cc-accent" style={{ background: accent }} />
                  <div className="cc-pcard-in">
                    <div className="cc-pcard-row"><h3><span className="cc-dot" style={{ background: accent }} />{labelFor(p.slug, p.name)}</h3><span className={"cc-status " + status.c}>{status.t}</span></div>
                    <div className="cc-plabel">Profit · {cur.label.toLowerCase()}</div>
                    <div className="cc-big"><small>DA</small> {fmtC(prof)}</div>
                    <div className="cc-sub">{fmt(pp.orders)} delivered</div>
                    <div className="cc-chips">
                      <div className="cc-chipm"><div className="cc-mv">{fmt(pp.orders)}</div><div className="cc-ml">Orders</div></div>
                      <div className="cc-chipm cc-mute"><div className="cc-mv">{fmt(adSale)}</div><div className="cc-ml">Ad/sale·est</div></div>
                      <div className={"cc-chipm " + (rr <= 15 ? "cc-good" : "cc-warn")}><div className="cc-mv">{rr.toFixed(0)}%</div><div className="cc-ml">Returns</div></div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ───── WAR ROOM ───── */}
          <div className="cc-sect"><span className="cc-badge">The War Room</span><h2>Money truth &amp; moves</h2><span className="cc-when">{cur.label}</span></div>

          <div className="cc-truth">
            <div className="cc-tile cc-tile-hero">
              <div className="cc-lbl">Net profit · {cur.label.toLowerCase()}</div>
              <div className={"cc-big " + (profit.profit >= 0 ? "cc-ok" : "cc-bad")}>{profit.profit >= 0 ? "" : "−"}<small>DA</small> {fmtC(Math.abs(profit.profit))}</div>
              {tr && <div className="cc-note">{tr.dir === "up" ? "▲" : tr.dir === "down" ? "▼" : "▬"} {tr.txt} vs prev · after everything</div>}
            </div>
            <div className="cc-tile">
              <div className="cc-lbl">Break-even · print runs</div>
              <div className="cc-big">{breakEven && isFinite(breakEven.beUnits) ? Math.round(breakEven.pct) : "—"}<small>%</small></div>
              <div className="cc-pbar"><i style={{ width: (breakEven?.pct ?? 0) + "%" }} /></div>
              <div className="cc-note">{breakEven && isFinite(breakEven.beUnits) ? `${fmt(breakEven.delivered)} / ${fmt(breakEven.beUnits)} delivered · est` : "set print runs in ⚙"}</div>
            </div>
            <div className="cc-tile">
              <div className="cc-lbl">Cash position</div>
              <div className="cc-big"><small>DA</small> {fmtC(settings.cashOnHand)}</div>
              <div className="cc-split"><i className="cc-onhand" style={{ width: (settings.cashOnHand + frozenStock > 0 ? (settings.cashOnHand / (settings.cashOnHand + frozenStock)) * 100 : 0) + "%" }} /><i className="cc-frozen" style={{ width: (settings.cashOnHand + frozenStock > 0 ? (frozenStock / (settings.cashOnHand + frozenStock)) * 100 : 100) + "%" }} /></div>
              <div className="cc-legend"><span><b style={{ background: "#1f7a52" }} />on hand {fmtC(settings.cashOnHand)}</span><span><b style={{ background: "#c98a1b" }} />in stock {fmtC(frozenStock)}</span></div>
              {settings.cashOnHand === 0 && <div className="cc-tiny cc-muted">add cash-on-hand in ⚙</div>}
            </div>
            <div className="cc-tile">
              <div className="cc-lbl">Ad spend · est</div>
              <div className="cc-big"><small>DA</small> {fmtC(profit.adCost)}</div>
              <div className="cc-note">MER {profit.adCost > 0 ? (cur.deliveredRevenue / profit.adCost).toFixed(1) + "×" : "—"} · estimate</div>
            </div>
          </div>

          {/* Ask Claude */}
          <div className="cc-ask">
            <div className="cc-ask-tag"><span className="cc-brainbox">🧠</span><span className="cc-ask-k">Curio brain · this {cur.label.toLowerCase()}&apos;s read</span></div>
            <h3>Here&apos;s what I&apos;d look at</h3>
            <div className="cc-moves">
              {insights.map((ins, i) => (<div key={i} className="cc-move"><div className="cc-move-h">{ins.icon} {ins.head}</div><p>{ins.body}</p></div>))}
            </div>
            <div className="cc-askfield"><span>Full AI analysis (&quot;what should I do this week?&quot;) plugs in next — Phase 3.</span><span className="cc-go">Soon</span></div>
          </div>

          {/* Ads — needs Meta */}
          <div className="cc-sect-sm"><h3>🎯 Ads — kill or scale</h3><span className="cc-pill-soon">CONNECT META TO LIGHT UP</span></div>
          <div className="cc-card cc-dashed">
            <p className="cc-muted cc-sm">Connect Meta (Marketing API) and this fills with real <b>cost per delivered sale</b> per ad vs your {fmt(settings.adTargetPerSale)} DA line, <b>MER</b>, and 🟢 scale / 🔴 kill flags. Until then profit uses your <b>{fmt(settings.adCostPerOrder)} DA/order estimate</b>.</p>
            <p className="cc-tiny cc-muted">💡 Tip from research: name every campaign by product (<code>roubla_…</code>, <code>goul_…</code>) so per-product ad cost is automatic later.</p>
          </div>

          {/* Stock */}
          <div className="cc-sect-sm"><h3>📦 Stock — what to reprint</h3><span className="cc-when">days of cover</span></div>
          <div className="cc-card">
            {data.inventory.map((p) => {
              const cover = coverFor(p.slug, p.stock);
              const run = settings.products[p.slug]?.printRun ?? 0;
              const low = isFinite(cover) && cover < settings.reorderDays;
              const accent = ["#e0a91a", "#e0654c", "#3a5b8c", "#7a5ea8", "#2f8f6a"][data.inventory.indexOf(p) % 5];
              const coverPct = isFinite(cover) ? Math.min(100, (cover / (settings.reorderDays * 3)) * 100) : 100;
              return (
                <div key={p.slug} className="cc-srow">
                  <div className="cc-sname"><span className="cc-dot" style={{ background: accent }} />{labelFor(p.slug, p.name)}{run > 0 && <small> · {Math.round((1 - p.stock / run) * 100)}% of run sold</small>}</div>
                  <div className="cc-scover"><span className={"cc-cval " + (low ? "cc-bad" : "")}>{isFinite(cover) ? Math.round(cover) + " days" : "—"}</span><div className="cc-coverbar"><i style={{ width: coverPct + "%", background: low ? "#e0654c" : "#1f7a52" }} /></div></div>
                  <div className="cc-sstock">{fmt(p.stock)}<small> in stock</small></div>
                  <div>{low ? <span className="cc-pill cc-kill">Reprint now</span> : isFinite(cover) && cover < settings.reorderDays * 2 ? <span className="cc-pill cc-watch">Watch</span> : <span className="cc-pill cc-scale">Fine</span>}</div>
                </div>
              );
            })}
          </div>

          {/* ───── LOST CHECKOUTS ───── */}
          <div className="cc-sect-sm">
            <h3>🚨 Lost checkouts — people who tried and couldn&apos;t</h3>
            <span className="cc-when">{period === "today" ? "today" : period === "week" ? "last 7 days" : "last 30 days"}</span>
          </div>
          {!data.checkoutFailures ? (
            <div className="cc-card cc-dashed"><p className="cc-muted cc-sm">Not recording yet — deploy the store API to start the log.</p></div>
          ) : (
            <div className="cc-card cc-card-pad">
              <div className="cc-fhead">
                <div className={"cc-fbig " + (fails && fails.count > 0 ? "cc-bad" : "cc-ok")}>
                  {fmt(fails?.count ?? 0)}<small>{(fails?.count ?? 0) === 1 ? " person" : " people"}</small>
                </div>
                <div className="cc-fmeta">
                  <div className="cc-lbl">{(fails?.lostPct ?? 0).toFixed(0)}% of everyone who pressed &quot;order&quot;</div>
                  <div className="cc-tiny cc-muted">
                    {data.checkoutFailures.oldest
                      ? "watching since " + new Date(data.checkoutFailures.oldest).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                      : "watching — nothing logged yet"}
                    {data.checkoutFailures.botsMonth > 0 && <> · {fmt(data.checkoutFailures.botsMonth)} bot attempts blocked (not counted)</>}
                  </div>
                </div>
              </div>

              {(fails?.count ?? 0) === 0 ? (
                <div className="cc-chip cc-chip-good cc-mt">✅ Nobody was turned away. Every person who pressed &quot;order&quot; got an order.</div>
              ) : (
                <>
                  <div className="cc-freasons">
                    {fails?.byReason.map((r) => {
                      const ours = OUR_FAULT.has(r.reason);
                      const pct = fails.count > 0 ? (r.count / fails.count) * 100 : 0;
                      return (
                        <div key={r.reason} className="cc-frow">
                          <div className="cc-fname">
                            {ours && <span className="cc-pill cc-kill">our bug</span>}
                            {failLabel(r.reason)}
                          </div>
                          <div className="cc-fbar"><i style={{ width: Math.max(3, pct) + "%", background: ours ? "#e0654c" : "#c98a1b" }} /></div>
                          <div className="cc-fcount">{fmt(r.count)}</div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="cc-tiny cc-muted cc-mt">
                    <b>&quot;our bug&quot;</b> = the site refused them for a reason they couldn&apos;t fix (wilaya, stock, coupon, crash). Those are the ones to chase.
                    The rest are usually typos — a phone in the wrong format, a missing address.
                  </p>
                </>
              )}

              {data.checkoutFailures.callback.length > 0 && (
                <>
                  <div className="cc-card-h cc-mt"><h4>📞 Call these people back</h4></div>
                  <p className="cc-tiny cc-muted">They left a phone number, never got an order, and haven&apos;t ordered since. Newest first.</p>
                  <div className="cc-ftable">
                    <div className="cc-ftr cc-fth"><span>Who</span><span>Wilaya</span><span>What stopped them</span><span>When</span><span /></div>
                    {data.checkoutFailures.callback.map((c) => (
                      <div key={c.phone} className="cc-ftr">
                        <span className="cc-fwho"><b>{c.name || "—"}</b><small>{c.phone}{c.tries > 1 && ` · tried ${c.tries}×`}</small></span>
                        <span>{c.wilayaCode || "—"}</span>
                        <span className={OUR_FAULT.has(c.reason) ? "cc-bad" : ""}>{failLabel(c.reason)}</span>
                        <span className="cc-muted">{timeAgo(c.at)}</span>
                        <span><a className="cc-btn cc-ghost cc-btn-sm" href={"tel:" + c.phone}>Call</a></span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Health + trend */}
          <div className="cc-sect-sm"><h3>🚦 Health &amp; trend</h3><span className="cc-when">{cur.label}</span></div>
          <div className="cc-duo">
            <div className="cc-card cc-card-pad">
              <div className="cc-gauges">
                <div className={"cc-gauge " + (confRate >= 70 ? "cc-g-good" : "")}><div className="cc-lbl">Confirmation rate</div><div className="cc-gv">{confRate.toFixed(0)}%</div><div className="cc-tiny cc-muted">of orders placed</div></div>
                <div className={"cc-gauge " + (cur.returns.ratePct <= 15 ? "cc-g-good" : "")}><div className="cc-lbl">Return rate</div><div className="cc-gv">{cur.returns.ratePct.toFixed(0)}%</div><div className="cc-tiny cc-muted">{cur.returns.count} returned · plan 15%</div></div>
              </div>
              {!data.ecotrack.ok && <div className="cc-tiny cc-muted cc-mt">⚠ Ecotrack unavailable — delivered/returned fall back to the DB.</div>}
            </div>
            <div className="cc-card cc-card-pad">
              <div className="cc-card-h"><h4>Orders — last 8 weeks</h4></div>
              <div className="cc-bars">{data.weekly.map((w, i) => (<div key={i} className="cc-col"><div className="cc-b" style={{ height: Math.max(6, (w.orders / maxWeekly) * 130) + "px" }} /><small>{i === data.weekly.length - 1 ? "now" : "W" + (i + 1)}</small></div>))}</div>
            </div>
          </div>

          <p className="cc-foot">Read-only · profit uses your editable cost model (⚙ Costs) · delivery truth from Ecotrack · Meta + full AI plug in next.</p>
        </div>
      )}

      {/* Settings modal */}
      {showSettings && (
        <div className="cc-modalbg" onClick={() => setShowSettings(false)}>
          <div className="cc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cc-modal-h"><h2>⚙ Cost &amp; cash settings</h2><button className="cc-btn cc-ghost" onClick={() => setShowSettings(false)}>✕</button></div>
            <p className="cc-tiny cc-muted">Saved in this browser. Defaults are your money-model numbers. Copy/Paste to sync to your phone.</p>
            <h3 className="cc-seth">Per product</h3>
            <div className="cc-settable">
              <div className="cc-setth"><span>Product</span><span>Unit cost</span><span>Print run</span></div>
              {(data?.inventory || []).map((p) => {
                const ps = settings.products[p.slug] || { label: p.name, unitCost: settings.defaultUnitCost, printRun: 0 };
                return (<div key={p.slug} className="cc-setrow"><span>{ps.label || p.name}</span>
                  <input className="cc-input cc-input-sm" type="number" value={ps.unitCost} onChange={(e) => updateProduct(p.slug, "unitCost", Number(e.target.value) || 0)} />
                  <input className="cc-input cc-input-sm" type="number" value={ps.printRun} onChange={(e) => updateProduct(p.slug, "printRun", Number(e.target.value) || 0)} /></div>);
              })}
            </div>
            <h3 className="cc-seth">Shared &amp; cash</h3>
            <div className="cc-setgrid">
              <Field label="💰 Cash on hand (DA)" v={settings.cashOnHand} on={(n) => updateSetting("cashOnHand", n)} />
              <Field label="Ad / order (estimate)" v={settings.adCostPerOrder} on={(n) => updateSetting("adCostPerOrder", n)} />
              <Field label="Ad target / sale" v={settings.adTargetPerSale} on={(n) => updateSetting("adTargetPerSale", n)} />
              <Field label="Wrapping / order" v={settings.wrapping} on={(n) => updateSetting("wrapping", n)} />
              <Field label="Confirmation / delivered" v={settings.confirmation} on={(n) => updateSetting("confirmation", n)} />
              <Field label="Return fee / return" v={settings.returnFee} on={(n) => updateSetting("returnFee", n)} />
              <Field label="Rent / month" v={settings.rentPerMonth} on={(n) => updateSetting("rentPerMonth", n)} />
              <Field label="Reorder at (days cover)" v={settings.reorderDays} on={(n) => updateSetting("reorderDays", n)} />
            </div>
            <div className="cc-setactions">
              <button className="cc-btn cc-ghost" onClick={copySettings}>📋 Copy</button>
              <button className="cc-btn cc-ghost" onClick={pasteSettings}>📥 Paste</button>
              <button className="cc-btn cc-ghost" onClick={() => saveSettings(DEFAULT_SETTINGS)}>↺ Reset</button>
              <button className="cc-btn cc-primary" onClick={() => setShowSettings(false)}>Done</button>
            </div>
            {syncMsg && <div className="cc-tiny cc-sync">{syncMsg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, v, on }: { label: string; v: number; on: (n: number) => void }) {
  return (<label className="cc-field"><span>{label}</span><input className="cc-input cc-input-sm" type="number" value={v} onChange={(e) => on(Number(e.target.value) || 0)} /></label>);
}

function Style() {
  return (<style>{`
    @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap');
    .cc{--cream:#f4ecd9;--cream2:#fbf7ec;--surface:#fffdf8;--ink:#2a2419;--soft:#6b6350;--muted:#a99b76;--line:#ece2cb;--gold:#e0a91a;--goldb:#ffc83d;--goldsoft:#fff3d3;--green:#1f7a52;--greensoft:#e7f3ec;--greenline:#cfe8da;--coral:#e0654c;--coralsoft:#fce9e2;--coralline:#f6d2c7;--amber:#c98a1b;--ambersoft:#fdf0d2;--amberline:#f0dcae;--disp:"Quicksand",system-ui,sans-serif;--body:"Nunito",system-ui,sans-serif;min-height:100vh;background:var(--cream);color:var(--ink);font-family:var(--body);background-image:radial-gradient(1000px 440px at 84% -10%,#fdf3da 0%,transparent 60%);}
    .cc *{box-sizing:border-box;} .cc h1,.cc h2,.cc h3,.cc h4{font-family:var(--disp);font-weight:700;letter-spacing:-.01em;margin:0;}
    .cc-muted{color:var(--muted);} .cc-tiny{font-size:11.5px;} .cc-sm{font-size:13.5px;} .cc-mt{margin-top:10px;}
    .cc-ok{color:var(--green);} .cc-bad{color:#b34a33;} .cc-up{font-family:var(--disp);font-weight:700;font-size:16px;color:var(--green);background:var(--greensoft);border:1px solid var(--greenline);padding:2px 9px;border-radius:999px;}
    .cc-lbl{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:800;color:var(--muted);}
    .cc-wrap{max-width:1060px;margin:0 auto;padding:8px 20px 70px;}
    .cc-bar{display:flex;align-items:center;justify-content:space-between;padding:13px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(244,236,217,.9);backdrop-filter:blur(7px);z-index:5;}
    .cc-brand{font-family:var(--disp);font-weight:700;font-size:18px;} .cc-bar-sub{color:var(--soft);margin-left:8px;font-weight:700;font-size:14px;}
    .cc-bar-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
    .cc-btn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:10px;padding:7px 12px;font-size:13px;font-weight:700;font-family:var(--body);cursor:pointer;}
    .cc-btn:hover{background:var(--cream2);} .cc-ghost{background:transparent;} .cc-primary{background:var(--gold);border-color:var(--gold);color:#221c0a;} .cc-wfull{width:100%;margin-top:8px;}
    .cc-sect{display:flex;align-items:center;gap:11px;margin:30px 0 14px;} .cc-sect h2{font-size:clamp(18px,2.6vw,23px);} .cc-sect-sm{display:flex;align-items:center;gap:10px;margin:26px 0 12px;} .cc-sect-sm h3{font-size:17px;}
    .cc-badge{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:6px 12px;border-radius:999px;background:var(--goldsoft);color:var(--gold);} .cc-when{margin-left:auto;font-size:12px;color:var(--muted);font-weight:700;background:var(--surface);border:1px solid var(--line);padding:5px 11px;border-radius:999px;}
    .cc-pulse{background:var(--surface);border:1px solid var(--line);border-radius:26px;padding:24px;max-width:380px;box-shadow:0 14px 36px rgba(70,52,15,.09);}
    .cc-hero{display:flex;align-items:baseline;gap:12px;margin-top:3px;} .cc-heronum{font-family:var(--disp);font-weight:700;font-size:72px;line-height:.9;}
    .cc-profit{margin-top:12px;font-size:15px;color:var(--soft);font-weight:700;} .cc-profit b{font-family:var(--disp);color:var(--ink);}
    .cc-twins{display:flex;gap:12px;margin-top:18px;} .cc-twin{flex:1;background:var(--cream2);border:1px solid var(--line);border-radius:16px;padding:13px 15px;} .cc-twv{font-family:var(--disp);font-weight:700;font-size:24px;margin-top:3px;}
    .cc-spark{height:34px;margin-top:16px;display:flex;align-items:flex-end;gap:4px;} .cc-spark i{flex:1;background:var(--goldb);border-radius:4px 4px 0 0;opacity:.9;} .cc-spark-last{background:var(--gold)!important;}
    .cc-chip{margin-top:14px;border-radius:14px;padding:11px 14px;font-size:13px;font-weight:700;} .cc-chip-good{background:var(--greensoft);color:var(--green);border:1px solid var(--greenline);} .cc-chip-warn{background:var(--coralsoft);color:#b34a33;border:1px solid var(--coralline);}
    .cc-periods{display:flex;align-items:center;gap:7px;margin:28px 0 0;flex-wrap:wrap;} .cc-pbtn{border:1px solid var(--line);background:var(--surface);color:var(--soft);border-radius:999px;padding:6px 15px;font-size:13px;font-weight:700;cursor:pointer;} .cc-pbtn-on{background:var(--ink);color:var(--cream2);border-color:var(--ink);}
    .cc-grid2{display:grid;gap:16px;} @media(min-width:680px){.cc-grid2{grid-template-columns:1fr 1fr;}}
    .cc-pcard{background:var(--surface);border:1px solid var(--line);border-radius:22px;overflow:hidden;box-shadow:0 6px 16px rgba(70,52,15,.06);} .cc-accent{height:5px;} .cc-pcard-in{padding:17px 20px 18px;}
    .cc-pcard-row{display:flex;align-items:center;justify-content:space-between;} .cc-pcard h3{font-size:19px;display:flex;align-items:center;gap:10px;} .cc-dot{width:12px;height:12px;border-radius:50%;display:inline-block;}
    .cc-status{font-size:11.5px;font-weight:800;padding:4px 11px;border-radius:999px;} .st-good{background:var(--greensoft);color:var(--green);border:1px solid var(--greenline);} .st-warn{background:var(--coralsoft);color:#b34a33;border:1px solid var(--coralline);} .st-steady{background:var(--cream);color:var(--soft);border:1px solid var(--line);}
    .cc-plabel{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;font-weight:800;color:var(--muted);margin-top:15px;} .cc-big{font-family:var(--disp);font-weight:700;font-size:36px;line-height:1;margin-top:2px;} .cc-big small{font-size:.4em;color:var(--muted);} .cc-sub{font-size:12.5px;color:var(--soft);font-weight:700;margin-top:5px;}
    .cc-chips{display:flex;gap:9px;margin-top:16px;} .cc-chipm{flex:1;border-radius:14px;padding:10px 6px 9px;text-align:center;border:1px solid var(--line);background:var(--cream2);} .cc-mv{font-family:var(--disp);font-weight:700;font-size:19px;} .cc-ml{font-size:9.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:800;color:var(--muted);margin-top:3px;}
    .cc-chipm.cc-good{background:var(--greensoft);border-color:var(--greenline);} .cc-chipm.cc-good .cc-mv{color:var(--green);} .cc-chipm.cc-warn{background:var(--coralsoft);border-color:var(--coralline);} .cc-chipm.cc-warn .cc-mv{color:#b34a33;} .cc-chipm.cc-mute .cc-mv{color:var(--muted);}
    .cc-truth{display:grid;gap:14px;grid-template-columns:1fr;} @media(min-width:560px){.cc-truth{grid-template-columns:1fr 1fr;}} @media(min-width:900px){.cc-truth{grid-template-columns:repeat(4,1fr);}}
    .cc-tile{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:17px 18px;box-shadow:0 6px 16px rgba(70,52,15,.06);} .cc-tile-hero{background:var(--greensoft);border-color:var(--greenline);} .cc-tile .cc-big{font-size:30px;margin-top:7px;} .cc-note{font-size:11.5px;color:var(--soft);font-weight:700;margin-top:7px;}
    .cc-pbar{height:9px;border-radius:999px;background:var(--cream);border:1px solid var(--line);margin-top:11px;overflow:hidden;} .cc-pbar i{display:block;height:100%;background:linear-gradient(90deg,var(--goldb),var(--gold));}
    .cc-split{height:9px;border-radius:999px;margin-top:11px;overflow:hidden;display:flex;background:var(--cream);} .cc-split i{height:100%;} .cc-onhand{background:var(--green);} .cc-frozen{background:var(--amber);}
    .cc-legend{display:flex;gap:12px;margin-top:8px;font-size:10.5px;color:var(--soft);font-weight:700;flex-wrap:wrap;} .cc-legend span{display:flex;align-items:center;gap:5px;} .cc-legend b{width:9px;height:9px;border-radius:3px;display:inline-block;}
    .cc-ask{background:linear-gradient(155deg,#322b1c,#211c12);border:1px solid #443a25;border-radius:24px;padding:22px;margin-top:18px;color:#f3ecda;}
    .cc-ask-tag{display:flex;align-items:center;gap:10px;} .cc-brainbox{width:34px;height:34px;border-radius:11px;background:var(--gold);display:flex;align-items:center;justify-content:center;font-size:18px;} .cc-ask-k{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--goldb);font-weight:800;}
    .cc-ask h3{font-size:20px;color:#fff;margin:13px 0 12px;} .cc-moves{display:grid;gap:10px;} @media(min-width:760px){.cc-moves{grid-template-columns:repeat(3,1fr);}}
    .cc-move{background:#3a3122;border:1px solid #4d4029;border-radius:15px;padding:13px 15px;} .cc-move-h{font-size:12px;font-weight:800;color:var(--goldb);margin-bottom:6px;} .cc-move p{font-size:12.6px;color:#e7ddc6;line-height:1.5;margin:0;}
    .cc-askfield{margin-top:14px;background:#15110a;border:1px solid #4d4029;border-radius:13px;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;} .cc-askfield span:first-child{color:#9c917a;font-size:12.5px;} .cc-go{background:#4d4029;color:#cdbf9a;font-weight:800;border-radius:8px;padding:5px 12px;font-size:12px;flex:0 0 auto;}
    .cc-card{background:var(--surface);border:1px solid var(--line);border-radius:22px;box-shadow:0 6px 16px rgba(70,52,15,.06);padding:8px 14px;} .cc-card-pad{padding:16px;} .cc-dashed{border-style:dashed;padding:16px 18px;} .cc-card-h{margin-bottom:10px;} .cc-card-h h4{font-size:15px;}
    .cc-pill-soon{font-size:10px;font-weight:800;color:var(--amber);border:1px solid var(--amberline);background:var(--ambersoft);border-radius:999px;padding:3px 9px;margin-left:auto;}
    .cc-srow{display:grid;grid-template-columns:1.5fr 1.2fr .9fr .9fr;align-items:center;gap:10px;padding:13px 6px;border-bottom:1px dashed var(--line);} .cc-srow:last-child{border-bottom:none;}
    .cc-sname{font-family:var(--disp);font-weight:700;font-size:15px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;} .cc-sname small{font-family:var(--body);font-weight:700;font-size:11px;color:var(--muted);}
    .cc-scover .cc-cval{font-family:var(--disp);font-weight:700;font-size:16px;} .cc-coverbar{height:7px;border-radius:999px;background:var(--cream);border:1px solid var(--line);overflow:hidden;margin-top:5px;max-width:120px;} .cc-coverbar i{display:block;height:100%;}
    .cc-sstock{font-family:var(--disp);font-weight:700;font-size:16px;} .cc-sstock small{font-family:var(--body);font-weight:700;font-size:10.5px;color:var(--muted);text-transform:uppercase;display:block;}
    .cc-pill{font-size:11px;font-weight:800;padding:4px 11px;border-radius:999px;} .cc-scale{background:var(--greensoft);color:var(--green);border:1px solid var(--greenline);} .cc-kill{background:var(--coralsoft);color:#b34a33;border:1px solid var(--coralline);} .cc-watch{background:var(--ambersoft);color:var(--amber);border:1px solid var(--amberline);}
    .cc-fhead{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;} .cc-fbig{font-family:var(--disp);font-weight:700;font-size:36px;line-height:1;} .cc-fbig small{font-family:var(--body);font-size:14px;font-weight:700;color:var(--muted);} .cc-fmeta{flex:1;min-width:180px;}
    .cc-freasons{margin-top:14px;} .cc-frow{display:grid;grid-template-columns:minmax(150px,1.6fr) 1fr 42px;align-items:center;gap:12px;padding:8px 2px;border-bottom:1px dashed var(--line);} .cc-frow:last-child{border-bottom:none;}
    .cc-fname{font-size:13px;font-weight:700;display:flex;align-items:center;gap:7px;flex-wrap:wrap;} .cc-fbar{height:8px;border-radius:999px;background:var(--cream);border:1px solid var(--line);overflow:hidden;} .cc-fbar i{display:block;height:100%;} .cc-fcount{font-family:var(--disp);font-weight:700;font-size:16px;text-align:right;}
    .cc-ftable{margin-top:10px;border:1px solid var(--line);border-radius:14px;overflow:hidden;} .cc-ftr{display:grid;grid-template-columns:minmax(130px,1.4fr) .5fr 1.5fr .7fr auto;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--line);font-size:12.5px;} .cc-ftr:first-child{border-top:none;}
    .cc-fth{background:var(--cream2);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--soft);font-weight:800;} .cc-fwho{display:flex;flex-direction:column;} .cc-fwho small{color:var(--muted);font-weight:700;font-size:11px;} .cc-btn-sm{padding:4px 10px;font-size:11.5px;text-decoration:none;display:inline-block;}
    @media(max-width:700px){.cc-ftr{grid-template-columns:1.4fr 1fr auto;} .cc-ftr>span:nth-child(2),.cc-ftr>span:nth-child(4){display:none;} .cc-fth{display:none;}}
    .cc-duo{display:grid;gap:16px;} @media(min-width:820px){.cc-duo{grid-template-columns:.85fr 1.15fr;}}
    .cc-gauges{display:grid;gap:12px;grid-template-columns:1fr 1fr;} .cc-gauge{border-radius:16px;padding:14px 15px;border:1px solid var(--line);background:var(--cream2);} .cc-g-good{background:var(--greensoft);border-color:var(--greenline);} .cc-g-good .cc-gv{color:var(--green);} .cc-gv{font-family:var(--disp);font-weight:700;font-size:27px;}
    .cc-bars{height:150px;display:flex;align-items:flex-end;gap:8px;padding:6px 2px 0;} .cc-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px;} .cc-b{width:100%;border-radius:7px 7px 0 0;background:var(--goldb);} .cc-col:last-child .cc-b{background:var(--gold);} .cc-col small{font-size:10px;color:var(--muted);font-weight:700;}
    .cc-alert{background:var(--coralsoft);border:1px solid var(--coralline);color:#b34a33;border-radius:12px;padding:11px 14px;font-size:13px;margin-top:14px;} .cc-loading{padding:50px;text-align:center;color:var(--soft);} .cc-foot{text-align:center;margin-top:24px;font-size:11.5px;color:var(--muted);}
    .cc-login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;} .cc-login-card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:32px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(70,52,15,.12);}
    .cc-logo{font-family:var(--disp);font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold);font-weight:700;} .cc-login-card h1{margin:8px 0 4px;font-size:25px;} .cc-err{color:#b34a33;font-size:13px;margin-top:8px;}
    .cc-input{width:100%;background:var(--cream2);border:1px solid var(--line);border-radius:11px;padding:11px 13px;color:var(--ink);font-size:15px;font-family:var(--body);margin-top:14px;} .cc-input:focus{outline:none;border-color:var(--gold);} .cc-input-sm{margin-top:0;padding:8px 10px;font-size:13px;text-align:right;}
    .cc-modalbg{position:fixed;inset:0;background:rgba(40,30,10,.45);display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;z-index:20;overflow-y:auto;} .cc-modal{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:20px;max-width:580px;width:100%;}
    .cc-modal-h{display:flex;align-items:center;justify-content:space-between;} .cc-seth{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--soft);margin:16px 0 8px;}
    .cc-settable{border:1px solid var(--line);border-radius:11px;overflow:hidden;} .cc-setth,.cc-setrow{display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:8px;align-items:center;padding:8px 10px;} .cc-setth{background:var(--cream2);font-size:10.5px;text-transform:uppercase;color:var(--soft);font-weight:800;} .cc-setrow{border-top:1px solid var(--line);font-size:13px;}
    .cc-setgrid{display:grid;gap:10px;grid-template-columns:1fr 1fr;} @media(min-width:520px){.cc-setgrid{grid-template-columns:1fr 1fr;}} .cc-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--soft);font-weight:700;} .cc-setactions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;justify-content:flex-end;} .cc-sync{color:var(--green);text-align:right;margin-top:8px;}
  `}</style>);
}
