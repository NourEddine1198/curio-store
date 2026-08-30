"use client";

import { useMemo, useState } from "react";

// Evening one: picking the boxes our driver is taking with him.
//
// Only Algiers doorsteps appear — a stop-desk order is collected from an
// Ecotrack counter, so there is nowhere for him to take it.
//
// Most of these ALREADY have an Ecotrack parcel, because orders auto-ship the
// moment they are confirmed. Handing one over cancels that parcel, so the
// courier never turns up for a box that is on our driver's back seat.

export interface Candidate {
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  status: string;
  wilayaName: string;
  where: string;
  what: string;
  total: number;
  createdAt: string;
  atEcotrack: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const todayInAlgiers = () => new Date(Date.now() + 60 * 60000).toISOString().slice(0, 10);

export default function HandDeliveryModal({
  adminKey, candidates, onClose, onSaved,
}: {
  adminKey: string;
  candidates: Candidate[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [handedOn, setHandedOn] = useState(todayInAlgiers());
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) =>
      String(c.orderNumber).includes(q) ||
      c.customerName.toLowerCase().includes(q) ||
      (c.where || "").toLowerCase().includes(q) ||
      c.customerPhone.includes(q));
  }, [candidates, search]);

  const cashTotal = candidates
    .filter((c) => picked.has(c.orderNumber))
    .reduce((s, c) => s + c.total, 0);
  const atEcotrack = candidates.filter((c) => picked.has(c.orderNumber) && c.atEcotrack).length;

  function toggle(n: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  }

  async function save() {
    setError(null);
    if (picked.size === 0) return setError("Tick the boxes he is taking");
    setSaving(true);
    try {
      const res = await fetch("/api/finance/hand-delivery", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey },
        body: JSON.stringify({ action: "handover", on: handedOn, orderNumbers: Array.from(picked) }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d?.error || "Couldn't save it"); return; }
      const skipped = (d.skipped || []).length;
      onSaved(
        `${d.taken} box${d.taken === 1 ? "" : "es"} went with him — ${fmt(d.value)} DA to collect` +
        (d.cancelledAtEcotrack ? ` · ${d.cancelledAtEcotrack} parcel${d.cancelledAtEcotrack === 1 ? "" : "s"} cancelled at Ecotrack` : "") +
        (skipped ? ` · ${skipped} skipped (${d.skipped.map((x: { orderNumber: number; why: string }) => `#${x.orderNumber} ${x.why}`).join(", ")})` : "")
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
          <h2>Give boxes to the driver</h2>
          <button className="fin-btn fin-ghost" onClick={onClose}>✕</button>
        </div>
        <p className="fin-hint fin-hint-top">
          Do this when he arrives in the evening. Only <b>Algiers doorstep</b> orders are listed.
          Anything marked <b>at Ecotrack</b> has a parcel waiting — handing it over will
          <b> cancel that parcel</b> so the courier does not come for it too. You record what
          actually happened tomorrow evening, when he brings the money back.
        </p>

        <div className="fin-form3">
          <label>
            <span>Handed over on</span>
            <input className="fin-input" type="date" value={handedOn}
              onChange={(e) => setHandedOn(e.target.value)} />
          </label>
          <label style={{ gridColumn: "span 2" }}>
            <span>Find an order</span>
            <input className="fin-input" value={search} placeholder="order number, name, commune or phone"
              onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>

        <div className={"fin-check " + (picked.size > 0 ? "ok" : "")}>
          <div><b>{picked.size}</b><span>boxes he takes</span></div>
          <div><b>{fmt(cashTotal)} DA</b><span>for him to collect</span></div>
          <div><b>{atEcotrack}</b><span>parcels to cancel</span></div>
          <button className="fin-btn" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
            Clear
          </button>
        </div>

        <div className="fin-picker-h">
          <span>{shown.length} order{shown.length === 1 ? "" : "s"} he could take</span>
          <span className="fin-picker-btns">
            <button className="fin-btn fin-sm"
              onClick={() => setPicked(new Set(shown.map((c) => c.orderNumber)))}>
              All shown
            </button>
          </span>
        </div>

        <div className="fin-picker">
          {shown.length === 0 && (
            <p className="fin-hint" style={{ padding: "14px" }}>
              No Algiers doorstep orders are waiting. Anything the courier has already collected
              is deliberately not listed — that box is on a van, not on your shelf.
            </p>
          )}
          {shown.map((c) => {
            const on = picked.has(c.orderNumber);
            return (
              <div key={c.orderNumber} className={"fin-hdrow" + (on ? " on" : "")}>
                <label className="fin-hdrow-pick">
                  <input type="checkbox" checked={on} onChange={() => toggle(c.orderNumber)} />
                  <span className="fin-prow-id">#{c.orderNumber}</span>
                </label>
                <span className="fin-prow-who">
                  {c.customerName}
                  <em>{c.where} · {c.what}</em>
                </span>
                <span className="fin-hdrow-status">{c.status.toLowerCase()}</span>
                <span className="fin-prow-net">{fmt(c.total)}</span>
                <span className="fin-hdrow-fee">
                  {c.atEcotrack
                    ? <em className="fin-eco">at Ecotrack</em>
                    : <em>on the shelf</em>}
                </span>
              </div>
            );
          })}
        </div>

        {error && <div className="fin-alert fin-alert-sm">{error}</div>}

        <div className="fin-modal-f">
          <button className="fin-btn fin-ghost" onClick={onClose}>Cancel</button>
          <button className="fin-btn fin-primary" onClick={save} disabled={saving || picked.size === 0}>
            {saving ? "Saving…" : `He takes ${picked.size} ${picked.size === 1 ? "box" : "boxes"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
