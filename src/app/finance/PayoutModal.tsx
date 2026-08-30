"use client";

import { useMemo, useState } from "react";

// Recording one «Décharge de paiement expéditeur».
//
// You type three things off the slip. The system already knows what every
// delivered parcel collected and what the courier charged for it, so it can
// work out what the slip SHOULD say and tell you when it doesn't — the check
// nobody has ever run on Curio's courier payments.

export interface UnsettledParcel {
  trackingCode: string;
  orderNumber: number | null;
  customerName: string;
  wilaya: string;
  montant: number;
  fee: number;
  net: number;
  deliveredAt: string | null;
  daysHeld: number | null;
  status: string;
  collected: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number) => (n < 0 ? "−" : "+") + fmt(Math.abs(n));

function todayInAlgiers(): string {
  // Algiers is UTC+1 all year.
  return new Date(Date.now() + 60 * 60000).toISOString().slice(0, 10);
}

export default function PayoutModal({
  adminKey, unsettled, onClose, onSaved,
}: {
  adminKey: string;
  unsettled: UnsettledParcel[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [reference, setReference] = useState("");
  const [collectedAt, setCollectedAt] = useState(todayInAlgiers());
  const [slipTotal, setSlipTotal] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Everything is ticked to begin with: the common case is a slip that
  // clears the whole outstanding pile.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(unsettled.map((p) => p.trackingCode))
  );

  const selectedTotal = useMemo(
    () => unsettled.reduce((s, p) => (selected.has(p.trackingCode) ? s + p.net : s), 0),
    [unsettled, selected]
  );
  const slip = Number(slipTotal);
  const hasSlip = slipTotal.trim() !== "" && Number.isFinite(slip);
  const difference = hasSlip ? slip - selectedTotal : 0;
  const matches = hasSlip && difference === 0;

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }

  /**
   * Tick the oldest parcels until they add up to the slip. A payout almost
   * always clears the oldest money first, so this gets the selection right
   * in one click on the common "they paid part of it" case.
   */
  function matchToSlip() {
    if (!hasSlip) return;
    const next = new Set<string>();
    let running = 0;
    for (const p of unsettled) {            // already oldest-first from the API
      if (running + p.net > slip) continue;
      next.add(p.trackingCode);
      running += p.net;
    }
    setSelected(next);
  }

  async function save() {
    setError(null);
    if (!reference.trim()) return setError("Type the reference from the slip, e.g. #311959");
    if (!hasSlip) return setError("Type the total from the slip");
    if (selected.size === 0) return setError("Tick the parcels this payout covers");

    setSaving(true);
    try {
      const res = await fetch("/api/finance/payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey },
        body: JSON.stringify({
          reference: reference.trim(),
          collectedAt,
          slipTotal: Math.round(slip),
          trackingCodes: Array.from(selected),
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || "Couldn't save it"); return; }
      onSaved(
        `Slip ${reference.trim()} recorded — ${fmt(slip)} DA in, ${selected.size} parcels settled.`
      );
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fin-modal-bg" onClick={onClose}>
      <div className="fin-modal fin-modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="fin-modal-h">
          <h2>Record a courier payout</h2>
          <button className="fin-btn fin-ghost" onClick={onClose}>✕</button>
        </div>
        <p className="fin-hint fin-hint-top">
          Copy three things off the slip. Everything below is already known — tick what this
          payment covered.
        </p>

        <div className="fin-form3">
          <label>
            <span>Slip reference</span>
            <input className="fin-input" value={reference} placeholder="#311959"
              onChange={(e) => setReference(e.target.value)} autoFocus />
          </label>
          <label>
            <span>Date collected</span>
            <input className="fin-input" type="date" value={collectedAt}
              onChange={(e) => setCollectedAt(e.target.value)} />
          </label>
          <label>
            <span>Total on the slip (DA)</span>
            <input className="fin-input" inputMode="numeric" value={slipTotal} placeholder="851650"
              onChange={(e) => setSlipTotal(e.target.value.replace(/[^\d]/g, ""))} />
          </label>
        </div>

        <div className={"fin-check " + (matches ? "ok" : hasSlip ? "bad" : "")}>
          <div>
            <b>{fmt(selectedTotal)} DA</b>
            <span>we calculate, from {selected.size} parcels</span>
          </div>
          <div>
            <b>{hasSlip ? fmt(slip) + " DA" : "—"}</b>
            <span>your slip says</span>
          </div>
          <div>
            <b>{hasSlip ? signed(difference) : "—"}</b>
            <span>{matches ? "they match" : hasSlip ? "difference" : "type the slip total"}</span>
          </div>
          <button className="fin-btn" disabled={!hasSlip} onClick={matchToSlip}>
            Match my slip
          </button>
        </div>

        {hasSlip && !matches && (
          <p className="fin-hint fin-hint-top fin-warnhint">
            {difference < 0
              ? "The slip is short of what these parcels should have paid. Either it covers fewer parcels — press “Match my slip” — or the courier has underpaid, which is worth asking about before you save."
              : "The slip is more than these parcels add up to. Tick more parcels, or it may include something from before the books opened."}
          </p>
        )}

        <div className="fin-picker-h">
          <span>{unsettled.length} parcels waiting to be settled</span>
          <span className="fin-picker-btns">
            <button className="fin-btn fin-sm" onClick={() => setSelected(new Set(unsettled.map((p) => p.trackingCode)))}>All</button>
            <button className="fin-btn fin-sm" onClick={() => setSelected(new Set())}>None</button>
          </span>
        </div>

        <div className="fin-picker">
          {unsettled.map((p) => {
            const on = selected.has(p.trackingCode);
            return (
              <label key={p.trackingCode} className={"fin-prow" + (on ? " on" : "")}>
                <input type="checkbox" checked={on} onChange={() => toggle(p.trackingCode)} />
                <span className="fin-prow-id">
                  {p.orderNumber ? "#" + p.orderNumber : p.trackingCode.slice(-6)}
                </span>
                <span className="fin-prow-who">
                  {p.customerName}
                  <em>{p.wilaya}</em>
                </span>
                <span className={"fin-prow-age" + ((p.daysHeld ?? 0) >= 14 ? " old" : "")}>
                  {p.daysHeld == null ? "—" : p.daysHeld === 0 ? "today" : `${p.daysHeld}d`}
                </span>
                {!p.collected && <span className="fin-prow-flag">not collected</span>}
                <span className="fin-prow-net">{fmt(p.net)}</span>
              </label>
            );
          })}
        </div>

        <label className="fin-fullfield">
          <span>Note (optional)</span>
          <input className="fin-input" value={note} placeholder="anything odd about this one"
            onChange={(e) => setNote(e.target.value)} />
        </label>

        {error && <div className="fin-alert fin-alert-sm">{error}</div>}

        <div className="fin-modal-f">
          <button className="fin-btn fin-ghost" onClick={onClose}>Cancel</button>
          <button className="fin-btn fin-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : `Record ${hasSlip ? fmt(slip) + " DA" : "payout"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
