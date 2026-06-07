"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ─────────────────────────────────────────────────────────────
// Curio — Command Center (READ-ONLY)
// One screen: orders, status funnel, revenue, inventory, returns,
// and LIVE profit. Reads your real data via /api/dashboard.
// Cost numbers are editable and saved in THIS browser.
// Meta ad data is a clearly-labeled stub for later.
// ─────────────────────────────────────────────────────────────

const ADMIN_KEY_STORAGE = "curio-admin-key";
const SETTINGS_STORAGE = "curio-cc-settings-v1";

type PeriodKey = "today" | "week" | "month" | "all";
type TrendKey = "today" | "week" | "month";

interface Funnel {
  pending: number;
  confirmed: number;
  in_transit: number;
  delivered: number;
  returned: number;
  cancelled: number;
}
interface PeriodMetrics {
  label: string;
  days: number;
  orders: number;
  funnel: Funnel;
  confirmedRevenue: number;
  deliveredRevenue: number;
  confirmedCount: number;
  deliveredCount: number;
  returnedCount: number;
  inTransitCount: number;
  attempts: number;
  returns: { count: number; ratePct: number };
  perProductDeliveredUnits: Record<string, number>;
}
interface DashboardData {
  generatedAt: string;
  totalOrdersAllTime: number;
  trend: Record<TrendKey, { current: number; previous: number }>;
  periods: Record<PeriodKey, PeriodMetrics>;
  inventory: { slug: string; name: string; nameEn: string | null; stock: number; price: number }[];
  ecotrack: {
    ok: boolean;
    error: string | null;
    ordersInEcotrack: number;
    matchedToStore: number;
    globalStatusCounts: Record<string, number>;
  };
}

interface ProductSetting {
  label: string;
  unitCost: number;
  printRun: number;
}
interface Settings {
  products: Record<string, ProductSetting>;
  defaultUnitCost: number;
  wrapping: number;
  confirmation: number;
  codFee: number;
  returnFee: number;
  rentPerMonth: number;
  adCostPerOrder: number;
}

