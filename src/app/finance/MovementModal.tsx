"use client";

import { useMemo, useState } from "react";

// Recording one movement of money by hand — the things no system can know:
// a bag of scotch, a video you paid for, cash from a hand delivery.

export interface AccountOpt { key: string; name: string; currency: string }
export interface CategoryOpt { key: string; label: string; labelAr: string | null; kind: string; auto: boolean }

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function todayInAlgiers(): string {
  return new Date(Date.now() + 60 * 60000).toISOString().slice(0, 10);
}

export default function MovementModal({
  adminKey, accounts, categories, eurDzd, onClose, onSaved,
}: {
  adminKey: string;
  accounts: AccountOpt[];
  categories: CategoryOpt[];
  eurDzd: number;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [direction, setDirection] = useState<"out" | "in" | "transfer">("out");
  const [accountKey, setAccountKey] = useState(accounts[0]?.key || "cash");
  const [toAccountKey, setToAccountKey] = useState(accounts[1]?.key || "baridimob");
  const [categoryKey, setCategoryKey] = useState("");
  const [occurredAt, setOccurredAt] = useState(todayInAlgiers());
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const account = accounts.find((a) => a.key === accountKey);
  const isEur = account?.currency === "EUR";

  const options = useMemo(() => {
    const kind = direction === "in" ? "income" : "expense";
    // The ones you actually have to type are listed first; the rest are the
    // categories the profit view works out on its own, kept available so a
    // real cash movement can still be filed against them.
    const mine = categories.filter((c) => c.kind === kind);
    return [...mine.filter((c) => !c.auto), ...mine.filter((c) => c.auto)];
  }, [categories, direction]);

  const chosen = categories.find((c) => c.key === categoryKey);

  // EUR is typed in euros and stored in cents, so no float touches money.
  const parsed = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  const dzdPreview = valid ? (isEur ? Math.round(parsed * eurDzd) : Math.round(parsed)) : 0;

  async function save() {
    setError(null);
    if (!valid) return setError("Type an amount bigger than zero");
    if (!categoryKey) return setError("Pick what it was for");

    setSaving(true);
    try {
      const res = await fetch("/api/finance/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Key": adminKey },
        body: JSON.stringify({
          direction, accountKey, categoryKey, occurredAt,
          toAccountKey: direction === "transfer" ? toAccountKey : undefined,
          amount: isEur ? Math.round(parsed * 100) : Math.round(parsed),
          note: note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data?.error || "Couldn't save it"); return; }
      onSaved(
        `Recorded ${isEur ? "€" + parsed.toFixed(2) : fmt(parsed) + " DA"}` +
        (data.countedInProfit ? "" : " — ledger only, the profit already counts this from your orders.")
      );
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fin-modal-bg" onClick={onClose}>
      <div className="fin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fin-modal-h">
          <h2>Record money</h2>
          <button className="fin-btn fin-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="fin-seg">
          {(["out", "in", "transfer"] as const).map((d) => (
            <button key={d} className={"fin-segb" + (direction === d ? " on" : "")}
              onClick={() => { setDirection(d); setCategoryKey(""); }}>
              {d === "out" ? "I spent" : d === "in" ? "Money came in" : "Moved between accounts"}
            </button>
          ))}
        </div>

        <div className="fin-form2">
          <label>
            <span>{direction === "transfer" ? "From" : "Account"}</span>
            <select className="fin-input" value={accountKey} onChange={(e) => setAccountKey(e.target.value)}>
              {accounts.map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
            </select>
          </label>

          {direction === "transfer" ? (
            <label>
              <span>To</span>
              <select className="fin-input" value={toAccountKey} onChange={(e) => setToAccountKey(e.target.value)}>
                {accounts.filter((a) => a.key !== accountKey)
                  .map((a) => <option key={a.key} value={a.key}>{a.name}</option>)}
              </select>
            </label>
          ) : (
            <label>
              <span>What for</span>
              <select className="fin-input" value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}>
                <option value="">Choose…</option>
                {options.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}{c.auto ? " (ledger only)" : ""}</option>
                ))}
              </select>
            </label>
          )}

          <label>
            <span>Amount {isEur ? "(€)" : "(DA)"}</span>
            <input className="fin-input" inputMode="decimal" value={amount} placeholder={isEur ? "50.00" : "2400"}
              onChange={(e) => setAmount(e.target.value.replace(isEur ? /[^\d.]/g : /[^\d]/g, ""))} autoFocus />
          </label>

          <label>
            <span>When</span>
            <input className="fin-input" type="date" value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)} />
          </label>
        </div>

        {direction === "transfer" && (
          <label className="fin-fullfield">
            <span>What for</span>
            <select className="fin-input" value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}>
              <option value="">Choose…</option>
              {categories.filter((c) => c.kind === "expense")
                .map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        )}

        <label className="fin-fullfield">
          <span>Note (optional)</span>
          <input className="fin-input" value={note} placeholder="what exactly, so it makes sense in a month"
            onChange={(e) => setNote(e.target.value)} />
        </label>

        {isEur && valid && (
          <p className="fin-hint fin-hint-top">
            €{parsed.toFixed(2)} = <b>{fmt(dzdPreview)} DA</b> at {eurDzd} DA/€.
            That rate is saved with this row, so changing it later won&apos;t rewrite today.
          </p>
        )}

        {chosen?.auto && (
          <p className="fin-hint fin-hint-top fin-warnhint">
            This goes in the ledger but <b>not</b> into the profit — the profit already works
            «{chosen.label}» out from your orders. Recording it here keeps the account balance
            honest without counting it twice.
          </p>
        )}

        {error && <div className="fin-alert fin-alert-sm">{error}</div>}

        <div className="fin-modal-f">
          <button className="fin-btn fin-ghost" onClick={onClose}>Cancel</button>
          <button className="fin-btn fin-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Record it"}
          </button>
        </div>
      </div>
    </div>
  );
}
