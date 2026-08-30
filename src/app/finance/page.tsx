"use client";

import { useCallback, useEffect, useState } from "react";
import PayoutModal, { type UnsettledParcel } from "./PayoutModal";
import MovementModal, { type AccountOpt, type CategoryOpt } from "./MovementModal";
import QuickEntry from "./QuickEntry";
import PhoneHome from "./PhoneHome";
import HandDeliveryModal, { type Candidate } from "./HandDeliveryModal";
import SettleRunModal, { type HeldOrder } from "./SettleRunModal";

// ─────────────────────────────────────────────────────────────
// Curio — /finance (phase 1: the truth)
//
// READ-ONLY except the cost rules. Shows the profit the business
// actually made, worked out from orders and parcels rather than
// from numbers somebody remembered to type.
//
// Everything on this page is derived live. There is no stored
// profit figure to go stale when a cost rule changes.
// ─────────────────────────────────────────────────────────────

const ADMIN_KEY_STORAGE = "curio-admin-key";   // shared with /dashboard

type PeriodKey = "month" | "last30" | "all";

interface TypedCost { categoryKey: string; label: string; amountDzd: number; count: number }
interface Report {
  generatedAt: string;
  period: { key: PeriodKey; label: string; from: string; to: string; days: number };
  rules: Record<string, number | string>;
  revenue: {
    parcels: number; collected: number; courierFees: number; net: number;
    games: { roubla: number; dlala: number; other: number; total: number };
  };
  costs: {
    print: number; wrapping: number; confirmation: number; upsellBonus: number;
    returnFees: number; returns: number; upsells: number;
    driverFees: number; handDelivered: number; influencer: number;
    typed: TypedCost[]; typedTotal: number; total: number;
  };
  profit: number;
  perDeliveredOrder: number;
  receivable: {
    total: number; parcels: number;
    collectedNotPaid: { total: number; parcels: number };
    deliveredNotCollected: { total: number; parcels: number };
    inTransit: { gross: number; parcels: number };
    settledSoFar: number;
  };
  accounts: {
    key: string; name: string; currency: string;
    inAmount: number; outAmount: number;
    inDzd: number; outDzd: number; netDzd: number; movements: number;
  }[];
  discrepancies: {
    orderNumber: number; ours: number; theirs: number; diff: number;
    trackingCode: string; status: string; customerName: string;
  }[];
  assumptions: { key: string; label: string; value: string; unit: string | null; note: string | null }[];
  freshness: { parcelsSyncedAt: string | null; ageHours: number | null; stale: boolean };
}

interface PayoutRow {
  id: string; reference: string; collectedAt: string; parcelCount: number | null;
  slipTotal: number; expectedTotal: number; settledParcels: number; note: string | null;
}
interface MovementRow {
  id: string; occurredAt: string; direction: string; amount: number; currency: string;
  amountDzd: number; fxRate: number | null; categoryKey: string; note: string | null;
  payoutId: string | null; createdBy: string;
  account: { key: string; name: string; currency: string };
  toAccount: { key: string; name: string } | null;
  category: { label: string; labelAr: string | null; kind: string; auto: boolean } | null;
}

interface SettingRow {
  key: string; value: string; label: string | null;
  unit: string | null; note: string | null; sort: number;
}

/** Algiers is UTC+1 all year. Slicing a raw ISO string shows the UTC day,
 *  which after 23:00 local is yesterday — so a range that ends "today" would
 *  read as ending yesterday every evening. Shift before slicing. */
const dayInAlgiers = (iso: string) =>
  new Date(new Date(iso).getTime() + 60 * 60000).toISOString().slice(0, 10);

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number) => (n < 0 ? "−" : "") + fmt(Math.abs(n));

function money(n: number, currency = "DZD") {
  if (currency === "EUR") return "€" + (n / 100).toFixed(2);
  return fmt(n) + " DA";
}