// Defaults straight from your money model (v4).
const DEFAULT_SETTINGS: Settings = {
  products: {
    roubla: { label: "Roubla", unitCost: 610, printRun: 2000 },
    dlala: { label: "Dlala", unitCost: 610, printRun: 1000 },
    origami: { label: "Origami", unitCost: 760, printRun: 3000 },
    "goul-bla-matgoul": { label: "Goul Bla Matgoul", unitCost: 610, printRun: 0 },
    "eid-2026-bundle": { label: "Eid Pack", unitCost: 1220, printRun: 0 },
  },
  defaultUnitCost: 610,
  wrapping: 30,
  confirmation: 120,
  codFee: 0,
  returnFee: 250,
  rentPerMonth: 15000,
  adCostPerOrder: 450,
};

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      products: { ...DEFAULT_SETTINGS.products, ...(parsed.products || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function fmt(n: number): string {
  if (!isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function fmtCompact(n: number): string {
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

interface ProfitBreakdown {
  revenue: number;
  cogs: number;
  adCost: number;
  wrapping: number;
  confirmation: number;
  cod: number;
  returnCost: number;
  rent: number;
  profit: number;
}
function computeProfit(
  p: PeriodMetrics,
  s: Settings,
  metaSpend: number | null
): ProfitBreakdown {
  let cogs = 0;
  for (const [slug, units] of Object.entries(p.perProductDeliveredUnits || {})) {
    const uc = s.products[slug]?.unitCost ?? s.defaultUnitCost;
    cogs += units * uc;
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

  // Load saved key + settings on mount
  useEffect(() => {
    setSettings(loadSettings());
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const fetchData = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard", { headers: { "X-Admin-Key": key } });
      if (res.status === 401) {
        setAdminKey("");
        window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setLoginError(true);
        setData(null);
        return;
      }
      if (!res.ok) throw new Error("server " + res.status);
      const json = (await res.json()) as DashboardData;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-fetch when we have a key
  useEffect(() => {
    if (adminKey) fetchData(adminKey);
  }, [adminKey, fetchData]);

  function tryLogin() {
    const key = keyInput.trim();
    if (!key) return;
    setLoginError(false);
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    setAdminKey(key);
  }
  function logout() {
    window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    setAdminKey("");
    setData(null);
    setKeyInput("");
  }

  function saveSettings(next: Settings) {
    setSettings(next);
    window.localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(next));
  }
  function updateSetting(field: keyof Settings, value: number) {
    saveSettings({ ...settings, [field]: value });
  }
  function updateProduct(slug: string, field: keyof ProductSetting, value: number) {
    const prev = settings.products[slug] || { label: slug, unitCost: settings.defaultUnitCost, printRun: 0 };
    saveSettings({ ...settings, products: { ...settings.products, [slug]: { ...prev, [field]: value } } });
  }
  function copySettings() {
    navigator.clipboard?.writeText(JSON.stringify(settings)).then(
      () => { setSyncMsg("Copied! Paste it on your other device."); setTimeout(() => setSyncMsg(""), 4000); },
      () => setSyncMsg("Copy failed — select the text below manually.")
    );
  }
  function pasteSettings() {
    const txt = window.prompt("Paste your settings code here:");
    if (!txt) return;
    try {
      const parsed = JSON.parse(txt);
      saveSettings({ ...DEFAULT_SETTINGS, ...parsed, products: { ...DEFAULT_SETTINGS.products, ...(parsed.products || {}) } });
      setSyncMsg("Settings applied ✓");
      setTimeout(() => setSyncMsg(""), 4000);
    } catch {
      setSyncMsg("That didn't look like a valid settings code.");
    }
  }

  const metaSpend: number | null = null; // ← Meta not connected yet (stub)

  const cur = data?.periods[period];
  const profit = useMemo(
    () => (cur ? computeProfit(cur, settings, metaSpend) : null),
    [cur, settings]
  );

  // ─── LOGIN SCREEN ───
  if (!adminKey) {
    return (
      <div className="cc-root">
        <Style />
        <div className="cc-login">
          <div className="cc-login-card">
            <div className="cc-logo">Curio</div>
            <h1>Command Center</h1>
            <p className="cc-muted">Enter your admin key to see the business.</p>
            <input
              className="cc-input"
              type="password"
              placeholder="Admin key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()}
              autoFocus
            />
            {loginError && <div className="cc-login-err">Wrong key — try again.</div>}
            <button className="cc-btn cc-btn-primary cc-w-full" onClick={tryLogin}>
              Open the Command Center
            </button>
            <p className="cc-tiny">Read-only · nothing here can change your orders.</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── DASHBOARD ───
  const t = data && period !== "all" ? data.trend[period as TrendKey] : null;
  const tr = t ? trendPct(t.current, t.previous) : null;

  return (
    <div className="cc-root">
      <Style />

      {/* Top bar */}
      <header className="cc-bar">
        <div className="cc-bar-left">
          <span className="cc-dot cc-dot-r" />
          <span className="cc-dot cc-dot-y" />
          <span className="cc-dot cc-dot-g" />
          <span className="cc-bar-title">Curio — Command Center</span>
        </div>
        <div className="cc-bar-right">
          {data && (
            <span className="cc-tiny cc-muted">
              updated {new Date(data.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          <button className="cc-btn cc-btn-ghost" onClick={() => fetchData(adminKey)} disabled={loading}>
            {loading ? "…" : "↻ Refresh"}
          </button>
          <button className="cc-btn cc-btn-ghost" onClick={() => setShowSettings(true)}>⚙ Costs</button>
          <button className="cc-btn cc-btn-ghost" onClick={logout}>Logout</button>
        </div>
      </header>

      {/* Period selector */}
      <div className="cc-periods">
        {(["today", "week", "month", "all"] as PeriodKey[]).map((p) => (
          <button
            key={p}
            className={"cc-period " + (period === p ? "cc-period-on" : "")}
            onClick={() => setPeriod(p)}
          >
            {p === "today" ? "Today" : p === "week" ? "7 days" : p === "month" ? "30 days" : "All time"}
          </button>
        ))}
        <span className="cc-tiny cc-muted cc-periods-note">
          {data ? `${fmt(data.totalOrdersAllTime)} orders all-time` : "rolling windows"}
        </span>
      </div>

      {error && <div className="cc-alert cc-alert-red">Couldn&apos;t load data: {error}. Try Refresh.</div>}

      {!data && loading && <div className="cc-loading">Loading your business…</div>}

      {cur && profit && (
        <main className="cc-main">
          {/* Headline tiles */}
          <section className="cc-tiles">
            <div className="cc-tile">
              <div className="cc-k">Orders ({cur.label.toLowerCase()})</div>
              <div className="cc-v">{fmt(cur.orders)}</div>
              {tr && (
                <div className={"cc-s cc-" + tr.dir}>
                  {tr.dir === "up" ? "▲" : tr.dir === "down" ? "▼" : "▬"} {tr.txt} vs previous
                </div>
              )}
            </div>
            <div className="cc-tile">
              <div className="cc-k">Confirmed revenue</div>
              <div className="cc-v">{fmtCompact(cur.confirmedRevenue)}</div>
              <div className="cc-s cc-muted">DA · expected</div>
            </div>
            <div className="cc-tile">
              <div className="cc-k">Delivered revenue</div>
              <div className="cc-v">{fmtCompact(cur.deliveredRevenue)}</div>
              <div className="cc-s cc-muted">DA · collected</div>
            </div>
            <div className="cc-tile cc-tile-profit">
              <div className="cc-k">Live profit</div>
              <div className={"cc-v " + (profit.profit >= 0 ? "cc-up" : "cc-down")}>
                {profit.profit >= 0 ? "+" : ""}{fmtCompact(profit.profit)}
              </div>
              <div className="cc-s cc-muted">DA · after all costs</div>
            </div>
          </section>

          {/* Funnel */}
          <section className="cc-card">
            <div className="cc-card-head">
              <h2>Order status funnel</h2>
              <span className="cc-tiny cc-muted">{cur.label}</span>
            </div>
            <div className="cc-funnel">
              <FunnelStep n={cur.funnel.pending} label="Pending" />
              <FunnelStep n={cur.funnel.confirmed} label="Confirmed" />
              <FunnelStep n={cur.funnel.in_transit} label="Shipped" sub="in transit" />
              <FunnelStep n={cur.funnel.delivered} label="Delivered" tone="good" />
              <FunnelStep n={cur.funnel.returned} label="Returned" tone="bad" />
              <FunnelStep n={cur.funnel.cancelled} label="Cancelled" tone="muted" />
            </div>
            {data && !data.ecotrack.ok && (
              <div className="cc-alert cc-alert-amber cc-mt">
                ⚠ Delivery data from Ecotrack is unavailable right now ({data.ecotrack.error}).
                Delivered / Returned fall back to the store database until it&apos;s reachable.
              </div>
            )}
            {data && data.ecotrack.ok && (
              <div className="cc-tiny cc-muted cc-mt">
                Delivered / Returned read live from Ecotrack &amp; matched to your orders by phone
                ({fmt(data.ecotrack.matchedToStore)} of {fmt(data.ecotrack.ordersInEcotrack)} Ecotrack orders matched).
              </div>
            )}
          </section>

          <div className="cc-grid2">
            {/* Inventory */}
            <section className="cc-card">
              <div className="cc-card-head"><h2>Inventory</h2><span className="cc-tiny cc-muted">stock left vs print run</span></div>
              <div className="cc-inv">
                {data!.inventory.map((p) => {
                  const run = settings.products[p.slug]?.printRun ?? 0;
                  const pct = run > 0 ? Math.max(0, Math.min(100, (p.stock / run) * 100)) : 0;
                  const low = run > 0 && p.stock / run < 0.15;
                  return (
                    <div key={p.slug} className="cc-inv-row">
                      <div className="cc-inv-top">
                        <span className="cc-inv-name">{settings.products[p.slug]?.label || p.name}</span>
                        <span className={"cc-inv-num " + (low ? "cc-down" : "")}>
                          {fmt(p.stock)}{run > 0 ? <span className="cc-muted"> / {fmt(run)}</span> : <span className="cc-muted"> in stock</span>}
                        </span>
                      </div>
                      {run > 0 && (
                        <div className="cc-bar"><div className={"cc-bar-fill " + (low ? "cc-bar-low" : "")} style={{ width: pct + "%" }} /></div>
                      )}
                      {low && <div className="cc-tiny cc-down">Low stock — plan a reprint</div>}
                      {run === 0 && <div className="cc-tiny cc-muted">Set a print run in ⚙ Costs to see the bar</div>}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Returns + Profit breakdown */}
            <section className="cc-card">
              <div className="cc-card-head"><h2>Money &amp; returns</h2><span className="cc-tiny cc-muted">{cur.label}</span></div>
              <div className="cc-returns">
                <div className="cc-return-stat">
                  <div className="cc-k">Return rate</div>
                  <div className={"cc-v-sm " + (cur.returns.ratePct <= 15 ? "cc-up" : "cc-down")}>
                    {cur.returns.ratePct.toFixed(0)}%
                  </div>
                  <div className="cc-tiny cc-muted">{cur.returns.count} returned · plan 15%</div>
                </div>
                <div className="cc-pl">
                  <Line label="Delivered revenue" v={profit.revenue} plus />
                  <Line label="− Product cost (parts+assembly)" v={-profit.cogs} />
                  <Line label="− Ad cost (estimate)" v={-profit.adCost} est />
                  <Line label="− Confirmation agency" v={-profit.confirmation} />
                  <Line label="− Wrapping" v={-profit.wrapping} />
                  <Line label="− Returns (courier)" v={-profit.returnCost} />
                  <Line label="− Rent (share)" v={-profit.rent} />
                  <div className="cc-pl-total">
                    <span>Live profit</span>
                    <span className={profit.profit >= 0 ? "cc-up" : "cc-down"}>{fmt(profit.profit)} DA</span>
                  </div>
                </div>
              </div>
            </section>
          </div>

          {/* Meta stub */}
          <section className="cc-card cc-meta-stub">
            <div className="cc-card-head"><h2>📣 Meta ad spend</h2><span className="cc-pill-soon">NOT CONNECTED YET</span></div>
            <p className="cc-muted cc-sm">
              When you connect Meta (via Meta MCP), this fills in with real <strong>ad spend</strong>, <strong>cost per order</strong>,
              <strong> ROAS</strong>, and <strong>profit after ads</strong> — and the profit above switches from your estimate
              ({fmt(settings.adCostPerOrder)} DA/order) to your real numbers automatically. No rebuild needed.
            </p>
            <div className="cc-meta-grid">
              <div className="cc-meta-box"><div className="cc-k">Ad spend</div><div className="cc-v-sm cc-muted">— · stub</div></div>
              <div className="cc-meta-box"><div className="cc-k">Cost / order</div><div className="cc-v-sm cc-muted">— · stub</div></div>
              <div className="cc-meta-box"><div className="cc-k">ROAS</div><div className="cc-v-sm cc-muted">— · stub</div></div>
              <div className="cc-meta-box"><div className="cc-k">Profit after ads</div><div className="cc-v-sm cc-muted">— · stub</div></div>
            </div>
          </section>

          <p className="cc-tiny cc-muted cc-foot">
            Read-only view · profit uses your editable cost model (⚙ Costs) · delivery truth from Ecotrack · Meta plugs in later.
          </p>
        </main>
      )}

      {/* Settings modal */}
      {showSettings && (
        <div className="cc-modal-bg" onClick={() => setShowSettings(false)}>
          <div className="cc-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cc-card-head">
              <h2>⚙ Cost assumptions</h2>
              <button className="cc-btn cc-btn-ghost" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <p className="cc-tiny cc-muted">Saved in this browser. Defaults are your money-model numbers. Use Copy/Paste to sync to your phone.</p>

            <h3 className="cc-set-h">Per product</h3>
            <div className="cc-set-table">
              <div className="cc-set-th"><span>Product</span><span>Unit cost (DA)</span><span>Print run</span></div>
              {(data?.inventory || []).map((p) => {
                const ps = settings.products[p.slug] || { label: p.name, unitCost: settings.defaultUnitCost, printRun: 0 };
                return (
                  <div key={p.slug} className="cc-set-row">
                    <span className="cc-set-name">{ps.label || p.name}</span>
                    <input className="cc-input cc-input-sm" type="number" value={ps.unitCost}
                      onChange={(e) => updateProduct(p.slug, "unitCost", Number(e.target.value) || 0)} />
                    <input className="cc-input cc-input-sm" type="number" value={ps.printRun}
                      onChange={(e) => updateProduct(p.slug, "printRun", Number(e.target.value) || 0)} />
                  </div>
                );
              })}
            </div>

            <h3 className="cc-set-h">Shared costs</h3>
            <div className="cc-set-grid">
              <Field label="Wrapping / order" v={settings.wrapping} on={(n) => updateSetting("wrapping", n)} />
              <Field label="Confirmation / delivered" v={settings.confirmation} on={(n) => updateSetting("confirmation", n)} />
              <Field label="COD fee / delivered" v={settings.codFee} on={(n) => updateSetting("codFee", n)} />
              <Field label="Return fee / return" v={settings.returnFee} on={(n) => updateSetting("returnFee", n)} />
              <Field label="Rent / month" v={settings.rentPerMonth} on={(n) => updateSetting("rentPerMonth", n)} />
              <Field label="Ad / order (estimate)" v={settings.adCostPerOrder} on={(n) => updateSetting("adCostPerOrder", n)} />
            </div>

            <div className="cc-set-actions">
              <button className="cc-btn cc-btn-ghost" onClick={copySettings}>📋 Copy settings</button>
              <button className="cc-btn cc-btn-ghost" onClick={pasteSettings}>📥 Paste settings</button>
              <button className="cc-btn cc-btn-ghost" onClick={() => saveSettings(DEFAULT_SETTINGS)}>↺ Reset to defaults</button>
              <button className="cc-btn cc-btn-primary" onClick={() => setShowSettings(false)}>Done</button>
            </div>
            {syncMsg && <div className="cc-tiny cc-sync">{syncMsg}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function FunnelStep({ n, label, sub, tone }: { n: number; label: string; sub?: string; tone?: "good" | "bad" | "muted" }) {
  return (
    <div className="cc-fstep">
      <div className={"cc-fn " + (tone === "good" ? "cc-up" : tone === "bad" ? "cc-down" : "")}>{fmt(n)}</div>
      <div className="cc-fl">{label}</div>
      {sub && <div className="cc-tiny cc-muted">{sub}</div>}
    </div>
  );
}
function Line({ label, v, plus, est }: { label: string; v: number; plus?: boolean; est?: boolean }) {
  return (
    <div className="cc-pl-line">
      <span>{label}{est && <span className="cc-est"> est</span>}</span>
      <span className={plus ? "cc-up" : ""}>{fmt(v)} DA</span>
    </div>
  );
}
function Field({ label, v, on }: { label: string; v: number; on: (n: number) => void }) {
  return (
    <label className="cc-field">
      <span>{label}</span>
      <input className="cc-input cc-input-sm" type="number" value={v} onChange={(e) => on(Number(e.target.value) || 0)} />
    </label>
  );
}

// All styles inline so the page renders identically regardless of Tailwind config.
function Style() {
  return (
    <style>{`
      .cc-root{--bg:#1b201d;--panel:#242c28;--panel2:#2b342f;--line:#36433d;--ink:#eef3ef;--soft:#a7b5ac;--muted:#7d8a83;--green:#8fe0b0;--green2:#3fae77;--red:#f0a8a2;--amber:#e6c15a;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh;background:var(--bg);color:var(--ink);}
      .cc-root *{box-sizing:border-box;}
      .cc-muted{color:var(--muted);} .cc-tiny{font-size:11.5px;} .cc-sm{font-size:13.5px;}
      .cc-up{color:var(--green);} .cc-down{color:var(--red);} .cc-flat{color:var(--soft);}
      .cc-mt{margin-top:10px;}

      .cc-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(27,32,29,.92);backdrop-filter:blur(6px);z-index:5;flex-wrap:wrap;}
      .cc-bar-left{display:flex;align-items:center;gap:7px;}
      .cc-dot{width:11px;height:11px;border-radius:50%;} .cc-dot-r{background:#e0605a;} .cc-dot-y{background:#e6c15a;} .cc-dot-g{background:#7fc99a;}
      .cc-bar-title{font-weight:600;margin-left:6px;font-size:15px;}
      .cc-bar-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}

      .cc-btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer;transition:.15s;}
      .cc-btn:hover{background:var(--panel2);}
      .cc-btn-ghost{background:transparent;}
      .cc-btn-primary{background:var(--green2);border-color:var(--green2);color:#06231a;font-weight:600;}
      .cc-btn-primary:hover{filter:brightness(1.08);background:var(--green2);}
      .cc-w-full{width:100%;margin-top:6px;}

      .cc-periods{display:flex;align-items:center;gap:8px;padding:14px 16px 0;flex-wrap:wrap;}
      .cc-period{border:1px solid var(--line);background:transparent;color:var(--soft);border-radius:999px;padding:6px 16px;font-size:13px;cursor:pointer;}
      .cc-period-on{background:var(--green2);border-color:var(--green2);color:#06231a;font-weight:600;}
      .cc-periods-note{margin-left:auto;}

      .cc-main{padding:16px;max-width:1100px;margin:0 auto;}
      .cc-tiles{display:grid;gap:12px;grid-template-columns:repeat(2,1fr);}
      @media(min-width:760px){.cc-tiles{grid-template-columns:repeat(4,1fr);}}
      .cc-tile{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:14px;}
      .cc-tile-profit{background:linear-gradient(160deg,#28332e,#202a25);border-color:#3a5247;}
      .cc-k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--soft);}
      .cc-v{font-size:26px;font-weight:700;margin-top:4px;letter-spacing:-.02em;}
      .cc-v-sm{font-size:20px;font-weight:700;margin-top:2px;}
      .cc-s{font-size:11.5px;margin-top:3px;}

      .cc-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:14px;}
      .cc-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;}
      .cc-card-head h2{margin:0;font-size:15px;font-weight:600;}
      .cc-grid2{display:grid;gap:14px;grid-template-columns:1fr;}
      @media(min-width:760px){.cc-grid2{grid-template-columns:1fr 1fr;}}

      .cc-funnel{display:flex;gap:7px;flex-wrap:wrap;}
      .cc-fstep{flex:1;min-width:90px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px 8px;text-align:center;}
      .cc-fn{font-size:21px;font-weight:700;}
      .cc-fl{font-size:11.5px;color:var(--soft);margin-top:1px;}

      .cc-inv-row{padding:8px 0;border-bottom:1px solid var(--line);} .cc-inv-row:last-child{border-bottom:none;}
      .cc-inv-top{display:flex;justify-content:space-between;align-items:baseline;}
      .cc-inv-name{font-size:14px;font-weight:600;} .cc-inv-num{font-size:14px;font-weight:700;}
      .cc-bar{height:8px;background:#1b231f;border-radius:99px;margin-top:7px;overflow:hidden;}
      .cc-bar-fill{height:100%;background:var(--green2);border-radius:99px;} .cc-bar-low{background:#c0413b;}

      .cc-returns{display:flex;flex-direction:column;gap:12px;}
      .cc-return-stat{background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:11px 14px;}
      .cc-pl{font-size:13px;}
      .cc-pl-line{display:flex;justify-content:space-between;padding:4px 0;color:var(--soft);}
      .cc-est{color:var(--amber);font-size:10px;font-weight:700;}
      .cc-pl-total{display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);font-size:15px;font-weight:700;}

      .cc-meta-stub{border-style:dashed;opacity:.95;}
      .cc-pill-soon{font-size:10px;font-weight:700;color:var(--amber);border:1px solid var(--amber);border-radius:999px;padding:2px 8px;}
      .cc-meta-grid{display:grid;gap:10px;grid-template-columns:repeat(2,1fr);margin-top:10px;}
      @media(min-width:760px){.cc-meta-grid{grid-template-columns:repeat(4,1fr);}}
      .cc-meta-box{background:var(--panel2);border:1px dashed var(--line);border-radius:10px;padding:11px;}

      .cc-alert{border-radius:10px;padding:10px 13px;font-size:13px;margin:8px 16px;}
      .cc-alert-red{background:#3a2422;color:#f0c9c6;border:1px solid #5c322e;}
      .cc-alert-amber{background:#322a16;color:#e6d09a;border:1px solid #5a4a1e;margin:0;}
      .cc-loading{padding:40px 16px;text-align:center;color:var(--soft);}
      .cc-foot{text-align:center;margin-top:18px;}

      /* login */
      .cc-login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
      .cc-login-card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:30px;width:100%;max-width:360px;text-align:center;}
      .cc-logo{font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:var(--green);font-weight:700;}
      .cc-login-card h1{margin:6px 0 4px;font-size:24px;}
      .cc-input{width:100%;background:#161b18;border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--ink);font-size:15px;margin-top:14px;}
      .cc-input:focus{outline:none;border-color:var(--green2);}
      .cc-input-sm{margin-top:0;padding:7px 9px;font-size:13px;text-align:right;}
      .cc-login-err{color:var(--red);font-size:13px;margin-top:8px;}

      /* settings modal */
      .cc-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding:24px 14px;z-index:20;overflow-y:auto;}
      .cc-modal{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;width:100%;max-width:560px;}
      .cc-set-h{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--soft);margin:16px 0 8px;}
      .cc-set-table{border:1px solid var(--line);border-radius:10px;overflow:hidden;}
      .cc-set-th,.cc-set-row{display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:8px;align-items:center;padding:8px 10px;}
      .cc-set-th{background:var(--panel2);font-size:10.5px;text-transform:uppercase;color:var(--soft);}
      .cc-set-row{border-top:1px solid var(--line);}
      .cc-set-name{font-size:13px;}
      .cc-set-grid{display:grid;gap:10px;grid-template-columns:1fr 1fr;}
      @media(min-width:520px){.cc-set-grid{grid-template-columns:1fr 1fr 1fr;}}
      .cc-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--soft);}
      .cc-set-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;justify-content:flex-end;}
      .cc-sync{margin-top:8px;color:var(--green);text-align:right;}
    `}</style>
  );
}
