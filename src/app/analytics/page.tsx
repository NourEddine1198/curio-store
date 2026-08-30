"use client";

import { useCallback, useEffect, useState } from "react";
import DrillModal from "./DrillModal";

// ─────────────────────────────────────────────────────────────
// Curio — /analytics, the scoreboard.
//
// Two rhythms on one page. DAILY is a 30-second look: what needs doing,
// and did yesterday look normal. WEEKLY is the sit-down where the four
// decisions actually get made.
//
// Every number that can be opened, opens — click it and the orders behind
// it appear. A figure you cannot interrogate is one you end up arguing
// with instead of acting on.
//
// READ-ONLY. Nothing here changes an order.
// ─────────────────────────────────────────────────────────────

const ADMIN_KEY_STORAGE = "curio-admin-key";
type PeriodKey = "month" | "last30" | "all";
type View = "daily" | "weekly";

interface Metric { value: number; unit: string; formula: string; caveat?: string }
interface Board {
  generatedAt: string;
  window: { key: PeriodKey; label: string; from: string; to: string; days: number };
  northStars: { profitPerDeliveredOrder: Metric; returnOnAdSpend: Metric };
  funnel: {
    placed: number; confirmed: number; shipped: number; delivered: number;
    returned: number; lost: number; junk: number; stillOpen: number;
    confirmRate: number; deliveryRate: number; returnRate: number;
  };
  money: { collected: number; courierFees: number; netRevenue: number; costs: Record<string, number>; profit: number; receivable: number; inTransit: number };
  products: { slug: string; name: string; unitsDelivered: number; revenue: number; contribution: number;
    grossMarginPerUnit: number; stock: number; unitsPerWeek: number; weeksOfStock: number | null;
    reorderBy: string | null; composite: boolean }[];
  basket: { aov: number; multiItemShare: number; gamesPerOrder: number; bundleShare: number;
    phase1BundleShare: number | null; websiteUpsells: number; phoneUpsells: number };
  tiers: { tier: string; wilayas: number; placed: number; delivered: number; returned: number;
    deliveryRate: number; returnRate: number; revenue: number }[];
  channel: { home: { placed: number; delivered: number; rate: number }; stopdesk: { placed: number; delivered: number; rate: number } };
  ads: { spend: number; costPerDeliveredOrder: number; blendedReturn: number; tracedOrders: number;
    tracedShare: number; perCampaign: { campaign: string; orders: number; delivered: number; revenue: number }[] };
  repeat: { customers: number; repeatBuyers: number; repeatShare: number; ordersFromReturning: number };
  weekly: { weekStart: string; placed: number; delivered: number; revenue: number; adSpend: number }[];
  targets: { key: string; label: string; target: number | null; actual: number; unit: string; met: boolean | null; direction: "below" | "above" }[];
  changes: { label: string; now: number; before: number; changePct: number; unit: string }[];
  caveats: string[];
  attention: { key: string; label: string; count: number; value: number; href: string; severity: "act" | "watch" }[];
  yesterday: { date: string; orders: number; delivered: number; revenue: number; adSpend: number;
    avgOrders: number; avgDelivered: number; avgRevenue: number };
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export default function Analytics() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [view, setView] = useState<View>("weekly");
  const [drill, setDrill] = useState<{ metric: string; title: string; tier?: string; product?: string } | null>(null);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const fetchData = useCallback(async (key: string, p: PeriodKey) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/analytics/board?period=${p}`, { headers: { "X-Admin-Key": key } });
      if (res.status === 401) {
        setAdminKey(""); window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setLoginError(true); setData(null); return;
      }
      if (!res.ok) throw new Error("server " + res.status);
      setData((await res.json()) as Board);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (adminKey) fetchData(adminKey, period); }, [adminKey, period, fetchData]);

  function tryLogin() {
    const k = keyInput.trim(); if (!k) return;
    setLoginError(false);
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE, k);
    setAdminKey(k);
  }

  if (!adminKey) {
    return (
      <div className="sb" dir="ltr"><Style />
        <div className="sb-login"><div className="sb-login-card">
          <div className="sb-logo">Curio</div>
          <h1>Scoreboard</h1>
          <p className="sb-muted">The numbers that decide things.</p>
          <input className="sb-input" type="password" placeholder="Admin key" value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && tryLogin()} autoFocus />
          {loginError && <div className="sb-err">Wrong key — try again.</div>}
          <button className="sb-btn sb-primary sb-wfull" onClick={tryLogin}>Open</button>
        </div></div>
      </div>
    );
  }

  const d = data;
  const open = (metric: string, title: string, extra?: { tier?: string; product?: string }) =>
    setDrill({ metric, title, ...extra });

  return (
    <div className="sb" dir="ltr"><Style />
      <header className="sb-bar">
        <div className="sb-bar-l"><span className="sb-brand">Curio</span><span className="sb-bar-sub">Scoreboard</span></div>
        <div className="sb-bar-r">
          <div className="sb-tabs">
            {(["daily", "weekly"] as View[]).map((v) => (
              <button key={v} className={"sb-tab" + (view === v ? " on" : "")} onClick={() => setView(v)}>
                {v === "daily" ? "Daily" : "Weekly"}
              </button>
            ))}
          </div>
          <div className="sb-tabs">
            {(["month", "last30", "all"] as PeriodKey[]).map((p) => (
              <button key={p} className={"sb-tab" + (period === p ? " on" : "")} onClick={() => setPeriod(p)}>
                {p === "month" ? "Month" : p === "last30" ? "30d" : "All"}
              </button>
            ))}
          </div>
          <a className="sb-btn sb-ghost" href="/finance">Finance →</a>
          <button className="sb-btn sb-ghost" onClick={() => fetchData(adminKey, period)} disabled={loading}>{loading ? "…" : "↻"}</button>
        </div>
      </header>

      {error && <div className="sb-wrap"><div className="sb-alert">Couldn&apos;t load: {error}</div></div>}
      {!d && loading && <div className="sb-loading">Working out the numbers…</div>}

      {d && (
        <div className="sb-wrap">
          {/* ── THE TWO NORTH STARS ── */}
          <section className="sb-stars">
            <div className="sb-star">
              <div className="sb-lbl">Profit per delivered order</div>
              <div className="sb-big sb-ok">{fmt(d.northStars.profitPerDeliveredOrder.value)} <small>DA</small></div>
              <div className="sb-note">{d.window.label.toLowerCase()} · {d.funnel.delivered} delivered</div>
            </div>
            <div className="sb-star">
              <div className="sb-lbl">Return on ad spend, after everything</div>
              <div className="sb-big">{d.northStars.returnOnAdSpend.value}<small>×</small></div>
              <div className="sb-note">{fmt(d.ads.costPerDeliveredOrder)} DA of ads per delivered sale</div>
            </div>
          </section>

          {view === "daily" ? (
            <>
              {/* ── NEEDS DOING ── */}
              <section className="sb-block">
                <h2 className="sb-h2">What needs doing</h2>
                {d.attention.length === 0 ? (
                  <p className="sb-hint">Nothing waiting. Rare — enjoy it.</p>
                ) : (
                  <div className="sb-todo">
                    {d.attention.map((a) => (
                      <a key={a.key} href={a.href} className={"sb-todo-row " + a.severity}>
                        <b>{a.value ? fmt(a.value) : a.count}</b>
                        <span>{a.label}{a.value ? ` · ${a.count} parcels` : ""}</span>
                        <em>open →</em>
                      </a>
                    ))}
                  </div>
                )}
                <p className="sb-hint">
                  These are counts only. Each one opens the screen that actually owns the job —
                  the scoreboard never keeps a second copy of a list.
                </p>
              </section>

              {/* ── YESTERDAY ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Yesterday · {d.yesterday.date}</h2>
                <div className="sb-pulse">
                  <Pulse label="Orders" now={d.yesterday.orders} avg={d.yesterday.avgOrders} />
                  <Pulse label="Delivered" now={d.yesterday.delivered} avg={d.yesterday.avgDelivered} />
                  <Pulse label="Collected" now={d.yesterday.revenue} avg={d.yesterday.avgRevenue} unit="DA" />
                  <Pulse label="Ad spend" now={d.yesterday.adSpend} avg={0} unit="DA" />
                </div>
                <p className="sb-hint">Each against its own 7-day average, so an odd day shows itself.</p>
              </section>
            </>
          ) : (
            <>
              {/* ── FUNNEL ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Where the orders go</h2>
                <div className="sb-funnel">
                  <Step label="Placed" n={d.funnel.placed} onClick={() => open("placed", "Every order placed")} />
                  <Step label="Confirmed" n={d.funnel.confirmed} sub={`${d.funnel.confirmRate}%`} onClick={() => open("confirmed", "Confirmed by the agent")} />
                  <Step label="Delivered" n={d.funnel.delivered} sub={`${d.funnel.deliveryRate}%`} good onClick={() => open("delivered", "Delivered orders")} />
                  <Step label="Returned" n={d.funnel.returned} sub={`${d.funnel.returnRate}%`} bad onClick={() => open("returned", "Orders that came back")} />
                </div>
                <div className="sb-funnel sb-funnel-sm">
                  <Step label="Cancelled / expired" n={d.funnel.lost} onClick={() => open("lost", "Cancelled or expired")} />
                  <Step label="Junk" n={d.funnel.junk} onClick={() => open("junk", "Wrong numbers and duplicates")} />
                  <Step label="Still working" n={d.funnel.stillOpen} onClick={() => open("open", "Still in progress")} />
                </div>
                <p className="sb-hint">
                  Delivery and return rates are of <b>resolved</b> orders only — parcels still in flight
                  would otherwise drag both to a number that means nothing.
                </p>
              </section>

              {/* ── PRODUCTS ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Per product</h2>
                <div className="sb-scroll">
                  <table className="sb-tbl">
                    <thead><tr><th>Product</th><th className="n">Delivered</th><th className="n">Per week</th>
                      <th className="n">Gross margin each</th><th className="n">Stock</th><th className="n">Weeks left</th></tr></thead>
                    <tbody>
                      {d.products.map((p) => (
                        <tr key={p.slug} className="sb-click" onClick={() => open("delivered", p.name, { product: p.slug })}>
                          <td>{p.name}{p.composite && <em className="sb-tag">bundle</em>}</td>
                          <td className="n">{p.unitsDelivered}</td>
                          <td className="n">{p.unitsPerWeek}</td>
                          <td className="n">{fmt(p.grossMarginPerUnit)}</td>
                          <td className="n">{fmt(p.stock)}</td>
                          <td className={"n" + (p.weeksOfStock != null && p.weeksOfStock < 8 ? " sb-bad" : "")}>
                            {p.weeksOfStock ?? "—"}
                            {p.reorderBy && <em className="sb-tag">reorder {p.reorderBy}</em>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="sb-hint">
                  <b>Gross margin</b> is product revenue less printing and wrapping only — it does
                  not carry the courier fee, the agent, ads or returns, so it is always higher than
                  the profit per delivered order at the top of the page.
                  {d.products.some((p) => p.composite) && " A bundle has no shelf of its own — its stock is whichever component runs out first, so don't add it to theirs."}
                </p>
              </section>

              {/* ── BASKET ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Basket — the lever that costs nothing</h2>
                <div className="sb-cards">
                  <Card label="Average order" value={`${fmt(d.basket.aov)} DA`} />
                  <Card label="Games per order" value={String(d.basket.gamesPerOrder)} />
                  <Card label="Orders with 2+ games" value={`${d.basket.bundleShare}%`}
                    sub={d.basket.phase1BundleShare != null ? `Phase 1: ${d.basket.phase1BundleShare}%` : undefined}
                    onClick={() => open("bundle", "Orders holding two or more games")} />
                  <Card label="Upsells taken" value={`${d.basket.websiteUpsells + d.basket.phoneUpsells}`}
                    sub={`${d.basket.websiteUpsells} online · ${d.basket.phoneUpsells} on the phone`} />
                </div>
              </section>

              {/* ── GEOGRAPHY ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Where it goes</h2>
                <div className="sb-scroll">
                  <table className="sb-tbl">
                    <thead><tr><th>Tier</th><th className="n">Wilayas</th><th className="n">Orders</th>
                      <th className="n">Delivered</th><th className="n">Returned</th><th className="n">Collected</th></tr></thead>
                    <tbody>
                      {d.tiers.map((t) => (
                        <tr key={t.tier} className="sb-click" onClick={() => open("delivered", t.tier, { tier: t.tier })}>
                          <td>{t.tier}</td>
                          <td className="n">{t.wilayas}</td>
                          <td className="n">{t.placed}</td>
                          <td className="n sb-ok">{t.deliveryRate}%</td>
                          <td className={"n" + (t.returnRate > 12 ? " sb-bad" : "")}>{t.returnRate}%</td>
                          <td className="n">{fmt(t.revenue)}</td>
                        </tr>
                      ))}
                      <tr><td>Home delivery</td><td className="n">—</td><td className="n">{d.channel.home.placed}</td>
                        <td className="n">{d.channel.home.rate}%</td><td className="n">—</td><td className="n">—</td></tr>
                      <tr><td>Stop-desk</td><td className="n">—</td><td className="n">{d.channel.stopdesk.placed}</td>
                        <td className="n">{d.channel.stopdesk.rate}%</td><td className="n">—</td><td className="n">—</td></tr>
                    </tbody>
                  </table>
                </div>
                <p className="sb-hint">
                  Grouped by what each wilaya costs to deliver to. {d.tiers.reduce((s, t) => s + t.wilayas, 0)} wilayas
                  across {d.funnel.placed} orders is far too thin to judge one at a time.
                </p>
              </section>

              {/* ── ADS ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Advertising</h2>
                <div className="sb-cards">
                  <Card label="Spent" value={`${fmt(d.ads.spend)} DA`} />
                  <Card label="Per delivered sale" value={`${fmt(d.ads.costPerDeliveredOrder)} DA`} />
                  <Card label="Blended return" value={`${d.ads.blendedReturn}×`} />
                  <Card label="Traceable" value={`${d.ads.tracedShare}%`} sub={`${d.ads.tracedOrders} orders`} />
                </div>
                {d.ads.perCampaign.length > 0 && (
                  <div className="sb-scroll">
                    <table className="sb-tbl sb-tbl-sm">
                      <thead><tr><th>Campaign</th><th className="n">Orders</th><th className="n">Delivered</th><th className="n">Collected</th></tr></thead>
                      <tbody>
                        {d.ads.perCampaign.slice(0, 8).map((c) => (
                          <tr key={c.campaign}><td>{c.campaign}</td><td className="n">{c.orders}</td>
                            <td className="n">{c.delivered}</td><td className="n">{fmt(c.revenue)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="sb-hint">
                  The blended figures are the trustworthy ones. Per-campaign covers only the {d.ads.tracedShare}%
                  of orders that carry a tag, so it under-counts every campaign equally.
                </p>
              </section>

              {/* ── REPEAT ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Coming back</h2>
                <div className="sb-cards">
                  <Card label="Customers, all time" value={fmt(d.repeat.customers)} />
                  <Card label="Bought more than once" value={fmt(d.repeat.repeatBuyers)} sub={`${d.repeat.repeatShare}%`} />
                  <Card label="Orders from returning buyers" value={fmt(d.repeat.ordersFromReturning)}
                    onClick={() => open("repeat", "Orders from someone who had bought before")} />
                </div>
              </section>

              {/* ── WEEK BY WEEK ── */}
              <section className="sb-block">
                <h2 className="sb-h2">Week by week</h2>
                <div className="sb-scroll">
                  <table className="sb-tbl sb-tbl-sm">
                    <thead><tr><th>Week starting</th><th className="n">Placed</th><th className="n">Delivered</th>
                      <th className="n">Collected</th><th className="n">Ad spend</th></tr></thead>
                    <tbody>
                      {d.weekly.map((w) => (
                        <tr key={w.weekStart}><td>{w.weekStart}</td><td className="n">{w.placed}</td>
                          <td className="n">{w.delivered}</td><td className="n">{fmt(w.revenue)}</td>
                          <td className="n">{fmt(w.adSpend)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {d.changes.length > 0 && (
                  <>
                    <h3 className="sb-h3">What moved</h3>
                    <div className="sb-moves">
                      {d.changes.slice(0, 4).map((c) => (
                        <div className="sb-move" key={c.label}>
                          <b>{c.label}</b>
                          <span>{fmt(c.before)} → {fmt(c.now)} {c.unit}</span>
                          <em className={c.changePct >= 0 ? "sb-ok" : "sb-bad"}>{c.changePct >= 0 ? "+" : ""}{c.changePct}%</em>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>
            </>
          )}

          {/* ── TARGETS ── */}
          <section className="sb-block">
            <h2 className="sb-h2">Targets</h2>
            <div className="sb-targets">
              {d.targets.map((t) => (
                <div key={t.key} className={"sb-target " + (t.met === null ? "unset" : t.met ? "ok" : "bad")}>
                  <div className="sb-lbl">{t.label}</div>
                  <div className="sb-mid">{fmt(t.actual)}{t.unit === "%" ? "%" : ""}</div>
                  <div className="sb-note">
                    {t.target != null
                      ? `target ${t.direction === "below" ? "≤" : "≥"} ${fmt(t.target)}${t.unit === "%" ? "%" : " " + t.unit} · ${t.met ? "on track" : "off track"}`
                      : "no target set — set one in ⚙ Cost rules on the finance page"}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── CAVEATS ── */}
          <section className="sb-block sb-caveats">
            <h2 className="sb-h2">Before you conclude anything</h2>
            <ul>{d.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </section>

          <p className="sb-foot">
            Read-only · built {new Date(d.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ·
            {" "}{d.window.from} → {d.window.to}
          </p>
        </div>
      )}

      {drill && (
        <DrillModal adminKey={adminKey} metric={drill.metric} title={drill.title}
          period={period} tier={drill.tier} product={drill.product}
          onClose={() => setDrill(null)} />
      )}
    </div>
  );
}

function Step({ label, n, sub, good, bad, onClick }: {
  label: string; n: number; sub?: string; good?: boolean; bad?: boolean; onClick: () => void;
}) {
  return (
    <button className="sb-step" onClick={onClick}>
      <span className={"sb-step-n " + (good ? "sb-ok" : bad ? "sb-bad" : "")}>{n}</span>
      <span className="sb-step-l">{label}</span>
      {sub && <span className="sb-step-s">{sub}</span>}
    </button>
  );
}

function Card({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  const C = onClick ? "button" : "div";
  return (
    <C className={"sb-card" + (onClick ? " sb-clickable" : "")} onClick={onClick}>
      <div className="sb-lbl">{label}</div>
      <div className="sb-mid">{value}</div>
      {sub && <div className="sb-note">{sub}</div>}
    </C>
  );
}

function Pulse({ label, now, avg, unit }: { label: string; now: number; avg: number; unit?: string }) {
  const diff = avg > 0 ? Math.round(((now - avg) / avg) * 100) : null;
  return (
    <div className="sb-card">
      <div className="sb-lbl">{label}</div>
      <div className="sb-mid">{fmt(now)}{unit ? <small> {unit}</small> : null}</div>
      <div className="sb-note">
        {avg > 0 ? <>7-day average {fmt(avg)} · <b className={diff! >= 0 ? "sb-ok" : "sb-bad"}>{diff! >= 0 ? "+" : ""}{diff}%</b></> : "no average yet"}
      </div>
    </div>
  );
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap');
  .sb{--cream:#f4ecd9;--surface:#fffdf8;--ink:#2a2419;--soft:#6b6350;--muted:#a99b76;--line:#ece2cb;
      --gold:#e0a91a;--goldsoft:#fff3d3;--goldline:#f0dcae;--green:#1f7a52;--greensoft:#e7f3ec;
      --coral:#c0392b;--coralsoft:#fce9e2;--coralline:#f6d2c7;--amber:#c98a1b;
      --disp:"Quicksand",system-ui,sans-serif;--body:"Nunito",system-ui,sans-serif;
      min-height:100vh;background:var(--cream);color:var(--ink);font-family:var(--body);
      background-image:radial-gradient(1000px 440px at 84% -10%,#fdf3da 0%,transparent 60%);}
  .sb *{box-sizing:border-box;}
  .sb-wrap{max-width:1080px;margin:0 auto;padding:20px 18px 60px;}
  .sb-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
          padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--line);}
  .sb-bar-l{display:flex;align-items:baseline;gap:10px;}
  .sb-brand{font-family:var(--disp);font-weight:700;letter-spacing:.24em;text-transform:uppercase;font-size:12px;color:var(--gold);}
  .sb-bar-sub{font-family:var(--disp);font-weight:700;font-size:17px;}
  .sb-bar-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .sb-tabs{display:flex;background:var(--cream);border:1px solid var(--line);border-radius:9px;padding:2px;}
  .sb-tab{border:none;background:transparent;font-family:var(--body);font-weight:700;font-size:12.5px;
          color:var(--soft);padding:5px 11px;border-radius:7px;cursor:pointer;}
  .sb-tab.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(70,52,15,.1);}
  .sb-btn{font-family:var(--body);font-weight:700;font-size:13px;padding:7px 13px;border-radius:9px;
          border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer;text-decoration:none;}
  .sb-ghost{background:transparent;} .sb-primary{background:var(--gold);border-color:var(--gold);color:#221c0a;}
  .sb-wfull{width:100%;margin-top:10px;}
  .sb-login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .sb-login-card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:32px;
                 max-width:360px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(70,52,15,.12);}
  .sb-logo{font-family:var(--disp);font-size:13px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold);font-weight:700;}
  .sb-login-card h1{font-family:var(--disp);margin:8px 0 4px;font-size:25px;}
  .sb-err{color:var(--coral);font-size:13px;margin-top:8px;}
  .sb-input{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:9px;font-family:var(--body);
            font-size:14px;background:#fff;color:var(--ink);margin-top:12px;}
  .sb-loading{padding:60px;text-align:center;color:var(--soft);}
  .sb-alert{background:var(--coralsoft);border:1px solid var(--coralline);border-radius:12px;padding:13px 17px;
            margin-bottom:16px;font-size:14px;color:#7d2c20;}
  .sb-stars{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;}
  @media(max-width:720px){.sb-stars{grid-template-columns:1fr;}}
  .sb-star{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:20px 22px;}
  .sb-lbl{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);}
  .sb-big{font-family:var(--disp);font-size:clamp(30px,5vw,44px);font-weight:700;line-height:1.05;margin-top:5px;
          font-variant-numeric:tabular-nums;}
  .sb-big small{font-size:.4em;color:var(--muted);}
  .sb-mid{font-family:var(--disp);font-size:23px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums;}
  .sb-mid small{font-size:.55em;color:var(--muted);}
  .sb-ok{color:var(--green);} .sb-bad{color:var(--coral);}
  .sb-note{font-size:12.5px;color:var(--soft);margin-top:6px;line-height:1.45;}
  .sb-block{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px 20px;margin-bottom:14px;}
  .sb-h2{font-family:var(--disp);font-size:17px;font-weight:700;margin:0 0 12px;}
  .sb-h3{font-family:var(--disp);font-size:14px;font-weight:700;margin:20px 0 8px;color:var(--soft);}
  .sb-hint{font-size:12.5px;color:var(--soft);margin:12px 0 0;line-height:1.5;}
  .sb-funnel{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
  .sb-funnel-sm{grid-template-columns:repeat(3,1fr);margin-top:10px;}
  @media(max-width:620px){.sb-funnel,.sb-funnel-sm{grid-template-columns:repeat(2,1fr);}}
  .sb-step{background:var(--cream);border:1px solid var(--line);border-radius:12px;padding:13px 11px;
           cursor:pointer;font-family:var(--body);text-align:left;display:flex;flex-direction:column;gap:2px;}
  .sb-step:hover{background:var(--goldsoft);border-color:var(--goldline);}
  .sb-step-n{font-family:var(--disp);font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;}
  .sb-step-l{font-size:12px;color:var(--soft);font-weight:700;}
  .sb-step-s{font-size:11.5px;color:var(--muted);}
  .sb-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
  @media(max-width:820px){.sb-cards{grid-template-columns:repeat(2,1fr);}}
  .sb-card{background:var(--cream);border:1px solid var(--line);border-radius:12px;padding:13px 15px;
           text-align:left;font-family:var(--body);}
  .sb-clickable{cursor:pointer;} .sb-clickable:hover{background:var(--goldsoft);border-color:var(--goldline);}
  .sb-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  .sb-tbl{width:100%;border-collapse:collapse;font-size:14px;min-width:540px;}
  .sb-tbl th{text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);
             font-weight:700;padding:0 12px 7px 0;border-bottom:1px solid var(--line);}
  .sb-tbl td{padding:10px 12px 10px 0;border-bottom:1px solid var(--line);}
  .sb-tbl tr:last-child td{border-bottom:none;}
  .sb-tbl td:first-child{font-weight:700;}
  .sb-tbl .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .sb-tbl-sm{font-size:13px;}
  .sb-click{cursor:pointer;} .sb-click:hover{background:var(--goldsoft);}
  .sb-tag{display:inline-block;margin-left:7px;font-style:normal;font-size:10px;font-weight:700;
          background:var(--goldsoft);color:var(--amber);border:1px solid var(--goldline);padding:1px 6px;border-radius:20px;}
  .sb-todo{display:grid;gap:7px;}
  .sb-todo-row{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;
               padding:11px 14px;border-radius:11px;text-decoration:none;color:inherit;
               background:var(--cream);border:1px solid var(--line);}
  .sb-todo-row.act{background:var(--coralsoft);border-color:var(--coralline);}
  .sb-todo-row.watch{background:var(--goldsoft);border-color:var(--goldline);}
  .sb-todo-row b{font-family:var(--disp);font-size:20px;font-variant-numeric:tabular-nums;}
  .sb-todo-row span{font-size:13.5px;}
  .sb-todo-row em{font-style:normal;font-size:12px;color:var(--soft);font-weight:700;}
  .sb-pulse{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
  @media(max-width:820px){.sb-pulse{grid-template-columns:repeat(2,1fr);}}
  .sb-moves{display:grid;gap:6px;}
  .sb-move{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:baseline;
           padding:8px 0;border-bottom:1px solid var(--line);font-size:13.5px;}
  .sb-move:last-child{border-bottom:none;}
  .sb-move span{color:var(--soft);font-variant-numeric:tabular-nums;}
  .sb-move em{font-style:normal;font-weight:700;font-variant-numeric:tabular-nums;}
  .sb-targets{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}
  @media(max-width:820px){.sb-targets{grid-template-columns:repeat(2,1fr);}}
  .sb-target{border-radius:12px;padding:13px 15px;border:1px solid var(--line);background:var(--cream);}
  .sb-target.ok{background:var(--greensoft);border-color:#cfe8da;}
  .sb-target.bad{background:var(--coralsoft);border-color:var(--coralline);}
  .sb-target.unset{opacity:.72;}
  .sb-caveats ul{margin:0;padding-left:19px;}
  .sb-caveats li{font-size:13px;color:var(--soft);margin:7px 0;line-height:1.55;}
  .sb-foot{text-align:center;font-size:12px;color:var(--muted);margin-top:18px;}
  .sb-muted{color:var(--soft);}
`;

function Style() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}
