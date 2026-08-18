"use client";

// ─────────────────────────────────────────────────────────────
// SUIVI BOARD — the follow-up work queue.
//
// The confirmation tabs answer "who do I call to close a sale". This
// answers the other half: "which boxes already in the air are in
// trouble". Without it, spotting a stuck parcel means opening sixty
// orders one at a time.
//
// Three piles:
//   لازم عيّطي  — act now: no answer, phone off, cancelled, suspended,
//                 repeated failed attempts, or nothing moved for days
//   راقبي       — watch: one failed attempt, a note, a reschedule
//   دراهم عندهم — delivered, cash collected, Ecotrack hasn't paid us
//
// Every row carries the phone numbers, so the call is one tap from here.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

type Row = {
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  customerPhone2: string | null;
  wilayaName: string;
  commune: string | null;
  total: number;
  orderStatus: string;
  products: string;
  trackingCode: string;
  ecotrackStatus: string;
  currentStation: string | null;
  driverName: string | null;
  driverPhone: string | null;
  montant: number;
  attemptCount: number;
  alertLevel: string;
  alertReason: string | null;
  lastMoveAt: string | null;
  syncedAt: string;
};
type Counts = { act: number; watch: number; money: number; moneyTotal: number };

const DA = (n: number) => (n || 0).toLocaleString("en") + " دج";

function daysAgo(iso: string | null): string {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d <= 0) return "اليوم";
  if (d === 1) return "البارح";
  return `من ${d} أيام`;
}

const BUCKETS: { key: string; ar: string; hint: string }[] = [
  { key: "act", ar: "لازم عيّطي", hint: "الزبون ما يجاوبش، الهاتف مطفي، ولا الكولي واقف" },
  { key: "watch", ar: "راقبي", hint: "محاولة فشلت ولا ملاحظة من الليفرور" },
  { key: "money", ar: "دراهم عندهم", hint: "وصلات وحصّلو الدراهم وما خلّصوناش" },
];

