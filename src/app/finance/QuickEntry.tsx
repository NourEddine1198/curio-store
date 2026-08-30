"use client";

import { useMemo, useState } from "react";
import type { AccountOpt, CategoryOpt } from "./MovementModal";

// The phone sheet. One screen, no scrolling for the common case:
// tap what it was for, type the number, tap save.
//
// It exists because the cost of logging a 400 DA roll of scotch has to be
// lower than the cost of forgetting it. Anything that takes more than a few
// seconds standing in a shop simply does not get recorded, and then the
// profit is wrong in a way nobody can see.

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const todayInAlgiers = () => new Date(Date.now() + 60 * 60000).toISOString().slice(0, 10);

export default function QuickEntry({
  adminKey, accounts, categories, eurDzd, initialDirection = "out", onClose, onSaved,
}: {
  adminKey: string;
  accounts: AccountOpt[];
  categories: CategoryOpt[];
  eurDzd: number;
  initialDirection?: "out" | "in";
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [direction, setDirection] = useState<"out" | "in">(initialDirection);
  const [categoryKey, setCategoryKey] = useState("");
  const [accountKey, setAccountKey] = useState("cash");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [occurredAt, setOccurredAt] = useState(todayInAlgiers());
  const [showDate, setShowDate] = useState(false);
  // When cash comes in from a hand delivery, the driver's cut is a second
  // movement. Asking for it here means it gets recorded — asking later means
  // it doesn't.
  const [driverFee, setDriverFee] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = useMemo(() => {
    const kind = direction === "in" ? "income" : "expense";
    const mine = categories.filter((c) => c.kind === kind);
    // Money OUT is split: the costs a human has to type come first, and the
    // ones the profit works out for itself sit behind "more", so the common
    // case is a single tap.
    //
    // Money IN is never split. EVERY income category is `auto` — revenue is
    // read from the parcels, so cash arriving is a ledger fact rather than a
    // second sale — and splitting on that flag left the whole «دخلت» screen
    // with nothing to tap but "more".
    // «توصيل باليد» and «خلاص الليفرور» are hidden here on purpose. Recording
    // a hand delivery as a plain movement moves the drawer but NOT the
    // profit — the sale and the driver's fee only reach the profit through
    // the handover/settle flow, which also moves stock and closes the order.
    // Leaving the chips here made it possible to log a delivery that the
    // profit never saw.
    const HANDLED_ELSEWHERE = ["hand_delivery", "delivery_guy"];
    const usable = mine.filter((c) => !HANDLED_ELSEWHERE.includes(c.key));
    if (kind === "income") return { main: usable, rest: [] as CategoryOpt[] };
    return { main: usable.filter((c) => !c.auto), rest: usable.filter((c) => c.auto) };
  }, [categories, direction]);

  const [showRest, setShowRest] = useState(false);
  const account = accounts.find((a) => a.key === accountKey);
  const isEur = account?.currency === "EUR";
  const parsed = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  // Kept false: hand deliveries are recorded through the settle flow, which
  // is the only path that also books the revenue, the stock and the fee.
  const isHandDelivery = false;
  const fee = Number(driverFee);
  const feeValid = driverFee.trim() !== "" && Number.isFinite(fee) && fee > 0;

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/finance/movements", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "Couldn't save it");
    return data;
  }

  async function save() {
    setError(null);
    if (!categoryKey) return setError("Tap what it was for");
    if (!valid) return setError("Type an amount");

    setSaving(true);
    try {
      await post({
        direction, accountKey, categoryKey, occurredAt,
        amount: isEur ? Math.round(parsed * 100) : Math.round(parsed),
        note: note.trim() || undefined,
      });

      let extra = "";
      if (isHandDelivery && feeValid) {
        // Second call on purpose: if it fails, the money you actually
        // received is already safely recorded and only the fee is missing.
        try {
          await post({
            direction: "out", accountKey, categoryKey: "delivery_guy", occurredAt,
            amount: Math.round(fee), note: note.trim() || "delivery fee",
          });
          extra = ` · ${fmt(fee)} DA to the driver`;
        } catch {
          extra = " · the driver's fee didn't save — add it separately";
        }
      }

      onSaved(
        `${direction === "in" ? "+" : "−"}${isEur ? "€" + parsed.toFixed(2) : fmt(parsed) + " DA"} recorded${extra}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save it");
    } finally {
      setSaving(false);
    }
  }

  const chip = (c: CategoryOpt) => (
    <button key={c.key}
      className={"fin-chipbtn" + (categoryKey === c.key ? " on" : "")}
      onClick={() => setCategoryKey(c.key)}>
      <b>{c.labelAr || c.label}</b>
      <span>{c.label}</span>
    </button>
  );

  return (
    <div className="fin-sheet-bg" onClick={onClose}>
      <div className="fin-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="fin-sheet-h">
          <div className="fin-seg fin-seg-sm">
            <button className={"fin-segb" + (direction === "out" ? " on" : "")}
              onClick={() => { setDirection("out"); setCategoryKey(""); }}>صرفت</button>
            <button className={"fin-segb" + (direction === "in" ? " on" : "")}
              onClick={() => { setDirection("in"); setCategoryKey(""); }}>دخلت</button>
          </div>
          <button className="fin-btn fin-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="fin-sheet-body">
          <div className="fin-chips">
            {options.main.map(chip)}
            {!showRest && options.rest.length > 0 && (
              <button className="fin-chipbtn fin-chipbtn-more" onClick={() => setShowRest(true)}>
                <b>+</b><span>more</span>
              </button>
            )}
            {showRest && options.rest.map(chip)}
          </div>
          {showRest && direction === "out" && (
            <p className="fin-sheet-hint">
              The ones below the line are worked out from your orders already — recording
              one here moves the account but won&apos;t change the profit.
            </p>
          )}

          <div className="fin-amount">
            <input inputMode="decimal" value={amount} placeholder="0"
              onChange={(e) => setAmount(e.target.value.replace(isEur ? /[^\d.]/g : /[^\d]/g, ""))}
              autoFocus />
            <span>{isEur ? "€" : "DA"}</span>
          </div>
          {isEur && valid && (
            <p className="fin-sheet-hint">= {fmt(parsed * eurDzd)} DA at {eurDzd} DA/€</p>
          )}

          <div className="fin-accchips">
            {accounts.map((a) => (
              <button key={a.key}
                className={"fin-accchip" + (accountKey === a.key ? " on" : "")}
                onClick={() => setAccountKey(a.key)}>{a.name}</button>
            ))}
          </div>

          {isHandDelivery && (
            <label className="fin-sheet-field">
              <span>And the delivery guy took (DA)</span>
              <input className="fin-input" inputMode="numeric" value={driverFee} placeholder="optional"
                onChange={(e) => setDriverFee(e.target.value.replace(/[^\d]/g, ""))} />
            </label>
          )}

          <label className="fin-sheet-field">
            <span>Note</span>
            <input className="fin-input" value={note} placeholder="optional — what exactly"
              onChange={(e) => setNote(e.target.value)} />
          </label>

          {showDate ? (
            <label className="fin-sheet-field">
              <span>When</span>
              <input className="fin-input" type="date" value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)} />
            </label>
          ) : (
            <button className="fin-linkbtn" onClick={() => setShowDate(true)}>
              Today — tap to change the date
            </button>
          )}

          {error && <div className="fin-alert fin-alert-sm">{error}</div>}
        </div>

        <div className="fin-sheet-f">
          <button className="fin-btn fin-primary fin-bigbtn" onClick={save} disabled={saving}>
            {saving ? "Saving…" : valid ? `Save ${isEur ? "€" + parsed.toFixed(2) : fmt(parsed) + " DA"}` : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
