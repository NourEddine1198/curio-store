"use client";

import { useEffect, useState } from "react";

// The orders behind a number.
//
// Every figure on the scoreboard that can be opened, opens here. A metric you
// cannot interrogate is one you end up arguing with instead of acting on —
// and "return rate 9.7%" means nothing until you can see whose boxes came
// back and why.

interface Row {
  orderNumber: number;
  status: string;
  customerName: string;
  customerPhone: string;
  where: string;
  deliveryType: string;
  total: number;
  games: number;
  what: string;
  placed: string;
  delivered: string | null;
  daysWaiting: number | null;
  reason: string | null;
  courierSays: string | null;
  courierCollects: number | null;
  repeat: boolean;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const dayOf = (iso: string) => new Date(new Date(iso).getTime() + 60 * 60000).toISOString().slice(0, 10);

export default function DrillModal({
  adminKey, metric, title, period, tier, product, onClose,
}: {
  adminKey: string; metric: string; title: string; period: string;
  tier?: string; product?: string; onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [meta, setMeta] = useState<{ count: number; value: number; meaning: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({ metric, period });
    if (tier) params.set("tier", tier);
    if (product) params.set("product", product);
    fetch(`/api/analytics/orders?${params}`, { headers: { "X-Admin-Key": adminKey } })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setError(d?.error || "Couldn't load"); return; }
        setRows(d.orders);
        setMeta({ count: d.count, value: d.value, meaning: d.meaning, truncated: d.truncated });
      })
      .catch(() => setError("Couldn't reach the server"));
  }, [adminKey, metric, period, tier, product]);

  const shown = (rows || []).filter((r) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    return String(r.orderNumber).includes(s) || r.customerName.toLowerCase().includes(s) ||
      (r.where || "").toLowerCase().includes(s) || r.customerPhone.includes(s);
  });

  return (
    <div className="sb-modal-bg" onClick={onClose}>
      <div className="sb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sb-modal-h">
          <div>
            <h2>{title}</h2>
            {meta && <p className="sb-modal-sub">{meta.meaning}</p>}
          </div>
          <button className="sb-btn sb-ghost" onClick={onClose}>✕</button>
        </div>

        {meta && (
          <div className="sb-modal-tally">
            <div><b>{meta.count}</b><span>orders</span></div>
            <div><b>{fmt(meta.value)} DA</b><span>together</span></div>
            <input className="sb-input sb-input-inline" value={q} placeholder="find a name, number or commune"
              onChange={(e) => setQ(e.target.value)} />
          </div>
        )}

        {error && <div className="sb-alert">{error}</div>}
        {!rows && !error && <p className="sb-hint">Loading…</p>}

        {rows && (
          <div className="sb-scroll sb-modal-scroll">
            <table className="sb-tbl sb-tbl-sm">
              <thead>
                <tr><th>Order</th><th>Customer</th><th>Where</th><th>What</th>
                  <th className="n">Total</th><th>Status</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.orderNumber}>
                    <td>
                      #{r.orderNumber}
                      {r.repeat && <em className="sb-tag">repeat</em>}
                    </td>
                    <td>
                      {r.customerName}
                      <em className="sb-sub">{r.customerPhone}</em>
                    </td>
                    <td>
                      {r.where}
                      <em className="sb-sub">{r.deliveryType === "OFFICE" ? "stop-desk" : "home"}</em>
                    </td>
                    <td>
                      {r.what}
                      {r.games > 1 && <em className="sb-tag">{r.games} games</em>}
                    </td>
                    <td className="n">
                      {fmt(r.total)}
                      {r.courierCollects != null && r.courierCollects !== r.total && (
                        <em className="sb-sub sb-bad">courier: {fmt(r.courierCollects)}</em>
                      )}
                    </td>
                    <td>
                      {r.status.toLowerCase().replace(/_/g, " ")}
                      {r.daysWaiting != null && r.daysWaiting >= 2 && (
                        <em className="sb-sub sb-bad">{r.daysWaiting} days waiting</em>
                      )}
                      {r.reason && <em className="sb-sub">{r.reason}</em>}
                      {r.courierSays && <em className="sb-sub">{r.courierSays}</em>}
                      <em className="sb-sub">placed {dayOf(r.placed)}</em>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr><td colSpan={6} className="sb-hint">Nothing matches.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {meta?.truncated && (
          <p className="sb-hint">Showing the first 300. Narrow the period to see the rest.</p>
        )}
      </div>
      <style dangerouslySetInnerHTML={{ __html: `
        .sb-modal-bg{position:fixed;inset:0;background:rgba(42,36,25,.44);display:flex;align-items:center;
                     justify-content:center;padding:18px;z-index:60;}
        .sb-modal{background:var(--surface);border-radius:18px;padding:22px;max-width:1000px;width:100%;
                  max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(50,36,10,.3);}
        .sb-modal-h{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;}
        .sb-modal-h h2{font-family:var(--disp);font-size:19px;margin:0;}
        .sb-modal-sub{font-size:12.5px;color:var(--soft);margin:3px 0 0;}
        .sb-modal-tally{display:flex;align-items:center;gap:20px;margin:14px 0 10px;padding:11px 15px;
                        background:var(--cream);border:1px solid var(--line);border-radius:12px;flex-wrap:wrap;}
        .sb-modal-tally b{font-family:var(--disp);font-size:18px;font-variant-numeric:tabular-nums;display:block;}
        .sb-modal-tally span{font-size:11px;color:var(--soft);}
        .sb-input-inline{margin-top:0;margin-left:auto;max-width:280px;}
        .sb-modal-scroll{overflow:auto;flex:1;}
        .sb-modal .sb-tbl td{vertical-align:top;}
        .sb-sub{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:2px;}
      ` }} />
    </div>
  );
}