export default function SuiviBoard({ token }: { token: string }) {
  const [bucket, setBucket] = useState("act");
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Counts>({ act: 0, watch: 0, money: 0, moneyTotal: 0 });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async (b: string) => {
    setLoading(true); setErr("");
    try {
      const res = await fetch(`/api/agent/suivi?bucket=${b}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "مشكل"); setRows([]); return; }
      setRows(j.rows || []);
      setCounts(j.counts || { act: 0, watch: 0, money: 0, moneyTotal: 0 });
    } catch { setErr("مشكل في الشبكة"); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(bucket); }, [bucket, load]);

  return (
    <div className="sb">
      <div className="sb-tabs">
        {BUCKETS.map((b) => {
          const n = counts[b.key as keyof Counts] as number;
          return (
            <button key={b.key} className={`sb-tab sb-${b.key} ${bucket === b.key ? "on" : ""}`}
              onClick={() => setBucket(b.key)} title={b.hint}>
              {b.ar}{n > 0 && <span className="sb-n">{n}</span>}
            </button>
          );
        })}
      </div>

      <p className="sb-hint">{BUCKETS.find((b) => b.key === bucket)?.hint}</p>
      {/* `sb-owed`, not `sb-money`: the bucket TAB already carries the class
          `sb-money`, and sharing the name styled the button like the banner. */}
      {bucket === "money" && counts.money > 0 && (
        <div className="sb-owed">
          إيكوتراك حاصلين <b>{DA(counts.moneyTotal)}</b> على {counts.money} طلبات — وصلات للزبون وما خلّصوناش.
        </div>
      )}

      {err && <div className="sb-err">{err}</div>}
      {loading && <div className="sb-info">يحمّل…</div>}
      {!loading && !rows.length && !err && <div className="sb-info">ماكانش والو هنا — كلش مليح ✓</div>}

      {!loading && rows.map((r) => (
        <div key={r.orderNumber} className={`sb-row sb-lv-${r.alertLevel}`}>
          <div className="sb-main">
            <div className="sb-line1">
              <a className="sb-num" href={`/agent/order/${r.orderNumber}`}>#{r.orderNumber}</a>
              <b>{r.customerName}</b>
              <span className="sb-place">{r.wilayaName}{r.commune ? ` — ${r.commune}` : ""}</span>
            </div>
            {r.alertReason && <div className="sb-reason">{r.alertReason}</div>}
            <div className="sb-line2">
              <span>{r.products}</span>
              <span className="sb-eco">{r.ecotrackStatus}</span>
              {r.currentStation && <span className="sb-station">{r.currentStation}</span>}
              <span className="sb-when">آخر حركة {daysAgo(r.lastMoveAt)}</span>
              {r.attemptCount > 0 && <span className="sb-att">{r.attemptCount} محاولات</span>}
            </div>
          </div>
          <div className="sb-acts">
            <div className="sb-amt">{DA(r.montant)}</div>
            <a className="sb-btn sb-call" href={`tel:${r.customerPhone}`}>الزبون</a>
            {r.customerPhone2 && <a className="sb-btn" href={`tel:${r.customerPhone2}`}>رقم 2</a>}
            {r.driverPhone && (
              <a className="sb-btn sb-drv" href={`tel:${r.driverPhone}`} title={r.driverName || ""}>الليفرور</a>
            )}
            <a className="sb-btn sb-open" href={`/agent/order/${r.orderNumber}`}>افتحي</a>
          </div>
        </div>
      ))}

      <style jsx>{`
        .sb{margin-top:6px}
        .sb-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
        .sb-tab{border:2px solid #161310;border-radius:10px;background:#fff;padding:8px 14px;
                font-weight:800;font-size:.85rem;cursor:pointer;font-family:inherit}
        .sb-tab.on.sb-act{background:#b3261e;color:#fff;border-color:#b3261e}
        .sb-tab.on.sb-watch{background:#c98a1b;color:#fff;border-color:#c98a1b}
        .sb-tab.on.sb-money{background:#0f766e;color:#fff;border-color:#0f766e}
        .sb-n{margin-right:6px;background:rgba(0,0,0,.14);border-radius:999px;padding:1px 7px;font-size:.75rem}
        .sb-tab.on .sb-n{background:rgba(255,255,255,.25)}
        .sb-hint{margin:0 0 10px;font-size:.8rem;color:#675b4c;font-weight:700}
        .sb-owed{background:#e1f5ee;border:2px solid #0f766e;border-radius:10px;padding:9px 12px;
                 font-weight:800;color:#0f766e;font-size:.86rem;margin-bottom:10px}
        .sb-err{background:#fdeceb;border:2px solid #b3261e;color:#b3261e;border-radius:10px;
                padding:9px 12px;font-weight:800;margin-bottom:10px}
        .sb-info{padding:20px 0;text-align:center;color:#675b4c;font-weight:700}
        .sb-row{display:flex;gap:12px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;
                border:2px solid #161310;border-radius:12px;background:#fffdf7;
                box-shadow:2px 2px 0 #161310;padding:10px 12px;margin-bottom:8px}
        .sb-lv-act{background:#fff5f4;border-color:#b3261e}
        .sb-lv-watch{background:#fffbf0}
        .sb-main{flex:1;min-width:240px}
        .sb-line1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
        .sb-num{font-family:ui-monospace,monospace;font-weight:800;text-decoration:none;color:#2aa9e0}
        .sb-line1 b{font-size:.95rem}
        .sb-place{font-size:.76rem;color:#675b4c;font-weight:700}
        .sb-reason{margin-top:3px;font-weight:800;font-size:.86rem;color:#b3261e}
        .sb-lv-watch .sb-reason{color:#8a5a00}
        .sb-line2{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;font-size:.74rem;color:#675b4c;font-weight:700}
        .sb-eco{background:#eaf4fb;border:1px solid #2aa9e0;border-radius:6px;padding:0 6px}
        .sb-station{background:#f3ece0;border-radius:6px;padding:0 6px}
        .sb-att{color:#b3261e}
        .sb-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
        .sb-amt{font-weight:800;font-size:.9rem;margin-left:4px}
        .sb-btn{border:2px solid #161310;border-radius:9px;background:#fff;padding:6px 11px;
                font-weight:800;font-size:.78rem;text-decoration:none;color:#161310;font-family:inherit}
        .sb-call{background:#2aa9e0;color:#fff;border-color:#2aa9e0}
        .sb-drv{background:#facc15}
        .sb-open{background:#161310;color:#fff}
      `}</style>
    </div>
  );
}
