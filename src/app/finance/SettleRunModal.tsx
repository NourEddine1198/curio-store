"use client";

import { useState } from "react";

// Evening two: he comes back with the money and the report.
//
// One row per box he is holding, three answers each. The totals at the top
// are what the conversation is actually about — what he owes you, what you
// owe him, and the difference that changes hands.

export interface HeldOrder {
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  wilayaName: string;
  where: string;
  what: string;
  total: number;
  handedToDriverAt: string;
  driverAttempts: number;
}

type Outcome = "delivered" | "retry" | "refused";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const todayInAlgiers = () => new Date(Date.now() + 60 * 60000).toISOString().slice(0, 10);

export default function SettleRunModal({
  adminKey, held, defaultFee, onClose, onSaved,
}: {
  adminKey: string;
  held: HeldOrder[];
  defaultFee: number;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [on, setOn] = useState(todayInAlgiers());
  // Nothing is assumed. A box with no answer is simply left out of the
  // settle, which is safer than defaulting it to "delivered" and quietly
  // booking revenue for a sale that never happened.
  const [outcome, setOutcome] = useState<Map<number, Outcome>>(new Map());
  const [fees, setFees] = useState<Map<number, number>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feeOf = (n: number) => fees.get(n) ?? defaultFee;
  const answered = held.filter((o) => outcome.has(o.orderNumber));
  const delivered = held.filter((o) => outcome.get(o.orderNumber) === "delivered");
  const cashIn = delivered.reduce((s, o) => s + o.total, 0);
  const feeTotal = delivered.reduce((s, o) => s + feeOf(o.orderNumber), 0);

  function set(n: number, v: Outcome) {
    setOutcome((prev) => {
      const next = new Map(prev);
      if (next.get(n) === v) next.delete(n); else next.set(n, v);
      return next;
    });
  }
  function setFee(n: number, v: string) {
    const f = Number(v.replace(/[^\d]/g, ""));
    setFees((prev) => new Map(prev).set(n, Number.isFinite(f) ? f : 0));
  }

  async function save() {
    setError(null);
    if (answered.length === 0) return setError("Say what happened to at least one box");
    setSaving(true);
    try {
      const res = await fetch("/api/finance/hand-delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey },
        body: JSON.stringify({
          action: "settle", on,
          outcomes: answered.map((o) => ({
            orderNumber: o.orderNumber,
            outcome: outcome.get(o.orderNumber),
            fee: feeOf(o.orderNumber),
          })),
        }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.error || "Couldn't save it"); return; }
      onSaved(
        `${d.delivered} delivered — ${fmt(d.cashIn)} DA in, ${fmt(d.feeTotal)} DA to him, ${fmt(d.net)} DA net` +
        (d.keptForTomorrow ? ` · ${d.keptForTomorrow} he keeps for tomorrow` : "") +
        (d.returned ? ` · ${d.returned} came back` : "")
      );
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setSaving(false);
    }
  }

  const btn = (o: HeldOrder, v: Outcome, label: string, cls: string) => (
    <button className={"fin-out " + cls + (outcome.get(o.orderNumber) === v ? " on" : "")}
      onClick={() => set(o.orderNumber, v)}>{label}</button>
  );

  return (
    <div className="fin-modal-bg" onClick={onClose}>
      <div className="fin-modal fin-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="fin-modal-h">
          <h2>He is back — what happened?</h2>
          <button className="fin-btn fin-ghost" onClick={onClose}>✕</button>
        </div>
        <p className="fin-hint fin-hint-top">
          One answer per box. <b>Nobody home</b> means he keeps it and tries again tomorrow, so it
          stays with him. <b>Refused</b> brings it back to your shelf and it stops counting as a
          sale. He is paid only for the ones that arrived.
        </p>

        <div className="fin-form3">
          <label>
            <span>Settled on</span>
            <input className="fin-input" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          </label>
        </div>

        <div className={"fin-check " + (delivered.length > 0 ? "ok" : "")}>
          <div><b>{fmt(cashIn)} DA</b><span>he hands you</span></div>
          <div><b>{fmt(feeTotal)} DA</b><span>you pay him</span></div>
          <div><b>{fmt(cashIn - feeTotal)} DA</b><span>net into the drawer</span></div>
          <span className="fin-hint" style={{ margin: 0 }}>
            {answered.length} of {held.length} answered
          </span>
        </div>

        <div className="fin-picker-h">
          <span>{held.length} box{held.length === 1 ? "" : "es"} with him</span>
          <span className="fin-picker-btns">
            <button className="fin-btn fin-sm"
              onClick={() => setOutcome(new Map(held.map((o) => [o.orderNumber, "delivered" as Outcome])))}>
              All delivered
            </button>
          </span>
        </div>

        <div className="fin-picker">
          {held.map((o) => {
            const v = outcome.get(o.orderNumber);
            return (
              <div key={o.orderNumber} className={"fin-setrow" + (v ? " on" : "")}>
                <span className="fin-prow-id">#{o.orderNumber}</span>
                <span className="fin-prow-who">
                  {o.customerName}
                  <em>
                    {o.where} · {o.what}
                    {o.driverAttempts > 0 && ` · tried ${o.driverAttempts}×`}
                  </em>
                </span>
                <span className="fin-prow-net">{fmt(o.total)}</span>
                <span className="fin-outs">
                  {btn(o, "delivered", "Delivered", "ok")}
                  {btn(o, "retry", "Nobody home", "warn")}
                  {btn(o, "refused", "Refused", "bad")}
                </span>
                <span className="fin-hdrow-fee">
                  {v === "delivered" ? (
                    <>
                      <input className="fin-input fin-input-xs" inputMode="numeric"
                        value={String(feeOf(o.orderNumber))}
                        onChange={(e) => setFee(o.orderNumber, e.target.value)} />
                      <em>his fee</em>
                    </>
                  ) : <em className="fin-nofee">{v ? "no fee" : ""}</em>}
                </span>
              </div>
            );
          })}
        </div>

        {error && <div className="fin-alert fin-alert-sm">{error}</div>}

        <div className="fin-modal-f">
          <button className="fin-btn fin-ghost" onClick={onClose}>Cancel</button>
          <button className="fin-btn fin-primary" onClick={save} disabled={saving || answered.length === 0}>
            {saving ? "Saving…" : `Settle ${answered.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
