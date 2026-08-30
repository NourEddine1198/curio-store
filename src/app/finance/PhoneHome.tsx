"use client";

// The phone view. Not the desk page made narrow — a different screen with a
// different job: see the one number, log a cost in seconds, get out.
//
// Rendered alongside the desk layout and switched by CSS rather than by
// JavaScript, so there is no flash of the wrong view and nothing for
// hydration to disagree about.

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export interface PhoneMovement {
  id: string;
  occurredAt: string;
  direction: string;
  amount: number;
  currency: string;
  amountDzd: number;
  note: string | null;
  payoutId: string | null;
  category: { label: string; labelAr: string | null; auto: boolean } | null;
}

export default function PhoneHome({
  profit, profitLabel, perOrder, delivered, stale,
  owed, owedParcels, notCollected, notCollectedParcels,
  costs, movements, unsettledCount,
  onSpend, onReceive, onPayout, onDelete, dayInAlgiers,
}: {
  profit: number;
  profitLabel: string;
  perOrder: number;
  delivered: number;
  stale: boolean;
  owed: number;
  owedParcels: number;
  notCollected: number;
  notCollectedParcels: number;
  costs: { label: string; amount: number; positive?: boolean }[];
  movements: PhoneMovement[];
  unsettledCount: number;
  onSpend: () => void;
  onReceive: () => void;
  onPayout: () => void;
  onDelete: (id: string) => void;
  dayInAlgiers: (iso: string) => string;
}) {
  // "This week" is deliberately generous — a fortnight — because the point is
  // to see what you have already logged so you don't log it twice.
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
  const recent = movements.filter((m) => m.occurredAt >= cutoff).slice(0, 12);

  return (
    <div className="fin-phone">
      <div className="fin-pcard fin-phero">
        <div className="fin-lbl">Profit · {profitLabel.toLowerCase()}</div>
        {stale ? (
          <div className="fin-pbig fin-dim">—</div>
        ) : (
          <div className={"fin-pbig " + (profit >= 0 ? "fin-ok" : "fin-bad")}>
            {profit < 0 ? "−" : ""}{fmt(Math.abs(profit))} <small>DA</small>
          </div>
        )}
        <div className="fin-note">{fmt(perOrder)} DA per delivered order · {delivered} delivered</div>
      </div>

      <div className="fin-pcard fin-card-gold">
        <div className="fin-lbl">Ecotrack is holding</div>
        <div className="fin-pmid">{fmt(owed)} <small>DA</small></div>
        <div className="fin-note">{owedParcels} parcels · cash, on request</div>
        {notCollectedParcels > 0 && (
          <div className="fin-warn-line">
            {fmt(notCollected)} DA on {notCollectedParcels} parcels <b>delivered but never collected</b>.
          </div>
        )}
        {unsettledCount > 0 && (
          <button className="fin-btn fin-wfull" onClick={onPayout}>I collected a payout</button>
        )}
      </div>

      <div className="fin-pactions">
        <button className="fin-pbtn fin-pbtn-out" onClick={onSpend}>
          <b>صرفت</b><span>I spent</span>
        </button>
        <button className="fin-pbtn fin-pbtn-in" onClick={onReceive}>
          <b>دخلت</b><span>came in</span>
        </button>
      </div>

      <div className="fin-pcard">
        <div className="fin-lbl">Last two weeks</div>
        {recent.length === 0 ? (
          <p className="fin-note">
            Nothing logged yet. Tap <b>صرفت</b> the next time you buy scotch or bags — it takes
            about five seconds, and it is the only way these end up in the profit.
          </p>
        ) : (
          <div className="fin-plist">
            {recent.map((m) => (
              <div className="fin-prow2" key={m.id}>
                <div className="fin-prow2-l">
                  <b>{m.category?.labelAr || m.category?.label || "—"}</b>
                  <span>
                    {dayInAlgiers(m.occurredAt)}
                    {m.note ? ` · ${m.note}` : ""}
                    {m.category?.auto ? " · ledger only" : ""}
                  </span>
                </div>
                <div className={"fin-prow2-r " + (m.direction === "in" ? "fin-ok" : "")}>
                  {m.direction === "in" ? "+" : "−"}
                  {m.currency === "EUR" ? "€" + (m.amount / 100).toFixed(2) : fmt(m.amount)}
                </div>
                <button className="fin-x" disabled={!!m.payoutId}
                  onClick={() => onDelete(m.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="fin-pcard">
        <div className="fin-lbl">Where the money went</div>
        <div className="fin-plist">
          {costs.map((c) => (
            <div className="fin-prow2" key={c.label}>
              <div className="fin-prow2-l"><b>{c.label}</b></div>
              <div className={"fin-prow2-r " + (c.positive ? "fin-ok" : "")}>
                {c.positive ? "+" : "−"}{fmt(Math.abs(c.amount))}
              </div>
            </div>
          ))}
        </div>
        <p className="fin-note">Open it on a laptop for the full breakdown, the parcel list and the payout slips.</p>
      </div>
    </div>
  );
}