export default function Finance() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState<SettingRow[] | null>(null);
  const [rulesMsg, setRulesMsg] = useState("");

  // ── phase 2 · the receivable, the slips and the ledger ──
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [unsettled, setUnsettled] = useState<UnsettledParcel[]>([]);
  const [movements, setMovements] = useState<MovementRow[]>([]);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [categories, setCategories] = useState<CategoryOpt[]>([]);
  const [eurDzd, setEurDzd] = useState(280);
  const [showParcels, setShowParcels] = useState(false);
  const [showPayout, setShowPayout] = useState(false);
  const [showMovement, setShowMovement] = useState(false);
  const [flash, setFlash] = useState("");
  const [quick, setQuick] = useState<null | "out" | "in">(null);
  const [showHand, setShowHand] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [withDriver, setWithDriver] = useState<HeldOrder[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [handDone, setHandDone] = useState<{ orderNumber: number; customerName: string; wilayaName: string; total: number; handDeliveryFee: number | null; handDeliveredAt: string; driverAttempts: number }[]>([]);
  const [defaultFee, setDefaultFee] = useState(350);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const fetchData = useCallback(async (key: string, p: PeriodKey) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/finance?period=${p}`, { headers: { "X-Admin-Key": key } });
      if (res.status === 401) {
        setAdminKey(""); window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setLoginError(true); setData(null); return;
      }
      if (!res.ok) throw new Error("server " + res.status);
      setData((await res.json()) as Report);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally { setLoading(false); }
  }, []);

  /** Payouts, the unsettled pile and the ledger. Separate from the profit
   *  report so a slow parcel list never delays the number at the top. */
  const fetchLedger = useCallback(async (key: string) => {
    try {
      const [po, mv, hd] = await Promise.all([
        fetch("/api/finance/payouts", { headers: { "X-Admin-Key": key } }),
        fetch("/api/finance/movements?days=60", { headers: { "X-Admin-Key": key } }),
        fetch("/api/finance/hand-delivery", { headers: { "X-Admin-Key": key } }),
      ]);
      if (po.ok) {
        const d = await po.json();
        setPayouts(d.payouts || []);
        setUnsettled(d.unsettled || []);
      }
      if (mv.ok) {
        const d = await mv.json();
        setMovements(d.movements || []);
        setAccounts(d.accounts || []);
        setCategories(d.categories || []);
        if (d.eurDzd) setEurDzd(d.eurDzd);
      }
      if (hd.ok) {
        const d = await hd.json();
        setCandidates(d.candidates || []);
        setWithDriver(d.withDriver || []);
        setHandDone(d.done || []);
        if (d.defaultFee) setDefaultFee(d.defaultFee);
      }
    } catch { /* the profit page still works without the ledger */ }
  }, []);

  const refreshAll = useCallback((key: string, p: PeriodKey) => {
    fetchData(key, p);
    fetchLedger(key);
  }, [fetchData, fetchLedger]);

  useEffect(() => { if (adminKey) refreshAll(adminKey, period); }, [adminKey, period, refreshAll]);

  function afterWrite(msg: string) {
    setShowPayout(false);
    setShowMovement(false);
    setQuick(null);
    setShowHand(false);
    setShowSettle(false);
    setFlash(msg);
    refreshAll(adminKey, period);
    setTimeout(() => setFlash(""), 7000);
  }

  async function undoPayout(id: string, reference: string) {
    if (!window.confirm(`Undo slip ${reference}? Its cash row goes, and its parcels go back to being owed.`)) return;
    const res = await fetch(`/api/finance/payouts?id=${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { "X-Admin-Key": adminKey },
    });
    const d = await res.json().catch(() => ({}));
    afterWrite(res.ok ? `Slip ${reference} undone — ${d.freedParcels ?? 0} parcels are owed again.` : (d.error || "Couldn't undo it"));
  }

  async function undoHandDelivery(orderNumber: number) {
    if (!window.confirm(`Undo #${orderNumber}? It goes back to confirmed and stops counting as a sale.`)) return;
    const res = await fetch(`/api/finance/hand-delivery?orderNumber=${orderNumber}`, {
      method: "DELETE", headers: { "X-Admin-Key": adminKey },
    });
    const d = await res.json().catch(() => ({}));
    afterWrite(res.ok ? `#${orderNumber} is no longer a hand delivery.` : (d.error || "Couldn't undo it"));
  }

  async function deleteMovement(id: string) {
    if (!window.confirm("Delete this line from the ledger?")) return;
    const res = await fetch(`/api/finance/movements?id=${encodeURIComponent(id)}`, {
      method: "DELETE", headers: { "X-Admin-Key": adminKey },
    });
    const d = await res.json().catch(() => ({}));
    afterWrite(res.ok ? "Deleted." : (d.error || "Couldn't delete it"));
  }

  async function openRules() {
    setShowRules(true); setRulesMsg("");
    const res = await fetch("/api/finance/settings", { headers: { "X-Admin-Key": adminKey } });
    if (res.ok) setRules((await res.json()).settings as SettingRow[]);
    else setRulesMsg("Couldn't load the cost rules.");
  }

  async function saveRule(key: string, value: string) {
    setRulesMsg("Saving…");
    const res = await fetch("/api/finance/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      setRulesMsg("Saved ✓");
      refreshAll(adminKey, period);         // the profit reacts immediately
      setTimeout(() => setRulesMsg(""), 2500);
    } else {
      setRulesMsg("That didn't save — check the value.");
    }
  }

  function tryLogin() {
    const key = keyInput.trim(); if (!key) return;
    setLoginError(false);
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    setAdminKey(key);
  }
  function logout() {
    window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    setAdminKey(""); setData(null); setKeyInput("");
  }

  // ─── LOGIN ───
  if (!adminKey) {
    return (
      <div className="fin" dir="ltr"><Style />
        <div className="fin-login">
          <div className="fin-login-card">
            <div className="fin-logo">Curio</div>
            <h1>Finance</h1>
            <p className="fin-muted">Your money, in one place.</p>
            <input className="fin-input" type="password" placeholder="Admin key" value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()} autoFocus />
            {loginError && <div className="fin-err">Wrong key — try again.</div>}
            <button className="fin-btn fin-primary fin-wfull" onClick={tryLogin}>Open</button>
            <p className="fin-tiny fin-muted">Owner only · nothing here can change an order.</p>
          </div>
        </div>
      </div>
    );
  }

  const r = data;

  return (
    <div className="fin" dir="ltr"><Style />
      <header className="fin-bar">
        <div className="fin-bar-l">
          <span className="fin-brand">Curio</span>
          <span className="fin-bar-sub">Finance</span>
        </div>
        <div className="fin-bar-r">
          <div className="fin-tabs">
            {(["month", "last30", "all"] as PeriodKey[]).map((p) => (
              <button key={p} className={"fin-tab" + (period === p ? " on" : "")} onClick={() => setPeriod(p)}>
                {p === "month" ? "This month" : p === "last30" ? "30 days" : "All"}
              </button>
            ))}
          </div>
          <button className="fin-btn fin-ghost" onClick={() => refreshAll(adminKey, period)} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
          <a className="fin-btn fin-ghost" href="/analytics">Scoreboard →</a>
          <button className="fin-btn fin-ghost" onClick={openRules}>⚙ Cost rules</button>
          <button className="fin-btn fin-ghost" onClick={logout}>Logout</button>
        </div>
      </header>

      {error && <div className="fin-wrap"><div className="fin-alert">Couldn&apos;t load: {error}. Try ↻.</div></div>}
      {!r && loading && <div className="fin-loading">Working out your money…</div>}

      {flash && <div className="fin-wrap fin-flashwrap"><div className="fin-flash">{flash}</div></div>}

      {r && (
        <PhoneHome
          profit={r.profit}
          profitLabel={r.period.label}
          perOrder={r.perDeliveredOrder}
          delivered={r.revenue.parcels}
          stale={r.freshness.stale}
          owed={r.receivable.total}
          owedParcels={r.receivable.parcels}
          notCollected={r.receivable.deliveredNotCollected.total}
          notCollectedParcels={r.receivable.deliveredNotCollected.parcels}
          unsettledCount={unsettled.length}
          movements={movements}
          dayInAlgiers={dayInAlgiers}
          costs={[
            { label: "Collected", amount: r.revenue.collected, positive: true },
            { label: "Courier fees", amount: r.revenue.courierFees },
            { label: "Printing", amount: r.costs.print },
            { label: "Wrapping", amount: r.costs.wrapping },
            { label: "Confirmation", amount: r.costs.confirmation },
            { label: "Returns", amount: r.costs.returnFees },
            ...r.costs.typed.map((t) => ({ label: t.label, amount: t.amountDzd })),
          ]}
          onSpend={() => setQuick("out")}
          onReceive={() => setQuick("in")}
          onPayout={() => setShowPayout(true)}
          onDelete={deleteMovement}
        />
      )}

      {r && (
        <div className="fin-wrap fin-desk">

          {/* Freshness — revenue and the receivable both come from the
              parcel cache, so if it stops updating the profit goes quietly
              wrong. Better to say so than to show a confident wrong number. */}
          {r.freshness.stale ? (
            <div className="fin-alert">
              <b>Profit hidden.</b> The parcel data from Ecotrack was last checked{" "}
              {r.freshness.ageHours == null ? "never" : `${r.freshness.ageHours} hours ago`}.
              Revenue is read from it, so anything shown now would be out of date. Run the tracking sync, then refresh.
            </div>
          ) : null}

          {/* ── HERO ── */}
          <section className="fin-hero">
            <div className="fin-hero-main">
              <div className="fin-lbl">Profit · {r.period.label.toLowerCase()}</div>
              {r.freshness.stale ? (
                <div className="fin-big fin-dim">—</div>
              ) : (
                <div className={"fin-big " + (r.profit >= 0 ? "fin-ok" : "fin-bad")}>
                  {r.profit < 0 ? "−" : ""}<small>DA</small> {fmt(Math.abs(r.profit))}
                </div>
              )}
              <div className="fin-note">
                {fmt(r.perDeliveredOrder)} DA per delivered order · {r.revenue.parcels} delivered ·{" "}
                {dayInAlgiers(r.period.from)} → {dayInAlgiers(r.period.to)}
              </div>
            </div>

            <div className="fin-hero-side">
              <div className="fin-card fin-card-gold">
                <div className="fin-lbl">Ecotrack is holding</div>
                <div className="fin-mid">{fmt(r.receivable.total)} <small>DA</small></div>
                <div className="fin-note">
                  {r.receivable.parcels} parcels · they pay in cash, on request
                </div>
                {r.receivable.deliveredNotCollected.parcels > 0 && (
                  <div className="fin-warn-line">
                    {fmt(r.receivable.deliveredNotCollected.total)} DA of that is on{" "}
                    {r.receivable.deliveredNotCollected.parcels} parcels marked{" "}
                    <b>delivered but never collected</b> — worth a call.
                  </div>
                )}
                <div className="fin-cardbtns">
                  <button className="fin-btn fin-primary" onClick={() => setShowPayout(true)}
                    disabled={unsettled.length === 0}>
                    Record a payout
                  </button>
                  <button className="fin-btn" onClick={() => setShowParcels((v) => !v)}>
                    {showParcels ? "Hide the parcels" : `See all ${unsettled.length}`}
                  </button>
                </div>
                {r.receivable.settledSoFar > 0 && (
                  <div className="fin-note">
                    {fmt(r.receivable.settledSoFar)} DA collected so far, over{" "}
                    {payouts.length} slip{payouts.length === 1 ? "" : "s"}.
                  </div>
                )}
              </div>

              <div className="fin-card">
                <div className="fin-lbl">Still in transit</div>
                <div className="fin-mid">{fmt(r.receivable.inTransit.gross)} <small>DA</small></div>
                <div className="fin-note">{r.receivable.inTransit.parcels} parcels · not owed yet</div>
              </div>
            </div>
          </section>

          {/* ── THE P&L ── */}
          <section className="fin-block">
            <h2 className="fin-h2">Where the money went</h2>
            <table className="fin-tbl">
              <tbody>
                <tr>
                  <td>Collected from customers</td>
                  <td className="fin-src">{r.revenue.parcels} delivered parcels, at what the courier actually took</td>
                  <td className="fin-num fin-ok">+{fmt(r.revenue.collected)}</td>
                </tr>
                <tr>
                  <td>Courier delivery fees</td>
                  <td className="fin-src">Ecotrack&apos;s own charge, per parcel</td>
                  <td className="fin-num">−{fmt(r.revenue.courierFees)}</td>
                </tr>
                <tr className="fin-sub">
                  <td><b>Net cash you are owed</b></td>
                  <td className="fin-src">What the payout slips will add up to</td>
                  <td className="fin-num"><b>{fmt(r.revenue.net)}</b></td>
                </tr>

                <tr>
                  <td>Printing</td>
                  <td className="fin-src">
                    {r.revenue.games.roubla} Roubla × {fmt(Number(r.rules.printRoubla))} ·{" "}
                    {r.revenue.games.dlala} Dlala × {fmt(Number(r.rules.printDlala))}
                    {r.revenue.games.other ? ` · ${r.revenue.games.other} other × ${fmt(Number(r.rules.printDefault))}` : ""}
                  </td>
                  <td className="fin-num">−{fmt(r.costs.print)}</td>
                </tr>
                <tr>
                  <td>Wrapping</td>
                  <td className="fin-src">
                    Charged when the box is packed, not when it arrives —{" "}
                    {fmt(Number(r.rules.wrapRoubla))}/Roubla, {fmt(Number(r.rules.wrapDlala))}/Dlala
                  </td>
                  <td className="fin-num">−{fmt(r.costs.wrapping)}</td>
                </tr>
                <tr>
                  <td>Confirmation agent</td>
                  <td className="fin-src">
                    {r.revenue.parcels} delivered × {fmt(Number(r.rules.confirmationPerOrder))} DA
                    {r.costs.upsellBonus === 0 && " · no phone upsells counted yet"}
                  </td>
                  <td className="fin-num">−{fmt(r.costs.confirmation)}</td>
                </tr>
                {r.costs.upsellBonus > 0 && (
                  <tr>
                    <td>Upsell bonuses</td>
                    <td className="fin-src">
                      {r.costs.upsells} game{r.costs.upsells === 1 ? "" : "s"} she sold on the phone,
                      on orders that arrived × {fmt(Number(r.rules.upsellBonus))} DA
                    </td>
                    <td className="fin-num">−{fmt(r.costs.upsellBonus)}</td>
                  </tr>
                )}
                {r.costs.driverFees > 0 && (
                  <tr>
                    <td>Our delivery guy</td>
                    <td className="fin-src">
                      {r.costs.handDelivered} order{r.costs.handDelivered === 1 ? "" : "s"} he carried,
                      at the fee you set on each
                    </td>
                    <td className="fin-num">−{fmt(r.costs.driverFees)}</td>
                  </tr>
                )}
                <tr>
                  <td>Returns</td>
                  <td className="fin-src">{r.costs.returns} returns × {fmt(Number(r.rules.returnFee))} DA</td>
                  <td className="fin-num">−{fmt(r.costs.returnFees)}</td>
                </tr>
                {r.costs.influencer > 0 && (
                  <tr>
                    <td>Influencer payouts</td>
                    <td className="fin-src">From the payout log on /influencers</td>
                    <td className="fin-num">−{fmt(r.costs.influencer)}</td>
                  </tr>
                )}

                {r.costs.typed.map((t) => (
                  <tr key={t.categoryKey}>
                    <td>{t.label}</td>
                    <td className="fin-src">{t.count} {t.count === 1 ? "entry" : "entries"} you recorded</td>
                    <td className="fin-num">−{fmt(t.amountDzd)}</td>
                  </tr>
                ))}

                <tr className="fin-total">
                  <td><b>Profit</b></td>
                  <td className="fin-src">{r.period.days} days</td>
                  <td className={"fin-num " + (r.profit >= 0 ? "fin-ok" : "fin-bad")}>
                    <b>{signed(r.profit)}</b>
                  </td>
                </tr>
              </tbody>
            </table>

            {r.costs.typed.length === 0 && (
              <p className="fin-hint">
                Nothing typed yet beyond what the system works out for itself. The content creator,
                sacs and scotch will appear here once the phone screen lands in phase 3.
              </p>
            )}
          </section>

          {/* ── THE PARCELS BEHIND THE RECEIVABLE ── */}
          {showParcels && (
            <section className="fin-block">
              <h2 className="fin-h2">What Ecotrack is holding, parcel by parcel</h2>
              <p className="fin-hint fin-hint-top">
                Oldest first — that is the order to chase it in. Anything past two weeks is
                marked, and «not collected» means the box went out but no money came back.
              </p>
              <div className="fin-scroll">
                <table className="fin-tbl fin-tbl-tight">
                  <thead>
                    <tr><th>Order</th><th>Customer</th><th>Wilaya</th><th className="fin-num">Held</th><th className="fin-num">Net owed</th></tr>
                  </thead>
                  <tbody>
                    {unsettled.map((p) => (
                      <tr key={p.trackingCode}>
                        <td>{p.orderNumber ? "#" + p.orderNumber : p.trackingCode.slice(-6)}</td>
                        <td className="fin-src">
                          {p.customerName}
                          {!p.collected && <span className="fin-chip">not collected</span>}
                        </td>
                        <td className="fin-src">{p.wilaya}</td>
                        <td className={"fin-num" + ((p.daysHeld ?? 0) >= 14 ? " fin-bad" : "")}>
                          {p.daysHeld == null ? "—" : p.daysHeld === 0 ? "today" : p.daysHeld + "d"}
                        </td>
                        <td className="fin-num">{fmt(p.net)}</td>
                      </tr>
                    ))}
                    <tr className="fin-total">
                      <td colSpan={4}><b>{unsettled.length} parcels</b></td>
                      <td className="fin-num"><b>{fmt(unsettled.reduce((x, p) => x + p.net, 0))}</b></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── OUR OWN DELIVERY GUY ── */}
          <section className="fin-block">
            <div className="fin-blockhead">
              <h2 className="fin-h2">Our delivery guy</h2>
              <span className="fin-cardbtns">
                {withDriver.length > 0 && (
                  <button className="fin-btn fin-primary" onClick={() => setShowSettle(true)}>
                    He is back — settle {withDriver.length}
                  </button>
                )}
                <button className={"fin-btn" + (withDriver.length === 0 ? " fin-primary" : "")}
                  onClick={() => setShowHand(true)} disabled={candidates.length === 0}>
                  Give him boxes
                </button>
              </span>
            </div>

            {withDriver.length > 0 && (
              <div className="fin-openrun">
                <div className="fin-openrun-h">
                  <b>{withDriver.length} box{withDriver.length === 1 ? "" : "es"} are with him</b>
                  <span>
                    since {dayInAlgiers(withDriver[0].handedToDriverAt)} · {fmt(withDriver.reduce((s, o) => s + o.total, 0))} DA to collect
                  </span>
                </div>
                <div className="fin-openrun-list">
                  {withDriver.map((o) => (
                    <span key={o.orderNumber} className="fin-runchip">
                      #{o.orderNumber} <em>{o.customerName}</em>
                      {o.driverAttempts > 0 && <b> {o.driverAttempts}×</b>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {handDone.length === 0 ? (
              <p className="fin-hint fin-hint-top">
                Nothing delivered by hand yet. Give him boxes in the evening, then settle the run
                when he comes back — otherwise those sales have no Ecotrack parcel and the profit
                would count them as <b>zero revenue</b>.
                {candidates.length > 0
                  ? ` ${candidates.length} Algiers doorstep order${candidates.length === 1 ? " is" : "s are"} available to give him.`
                  : " No Algiers doorstep orders are waiting right now."}
              </p>
            ) : (
              <>
                <div className="fin-scroll">
                  <table className="fin-tbl fin-tbl-tight">
                    <thead>
                      <tr><th>Order</th><th>Customer</th><th>Delivered</th>
                        <th className="fin-num">Collected</th><th className="fin-num">His fee</th><th></th></tr>
                    </thead>
                    <tbody>
                      {handDone.map((o) => (
                        <tr key={o.orderNumber}>
                          <td>#{o.orderNumber}</td>
                          <td className="fin-src">{o.customerName}</td>
                          <td className="fin-src">
                            {dayInAlgiers(o.handDeliveredAt)}
                            {o.driverAttempts > 1 && <em className="fin-mnote">{o.driverAttempts} attempts</em>}
                          </td>
                          <td className="fin-num fin-ok">+{fmt(o.total)}</td>
                          <td className="fin-num">−{fmt(o.handDeliveryFee ?? 0)}</td>
                          <td className="fin-num">
                            <button className="fin-x" title="Undo — back to confirmed"
                              onClick={() => undoHandDelivery(o.orderNumber)}>✕</button>
                          </td>
                        </tr>
                      ))}
                      <tr className="fin-total">
                        <td colSpan={3}><b>{handDone.length} delivered by hand</b></td>
                        <td className="fin-num fin-ok"><b>{fmt(handDone.reduce((s, o) => s + o.total, 0))}</b></td>
                        <td className="fin-num"><b>{fmt(handDone.reduce((s, o) => s + (o.handDeliveryFee ?? 0), 0))}</b></td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="fin-hint">
                  His fee is a cost the moment you record the delivery. Paying him is a separate
                  cash line — use <b>+ Record money</b>, and it moves the drawer without counting
                  the same 350 twice.
                </p>
              </>
            )}
          </section>

          {/* ── THE LEDGER ── */}
          <section className="fin-block">
            <div className="fin-blockhead">
              <h2 className="fin-h2">The ledger — money that actually moved</h2>
              <button className="fin-btn fin-primary" onClick={() => setShowMovement(true)}>+ Record money</button>
            </div>

            {movements.length === 0 ? (
              <p className="fin-hint">
                Nothing recorded yet. Use <b>+ Record money</b> for the things no system can
                know — a bag of scotch, a video you paid for, cash from a hand delivery.
              </p>
            ) : (
              <div className="fin-scroll">
                <table className="fin-tbl fin-tbl-tight">
                  <thead>
                    <tr><th>Date</th><th>What for</th><th>Account</th><th className="fin-num">Amount</th><th></th></tr>
                  </thead>
                  <tbody>
                    {movements.map((m) => (
                      <tr key={m.id}>
                        <td>{dayInAlgiers(m.occurredAt)}</td>
                        <td className="fin-src">
                          {m.category?.label || m.categoryKey}
                          {m.category?.auto && <span className="fin-chip fin-chip-quiet">ledger only</span>}
                          {m.note && <em className="fin-mnote">{m.note}</em>}
                        </td>
                        <td className="fin-src">
                          {m.account.name}
                          {m.toAccount && <> → {m.toAccount.name}</>}
                        </td>
                        <td className={"fin-num " + (m.direction === "in" ? "fin-ok" : "")}>
                          {m.direction === "in" ? "+" : "−"}
                          {m.currency === "EUR" ? "€" + (m.amount / 100).toFixed(2) : fmt(m.amount)}
                          {m.currency === "EUR" && <em className="fin-conv">{fmt(m.amountDzd)} DA</em>}
                        </td>
                        <td className="fin-num">
                          <button className="fin-x" title={m.payoutId ? "Undo the payout instead" : "Delete"}
                            onClick={() => deleteMovement(m.id)}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {payouts.length > 0 && (
              <>
                <h3 className="fin-h3">Payout slips recorded</h3>
                <div className="fin-scroll">
                  <table className="fin-tbl fin-tbl-tight">
                    <thead>
                      <tr><th>Slip</th><th>Date</th><th className="fin-num">Parcels</th>
                        <th className="fin-num">We expected</th><th className="fin-num">Slip said</th>
                        <th className="fin-num">Difference</th><th></th></tr>
                    </thead>
                    <tbody>
                      {payouts.map((p) => {
                        const diff = p.slipTotal - p.expectedTotal;
                        return (
                          <tr key={p.id}>
                            <td>{p.reference}</td>
                            <td className="fin-src">{dayInAlgiers(p.collectedAt)}</td>
                            <td className="fin-num">{p.settledParcels}</td>
                            <td className="fin-num">{fmt(p.expectedTotal)}</td>
                            <td className="fin-num">{fmt(p.slipTotal)}</td>
                            <td className={"fin-num " + (diff === 0 ? "fin-ok" : "fin-bad")}>
                              {diff === 0 ? "match" : signed(diff)}
                            </td>
                            <td className="fin-num">
                              <button className="fin-x" title="Undo this payout"
                                onClick={() => undoPayout(p.id, p.reference)}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {/* ── ACCOUNTS ── */}
          <section className="fin-block">
            <h2 className="fin-h2">The three accounts</h2>
            <div className="fin-accounts">
              {r.accounts.map((a) => (
                <div className="fin-card" key={a.key}>
                  <div className="fin-lbl">{a.name} <span className="fin-cur">{a.currency}</span></div>
                  <div className="fin-acct-rows">
                    <div><span>in</span><b className="fin-ok">{money(a.inAmount, a.currency)}</b></div>
                    <div><span>out</span><b>{money(a.outAmount, a.currency)}</b></div>
                  </div>
                  <div className="fin-note">
                    {a.movements === 0
                      ? "no movements recorded yet"
                      : a.currency === "EUR"
                        ? `= ${fmt(a.outDzd)} DA out at today's rule`
                        : `${a.movements} movement${a.movements === 1 ? "" : "s"}`}
                  </div>
                </div>
              ))}
            </div>
            <p className="fin-hint">
              These count only what is recorded in the ledger above. The fast phone version of
              «Record money» arrives in phase 3.
            </p>
          </section>

          {/* ── DISCREPANCIES ── */}
          {r.discrepancies.length > 0 && (
            <section className="fin-block">
              <h2 className="fin-h2">Orders where the courier and our books disagree</h2>
              <p className="fin-hint fin-hint-top">
                The courier&apos;s number is what the customer actually handed over. Every gap below is real money.
              </p>
              <table className="fin-tbl fin-tbl-tight">
                <thead>
                  <tr><th>Order</th><th>Customer</th><th className="fin-num">Our books</th>
                    <th className="fin-num">Courier collects</th><th className="fin-num">Gap</th></tr>
                </thead>
                <tbody>
                  {r.discrepancies.map((d) => (
                    <tr key={d.trackingCode}>
                      <td>#{d.orderNumber}</td>
                      <td className="fin-src">{d.customerName}</td>
                      <td className="fin-num">{fmt(d.ours)}</td>
                      <td className={"fin-num" + (d.theirs === 0 ? " fin-bad" : "")}>{fmt(d.theirs)}</td>
                      <td className={"fin-num " + (d.diff < 0 ? "fin-bad" : "fin-ok")}>{signed(d.diff)}</td>
                    </tr>
                  ))}
                  <tr className="fin-total">
                    <td colSpan={4}><b>Total gap</b></td>
                    <td className="fin-num fin-bad">
                      <b>{signed(r.discrepancies.reduce((s, d) => s + d.diff, 0))}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          )}

          {/* ── ASSUMPTIONS ── */}
          {r.assumptions.length > 0 && (
            <section className="fin-block">
              <div className="fin-assume">
                <div className="fin-lbl fin-lbl-amber">Still a guess</div>
                <p className="fin-hint fin-hint-top">
                  These two are not confirmed, so the profit above moves when they do. Everything else on
                  this page is a number you gave me or one the systems report.
                </p>
                <ul className="fin-assume-list">
                  {r.assumptions.map((a) => (
                    <li key={a.key}>
                      <b>{a.label} — {a.value}{a.unit && a.unit !== "date" ? ` ${a.unit}` : ""}</b>
                      <span>{(a.note || "").replace(/^ASSUMPTION — /, "")}</span>
                    </li>
                  ))}
                </ul>
                <button className="fin-btn" onClick={openRules}>Fix a number</button>
              </div>
            </section>
          )}

          <p className="fin-foot">
            Read-only, apart from the cost rules · revenue and the receivable come from Ecotrack&apos;s parcel
            data, last checked{" "}
            {r.freshness.parcelsSyncedAt
              ? new Date(r.freshness.parcelsSyncedAt).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })
              : "never"}
            {" "}· built {new Date(r.generatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      )}

      {quick && accounts.length > 0 && (
        <QuickEntry adminKey={adminKey} accounts={accounts} categories={categories}
          eurDzd={eurDzd} initialDirection={quick}
          onClose={() => setQuick(null)} onSaved={afterWrite} />
      )}

      {showHand && (
        <HandDeliveryModal adminKey={adminKey} candidates={candidates}
          onClose={() => setShowHand(false)} onSaved={afterWrite} />
      )}

      {showSettle && withDriver.length > 0 && (
        <SettleRunModal adminKey={adminKey} held={withDriver} defaultFee={defaultFee}
          onClose={() => setShowSettle(false)} onSaved={afterWrite} />
      )}

      {showPayout && (
        <PayoutModal adminKey={adminKey} unsettled={unsettled}
          onClose={() => setShowPayout(false)} onSaved={afterWrite} />
      )}

      {showMovement && accounts.length > 0 && (
        <MovementModal adminKey={adminKey} accounts={accounts} categories={categories}
          eurDzd={eurDzd} onClose={() => setShowMovement(false)} onSaved={afterWrite} />
      )}

      {/* ── COST RULES ── */}
      {showRules && (
        <div className="fin-modal-bg" onClick={() => setShowRules(false)}>
          <div className="fin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fin-modal-h">
              <h2>⚙ Cost rules</h2>
              <button className="fin-btn fin-ghost" onClick={() => setShowRules(false)}>✕</button>
            </div>
            <p className="fin-hint fin-hint-top">
              These live in the database, so this page, the Command Center and every device agree.
              Change one and the profit above updates straight away.
            </p>
            {rulesMsg && <div className="fin-msg">{rulesMsg}</div>}
            {!rules ? <p className="fin-hint">Loading…</p> : (
              <div className="fin-rules">
                {rules.map((s) => (
                  <div className="fin-rule" key={s.key}>
                    <div className="fin-rule-l">
                      <b>{s.label || s.key}</b>
                      {s.note && <span className={(s.note || "").includes("ASSUMPTION") ? "fin-rule-note fin-amber" : "fin-rule-note"}>{s.note}</span>}
                    </div>
                    <div className="fin-rule-r">
                      <input className="fin-input fin-input-sm" defaultValue={s.value}
                        onBlur={(e) => { if (e.target.value !== s.value) saveRule(s.key, e.target.value.trim()); }}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
                      <span className="fin-unit">{s.unit || ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// The stylesheet goes in through dangerouslySetInnerHTML, not as a child of
// <style>. React escapes text children, which turns every quote in here into
// &#x27; — that mangles the @import URL so the fonts never load, and makes the
// server and client markup differ, which throws a hydration error on top.
const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&family=Nunito:wght@400;600;700;800&display=swap');
    .fin{--cream:#f4ecd9;--surface:#fffdf8;--ink:#2a2419;--soft:#6b6350;--muted:#a99b76;--line:#ece2cb;
         --gold:#e0a91a;--goldsoft:#fff3d3;--goldline:#f0dcae;--green:#1f7a52;--greensoft:#e7f3ec;
         --coral:#c0392b;--coralsoft:#fce9e2;--coralline:#f6d2c7;--amber:#c98a1b;
         --disp:"Quicksand",system-ui,sans-serif;--body:"Nunito",system-ui,sans-serif;
         min-height:100vh;background:var(--cream);color:var(--ink);font-family:var(--body);
         background-image:radial-gradient(1000px 440px at 84% -10%,#fdf3da 0%,transparent 60%);}
    .fin *{box-sizing:border-box;}
    .fin-wrap{max-width:1060px;margin:0 auto;padding:20px 18px 60px;}

    .fin-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
             padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--line);}
    .fin-bar-l{display:flex;align-items:baseline;gap:10px;}
    .fin-brand{font-family:var(--disp);font-weight:700;letter-spacing:.24em;text-transform:uppercase;
               font-size:12px;color:var(--gold);}
    .fin-bar-sub{font-family:var(--disp);font-weight:700;font-size:17px;}
    .fin-bar-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}

    .fin-tabs{display:flex;background:var(--cream);border:1px solid var(--line);border-radius:9px;padding:2px;}
    .fin-tab{border:none;background:transparent;font-family:var(--body);font-weight:700;font-size:12.5px;
             color:var(--soft);padding:5px 11px;border-radius:7px;cursor:pointer;}
    .fin-tab.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(70,52,15,.1);}

    .fin-btn{font-family:var(--body);font-weight:700;font-size:13px;padding:7px 13px;border-radius:9px;
             border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer;}
    .fin-btn:hover{background:var(--cream);}
    .fin-ghost{background:transparent;}
    .fin-primary{background:var(--gold);border-color:var(--gold);color:#221c0a;}
    .fin-wfull{width:100%;margin-top:10px;}

    .fin-login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
    .fin-login-card{background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:32px;
                    max-width:360px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(70,52,15,.12);}
    .fin-logo{font-family:var(--disp);font-size:13px;letter-spacing:.3em;text-transform:uppercase;
              color:var(--gold);font-weight:700;}
    .fin-login-card h1{font-family:var(--disp);margin:8px 0 4px;font-size:25px;}
    .fin-err{color:var(--coral);font-size:13px;margin-top:8px;}

    .fin-input{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:9px;
               font-family:var(--body);font-size:14px;background:#fff;color:var(--ink);margin-top:12px;}
    .fin-input-sm{width:118px;margin-top:0;text-align:right;font-variant-numeric:tabular-nums;}

    .fin-loading{padding:60px;text-align:center;color:var(--soft);}
    .fin-alert{background:var(--coralsoft);border:1px solid var(--coralline);border-radius:12px;
               padding:13px 17px;margin-bottom:16px;font-size:14px;color:#7d2c20;}

    .fin-hero{display:grid;grid-template-columns:1.25fr 1fr;gap:16px;margin-bottom:22px;}
    @media(max-width:820px){.fin-hero{grid-template-columns:1fr;}}
    .fin-hero-main{background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:22px 24px;}
    .fin-hero-side{display:grid;gap:12px;}

    .fin-card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 17px;}
    .fin-card-gold{background:var(--goldsoft);border-color:var(--goldline);}

    .fin-lbl{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);}
    .fin-lbl-amber{color:var(--amber);}
    .fin-cur{font-weight:600;color:var(--muted);letter-spacing:0;}
    .fin-big{font-family:var(--disp);font-size:clamp(34px,6vw,52px);font-weight:700;line-height:1.05;
             margin-top:6px;font-variant-numeric:tabular-nums;}
    .fin-big small{font-size:.4em;font-weight:700;color:var(--muted);}
    .fin-mid{font-family:var(--disp);font-size:26px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums;}
    .fin-mid small{font-size:.5em;color:var(--muted);}
    .fin-ok{color:var(--green);} .fin-bad{color:var(--coral);} .fin-dim{color:var(--muted);}
    .fin-note{font-size:12.5px;color:var(--soft);margin-top:7px;line-height:1.45;}
    .fin-warn-line{font-size:12.5px;color:#7d2c20;margin-top:9px;padding-top:9px;
                   border-top:1px dashed var(--goldline);line-height:1.45;}

    .fin-block{background:var(--surface);border:1px solid var(--line);border-radius:16px;
               padding:18px 20px;margin-bottom:16px;}
    .fin-h2{font-family:var(--disp);font-size:17px;font-weight:700;margin:0 0 12px;}

    .fin-tbl{width:100%;border-collapse:collapse;font-size:14px;}
    .fin-tbl th{text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
                color:var(--muted);font-weight:700;padding:0 10px 7px 0;border-bottom:1px solid var(--line);}
    .fin-tbl td{padding:9px 10px 9px 0;border-bottom:1px solid var(--line);vertical-align:baseline;}
    .fin-tbl tr:last-child td{border-bottom:none;}
    .fin-tbl td:first-child{font-weight:700;white-space:nowrap;}
    .fin-src{color:var(--soft);font-size:12.5px;font-weight:400;}
    .fin-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:700;}
    .fin-tbl .fin-sub td{border-bottom:2px solid var(--ink);}
    .fin-tbl .fin-total td{border-top:2px solid var(--ink);border-bottom:none;padding-top:11px;font-size:15px;}
    .fin-tbl-tight td{padding:7px 10px 7px 0;}

    /* On a phone the "where this number came from" column squeezes the
       figures into a two-character ribbon. The numbers matter more; the
       explanations are there for the desk. The real phone screen is phase 3. */
    @media(max-width:640px){
      .fin-tbl .fin-src{display:none;}
      .fin-tbl td:first-child{white-space:normal;}
      .fin-block{padding:15px 14px;}
    }
    .fin-accounts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}
    @media(max-width:720px){.fin-accounts{grid-template-columns:1fr;}}
    .fin-acct-rows{margin-top:8px;display:grid;gap:4px;}
    .fin-acct-rows div{display:flex;justify-content:space-between;align-items:baseline;font-size:14px;}
    .fin-acct-rows span{color:var(--soft);font-size:12.5px;}
    .fin-acct-rows b{font-variant-numeric:tabular-nums;}

    .fin-hint{font-size:12.5px;color:var(--soft);margin:12px 0 0;line-height:1.5;}
    .fin-hint-top{margin:0 0 10px;}

    .fin-assume{background:var(--goldsoft);border:1px solid var(--goldline);border-radius:12px;padding:15px 17px;}
    .fin-assume-list{margin:0 0 12px;padding-left:18px;}
    .fin-assume-list li{font-size:13.5px;margin:7px 0;}
    .fin-assume-list b{display:block;}
    .fin-assume-list span{color:var(--soft);font-size:12.5px;}

    .fin-foot{text-align:center;font-size:12px;color:var(--muted);margin-top:20px;}
    .fin-tiny{font-size:11.5px;} .fin-muted{color:var(--soft);}

    .fin-flash{background:var(--greensoft);border:1px solid #cfe8da;border-radius:12px;
               padding:11px 16px;margin-bottom:14px;font-size:13.5px;color:var(--green);font-weight:700;}
    .fin-cardbtns{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
    .fin-blockhead{display:flex;align-items:center;justify-content:space-between;gap:12px;
                   flex-wrap:wrap;margin-bottom:6px;}
    .fin-blockhead .fin-h2{margin:0;}
    .fin-h3{font-family:var(--disp);font-size:14px;font-weight:700;margin:22px 0 8px;color:var(--soft);}
    .fin-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
    .fin-scroll table{min-width:520px;}
    .fin-chip{display:inline-block;margin-left:7px;padding:1px 7px;border-radius:20px;font-size:10.5px;
              font-weight:700;background:var(--coralsoft);color:#7d2c20;border:1px solid var(--coralline);}
    .fin-chip-quiet{background:var(--cream);color:var(--muted);border-color:var(--line);}
    .fin-mnote{display:block;font-style:normal;color:var(--muted);font-size:11.5px;margin-top:2px;}
    .fin-conv{display:block;font-style:normal;color:var(--muted);font-size:11px;font-weight:400;}
    .fin-x{border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;
           padding:2px 5px;border-radius:5px;}
    .fin-x:hover{background:var(--coralsoft);color:var(--coral);}
    .fin-alert-sm{padding:9px 13px;font-size:13px;margin:10px 0 0;}
    .fin-warnhint{color:#7d2c20;}
    .fin-sm{padding:4px 9px;font-size:12px;}

    .fin-modal-wide{max-width:820px;}
    .fin-modal-f{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;
                 padding-top:14px;border-top:1px solid var(--line);}
    .fin-form3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px;}
    .fin-form2{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px;}
    @media(max-width:620px){.fin-form3,.fin-form2{grid-template-columns:1fr;}}
    .fin-form3 label,.fin-form2 label,.fin-fullfield{display:flex;flex-direction:column;gap:3px;}
    .fin-fullfield{margin-top:10px;}
    .fin-form3 span,.fin-form2 span,.fin-fullfield span{font-size:11px;font-weight:700;
      letter-spacing:.06em;text-transform:uppercase;color:var(--muted);}
    .fin-form3 .fin-input,.fin-form2 .fin-input,.fin-fullfield .fin-input{margin-top:0;}

    .fin-seg{display:flex;gap:4px;background:var(--cream);border:1px solid var(--line);
             border-radius:10px;padding:3px;margin-top:12px;}
    .fin-segb{flex:1;border:none;background:transparent;font-family:var(--body);font-weight:700;
              font-size:12.5px;color:var(--soft);padding:7px 6px;border-radius:8px;cursor:pointer;}
    .fin-segb.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(70,52,15,.1);}

    .fin-check{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:14px;align-items:center;
               background:var(--cream);border:1px solid var(--line);border-radius:12px;
               padding:12px 15px;margin-top:14px;}
    @media(max-width:620px){.fin-check{grid-template-columns:1fr 1fr;}}
    .fin-check.ok{background:var(--greensoft);border-color:#cfe8da;}
    .fin-check.bad{background:var(--coralsoft);border-color:var(--coralline);}
    .fin-check b{display:block;font-family:var(--disp);font-size:17px;font-variant-numeric:tabular-nums;}
    .fin-check span{font-size:11px;color:var(--soft);}

    .fin-picker-h{display:flex;align-items:center;justify-content:space-between;gap:10px;
                  margin-top:16px;font-size:12px;color:var(--muted);font-weight:700;
                  text-transform:uppercase;letter-spacing:.06em;}
    .fin-picker-btns{display:flex;gap:6px;}
    .fin-picker{max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:10px;
                margin-top:7px;background:#fff;}
    .fin-prow{display:grid;grid-template-columns:auto 62px 1fr 52px auto 84px;gap:9px;align-items:center;
              padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px;cursor:pointer;}
    .fin-prow:last-child{border-bottom:none;}
    .fin-prow.on{background:var(--goldsoft);}
    .fin-prow-id{font-weight:700;font-variant-numeric:tabular-nums;}
    .fin-prow-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .fin-prow-who em{font-style:normal;color:var(--muted);font-size:11px;display:block;}
    .fin-prow-age{font-size:11.5px;color:var(--soft);text-align:right;}
    .fin-prow-age.old{color:var(--coral);font-weight:700;}
    .fin-prow-flag{font-size:10px;font-weight:700;color:#7d2c20;background:var(--coralsoft);
                   padding:1px 6px;border-radius:20px;}
    .fin-prow-net{text-align:right;font-weight:700;font-variant-numeric:tabular-nums;}
    @media(max-width:620px){
      .fin-prow{grid-template-columns:auto 1fr 74px;}
      .fin-prow-age,.fin-prow-flag{display:none;}
    }

    /* ── phone vs desk ──────────────────────────────────────
       Both trees render; CSS picks one. Switching in JavaScript would
       either flash the wrong layout or make the server and client disagree,
       and this page has already been bitten once by a hydration mismatch. */
    .fin-phone{display:none;}
    @media(max-width:760px){
      .fin-phone{display:block;padding:14px 14px 90px;}
      .fin-desk{display:none;}
      .fin-bar{padding:11px 14px;}
      .fin-bar .fin-tabs{order:3;}
    }

    .fin-pcard{background:var(--surface);border:1px solid var(--line);border-radius:16px;
               padding:16px 17px;margin-bottom:12px;}
    .fin-phero{background:var(--surface);}
    .fin-pbig{font-family:var(--disp);font-size:42px;font-weight:700;line-height:1.05;margin-top:5px;
              font-variant-numeric:tabular-nums;}
    .fin-pbig small{font-size:.36em;color:var(--muted);}
    .fin-pmid{font-family:var(--disp);font-size:27px;font-weight:700;margin-top:3px;
              font-variant-numeric:tabular-nums;}
    .fin-pmid small{font-size:.5em;color:var(--muted);}

    .fin-pactions{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;}
    .fin-pbtn{border:1px solid var(--line);border-radius:16px;padding:18px 10px;cursor:pointer;
              display:flex;flex-direction:column;align-items:center;gap:3px;font-family:var(--body);}
    .fin-pbtn b{font-size:21px;font-weight:800;}
    .fin-pbtn span{font-size:12px;color:var(--soft);}
    .fin-pbtn-out{background:var(--coralsoft);border-color:var(--coralline);color:#7d2c20;}
    .fin-pbtn-in{background:var(--greensoft);border-color:#cfe8da;color:var(--green);}
    .fin-pbtn:active{transform:scale(.98);}

    .fin-plist{margin-top:9px;}
    .fin-prow2{display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;
               padding:9px 0;border-bottom:1px solid var(--line);}
    .fin-prow2:last-child{border-bottom:none;}
    .fin-prow2-l b{font-size:14px;display:block;}
    .fin-prow2-l span{font-size:11.5px;color:var(--muted);display:block;margin-top:1px;
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px;}
    .fin-prow2-r{font-weight:700;font-variant-numeric:tabular-nums;font-size:14px;}
    .fin-x:disabled{opacity:.25;cursor:not-allowed;}
    .fin-flashwrap{padding-bottom:0;}

    /* ── the quick-entry sheet ── */
    .fin-sheet-bg{position:fixed;inset:0;background:rgba(42,36,25,.5);z-index:60;
                  display:flex;align-items:flex-end;justify-content:center;}
    .fin-sheet{background:var(--surface);width:100%;max-width:520px;max-height:94vh;
               border-radius:22px 22px 0 0;display:flex;flex-direction:column;
               box-shadow:0 -10px 40px rgba(50,36,10,.28);}
    @media(min-width:761px){
      .fin-sheet-bg{align-items:center;}
      .fin-sheet{border-radius:20px;max-height:88vh;}
    }
    .fin-sheet-h{display:flex;align-items:center;gap:10px;padding:14px 16px 10px;
                 border-bottom:1px solid var(--line);}
    .fin-sheet-h .fin-seg{flex:1;margin-top:0;}
    .fin-seg-sm .fin-segb{font-size:15px;padding:9px 6px;font-weight:800;}
    .fin-sheet-body{padding:14px 16px;overflow:auto;flex:1;}
    .fin-sheet-f{padding:12px 16px 16px;border-top:1px solid var(--line);}
    .fin-bigbtn{width:100%;padding:15px;font-size:16px;border-radius:14px;}

    .fin-chips{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
    .fin-chipbtn{border:1px solid var(--line);background:var(--cream2,#fbf7ec);border-radius:13px;
                 padding:11px 10px;cursor:pointer;text-align:left;font-family:var(--body);}
    .fin-chipbtn b{display:block;font-size:14.5px;font-weight:800;}
    .fin-chipbtn span{display:block;font-size:11px;color:var(--muted);margin-top:1px;}
    .fin-chipbtn.on{background:var(--gold);border-color:var(--gold);color:#221c0a;}
    .fin-chipbtn.on span{color:#6b530f;}
    .fin-chipbtn-more{text-align:center;} .fin-chipbtn-more b{font-size:18px;}

    .fin-amount{display:flex;align-items:baseline;gap:8px;margin-top:16px;
                border-bottom:2px solid var(--ink);padding-bottom:6px;}
    .fin-amount input{flex:1;border:none;background:transparent;outline:none;width:100%;
                      font-family:var(--disp);font-size:40px;font-weight:700;color:var(--ink);
                      font-variant-numeric:tabular-nums;padding:0;}
    .fin-amount span{font-family:var(--disp);font-size:17px;font-weight:700;color:var(--muted);}

    .fin-accchips{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap;}
    .fin-accchip{border:1px solid var(--line);background:transparent;border-radius:20px;
                 padding:7px 14px;font-size:13px;font-weight:700;cursor:pointer;
                 font-family:var(--body);color:var(--soft);}
    .fin-accchip.on{background:var(--ink);border-color:var(--ink);color:var(--surface);}

    .fin-sheet-field{display:flex;flex-direction:column;gap:3px;margin-top:13px;}
    .fin-sheet-field span{font-size:11px;font-weight:700;letter-spacing:.06em;
                          text-transform:uppercase;color:var(--muted);}
    .fin-sheet-field .fin-input{margin-top:0;}
    .fin-sheet-hint{font-size:12px;color:var(--soft);margin:9px 0 0;line-height:1.45;}
    .fin-linkbtn{border:none;background:transparent;color:var(--amber);font-weight:700;
                 font-size:12.5px;cursor:pointer;padding:11px 0 0;font-family:var(--body);}

    .fin-hdrow{display:grid;grid-template-columns:auto 1fr 86px 74px 92px;gap:9px;align-items:center;
               padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;}
    .fin-hdrow:last-child{border-bottom:none;}
    .fin-hdrow.on{background:var(--goldsoft);}
    .fin-hdrow-pick{display:flex;align-items:center;gap:7px;cursor:pointer;}
    .fin-hdrow-status{font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
    .fin-hdrow-fee{display:flex;flex-direction:column;align-items:flex-end;gap:1px;}
    .fin-hdrow-fee em{font-style:normal;font-size:9.5px;color:var(--muted);}
    .fin-input-xs{width:86px;margin-top:0;text-align:right;font-variant-numeric:tabular-nums;
                  padding:5px 8px;font-size:13px;}
    .fin-input-xs:disabled{background:var(--cream);color:var(--muted);}
    @media(max-width:620px){
      .fin-hdrow{grid-template-columns:auto 1fr 92px;}
      .fin-hdrow-status,.fin-prow-net{display:none;}
    }

    .fin-openrun{background:var(--goldsoft);border:1px solid var(--goldline);border-radius:12px;
                 padding:13px 16px;margin:4px 0 14px;}
    .fin-openrun-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
    .fin-openrun-h b{font-size:14.5px;}
    .fin-openrun-h span{font-size:12.5px;color:var(--soft);}
    .fin-openrun-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;}
    .fin-runchip{background:var(--surface);border:1px solid var(--goldline);border-radius:20px;
                 padding:3px 10px;font-size:11.5px;font-weight:700;}
    .fin-runchip em{font-style:normal;font-weight:400;color:var(--soft);}
    .fin-runchip b{color:var(--coral);}
    .fin-eco{color:var(--amber);font-weight:700;}
    .fin-nofee{color:var(--muted);}

    .fin-setrow{display:grid;grid-template-columns:56px 1fr 66px auto 92px;gap:9px;align-items:center;
                padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;}
    .fin-setrow:last-child{border-bottom:none;}
    .fin-setrow.on{background:var(--goldsoft);}
    .fin-outs{display:flex;gap:4px;}
    .fin-out{border:1px solid var(--line);background:var(--surface);border-radius:8px;
             padding:5px 9px;font-size:11.5px;font-weight:700;cursor:pointer;
             font-family:var(--body);color:var(--soft);white-space:nowrap;}
    .fin-out.ok.on{background:var(--greensoft);border-color:var(--green);color:var(--green);}
    .fin-out.warn.on{background:var(--goldsoft);border-color:var(--amber);color:var(--amber);}
    .fin-out.bad.on{background:var(--coralsoft);border-color:var(--coral);color:var(--coral);}
    @media(max-width:720px){
      .fin-setrow{grid-template-columns:1fr;gap:6px;}
      .fin-outs{flex-wrap:wrap;}
    }

    .fin-modal-bg{position:fixed;inset:0;background:rgba(42,36,25,.42);display:flex;align-items:center;
                  justify-content:center;padding:18px;z-index:50;}
    .fin-modal{background:var(--surface);border-radius:18px;padding:22px;max-width:620px;width:100%;
               max-height:88vh;overflow:auto;box-shadow:0 24px 60px rgba(50,36,10,.3);}
    .fin-modal-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;}
    .fin-modal-h h2{font-family:var(--disp);font-size:19px;margin:0;}
    .fin-msg{background:var(--greensoft);border:1px solid #cfe8da;border-radius:9px;padding:8px 12px;
             font-size:13px;color:var(--green);margin-bottom:10px;}
    .fin-rules{display:grid;gap:2px;margin-top:8px;}
    .fin-rule{display:flex;align-items:center;justify-content:space-between;gap:14px;
              padding:11px 0;border-bottom:1px solid var(--line);}
    .fin-rule:last-child{border-bottom:none;}
    .fin-rule-l b{font-size:13.5px;display:block;}
    .fin-rule-note{font-size:11.5px;color:var(--muted);display:block;margin-top:2px;max-width:380px;line-height:1.4;}
    .fin-amber{color:var(--amber);font-weight:700;}
    .fin-rule-r{display:flex;align-items:center;gap:8px;flex-shrink:0;}
    .fin-unit{font-size:11px;color:var(--muted);min-width:74px;}
`;

function Style() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />;
}
