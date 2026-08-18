"use client";

// ─────────────────────────────────────────────────────────────
// SUIVI PANEL — what the agent sees after a parcel exists.
//
// Confirmation is over; the job is now following the box until the
// customer has it. That needs three things on one screen:
//   1. the journey, ours and Ecotrack's merged into one story
//   2. the comment thread — us, the station, the driver
//   3. the phone numbers and the two actions worth taking
//
// TIME: Ecotrack sends Africa/Algiers wall-clock strings. We render
// them verbatim rather than parsing to Date, because that is already
// the agent's own clock and it dodges the Neon adapter's local-time
// write quirk entirely (see ParcelTracking in schema.prisma).
// ─────────────────────────────────────────────────────────────

import { useMemo } from "react";
import { activityLabel, reasonMeta, authorMeta } from "@/lib/suivi";

export type ParcelActivityRow = { date: string; time: string; status: string; station: string };
export type ParcelCommentRow = {
  at: string; reason: string; text: string; station: string;
  driver: string; by: string; postponedTo: string | null;
};
export type Parcel = {
  trackingCode: string;
  status: string;
  currentStation: string | null;
  driverName: string | null;
  driverPhone: string | null;
  montant: number;
  tarifLivraison: number;
  tarifRetour: number;
  attemptCount: number;
  alertLevel: string;
  alertReason: string | null;
  activity: ParcelActivityRow[];
  comments: ParcelCommentRow[];
  syncedAt: string;
};
export type OurEvent = { id: string; kind: string; status: string | null; note: string | null; actor: string; createdAt: string };

const DA = (n: number) => (n || 0).toLocaleString("en") + " دج";

/** "2026-08-16 11:51:50" → "16/08 11:51". Already Algiers time. */
function fmtEco(s: string): string {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : String(s || "");
}
/** Our own timestamps are real instants — render in the browser's zone. */
function fmtOurs(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Algiers wall clock → epoch ms, so both sides sort on one axis. */
function ecoEpoch(s: string): number {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 1, +m[5], +(m[6] || 0));
}

function howStale(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!isFinite(mins) || mins < 0) return "";
  if (mins < 1) return "دركا";
  if (mins < 60) return `من ${mins} دقيقة`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `من ${h} ساعة`;
  return `من ${Math.floor(h / 24)} أيام`;
}

type Row =
  | { at: number; side: "eco"; label: string; tone: string; station: string; when: string }
  | { at: number; side: "us"; label: string; tone: string; station: string; when: string };

export default function SuiviPanel({
  parcel, events, busy, onRefresh, onAskReturn, onFixAmount, orderTotal,
}: {
  parcel: Parcel;
  events: OurEvent[];
  busy: boolean;
  onRefresh: () => void;
  onAskReturn: () => void;
  onFixAmount: () => void;
  orderTotal: number;
}) {
  // ── one merged story, oldest first ──
  const timeline = useMemo<Row[]>(() => {
    const eco: Row[] = (parcel.activity || []).map((a) => {
      const l = activityLabel(a.status);
      return {
        at: ecoEpoch(`${a.date} ${a.time}`), side: "eco" as const,
        label: l.ar, tone: l.tone, station: a.station || "", when: fmtEco(`${a.date} ${a.time}`),
      };
    });
    // Our side: the human decisions. Courier notes are skipped — the
    // comment thread below already shows them, richer and deduped.
    const ours: Row[] = (events || [])
      .filter((e) => e.kind !== "courier")
      .map((e) => ({
        at: new Date(e.createdAt).getTime(), side: "us" as const,
        label: e.note || (e.status ? `الحالة ولات ${e.status}` : e.kind),
        tone: "neutral", station: e.actor || "", when: fmtOurs(e.createdAt),
      }));
    return [...eco, ...ours].sort((a, b) => a.at - b.at);
  }, [parcel.activity, events]);

  const comments = useMemo(
    () => [...(parcel.comments || [])].sort((a, b) => ecoEpoch(a.at) - ecoEpoch(b.at)),
    [parcel.comments]
  );

  const amountMismatch = parcel.montant > 0 && parcel.montant !== orderTotal;
  const level = parcel.alertLevel;

  return (
    <section className={`sv sv-${level}`}>
      {/* ── headline ── */}
      <div className="sv-top">
        <div>
          <div className="sv-eco">{parcel.status || "—"}</div>
          <div className="sv-track">{parcel.trackingCode}</div>
        </div>
        <button className="sv-refresh" disabled={busy} onClick={onRefresh}>
          حدّث <span className="sv-stale">{howStale(parcel.syncedAt)}</span>
        </button>
      </div>

      {parcel.alertReason && (
        <div className={`sv-alert sv-alert-${level}`}>{parcel.alertReason}</div>
      )}

      {/* ── where it is, who has it, what it collects ── */}
      <div className="sv-facts">
        <div><span>وين راه</span><b>{parcel.currentStation || "مازال ما تحرّكش"}</b></div>
        <div><span>الليفرور</span><b>{parcel.driverName || "مازال ما تعيّنش"}</b></div>
        <div><span>يخلّص</span><b>{DA(parcel.montant)}</b></div>
        <div><span>محاولات</span><b>{parcel.attemptCount}</b></div>
      </div>

      {amountMismatch && (
        <div className="sv-money">
          إيكوتراك رايح يحصّل <b>{DA(parcel.montant)}</b> وحنا كاتبين <b>{DA(orderTotal)}</b> —
          فرق {DA(Math.abs(parcel.montant - orderTotal))}. صلّحيه باش الحساب يبقى صحيح.
        </div>
      )}

      {/* ── actions ── */}
      <div className="sv-acts">
        {parcel.driverPhone && (
          <a className="sv-btn sv-btn-call" href={`tel:${parcel.driverPhone}`}>
            عيّطي للليفرور <small>{parcel.driverPhone}</small>
          </a>
        )}
        <button className="sv-btn sv-btn-fix" disabled={busy} onClick={onFixAmount}>بدّلي المبلغ / العنوان</button>
        <button className="sv-btn sv-btn-ret" disabled={busy} onClick={onAskReturn}>اطلبي الإرجاع</button>
      </div>

      {/* ── 1. the journey ── */}
      <h4 className="sv-h">مسار الطلب</h4>
      <div className="sv-tl">
        {timeline.length === 0 && <div className="sv-none">مازال والو</div>}
        {timeline.map((r, i) => (
          <div key={`${r.side}-${r.at}-${i}`} className={`sv-step sv-${r.side} sv-t-${r.tone}`}>
            <div className="sv-when">{r.when}</div>
            <div className="sv-what">
              <b>{r.label}</b>
              {r.station && <span className="sv-where">{r.station}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* ── 2. the thread ── */}
      <h4 className="sv-h">
        التعليقات مع إيكوتراك
        <span className="sv-hint">حنا · المحطة · الليفرور</span>
      </h4>
      <div className="sv-thread">
        {comments.length === 0 && <div className="sv-none">حتى تعليق</div>}
        {comments.map((c, i) => {
          const who = authorMeta(c.by);
          const rm = reasonMeta(c.reason);
          return (
            <div key={`${c.at}-${i}`} className={`sv-msg sv-msg-${who.side}`}>
              <div className="sv-msg-head">
                <b>{who.ar}</b>
                {c.driver && <span className="sv-drv">{c.driver}</span>}
                <span className="sv-when">{fmtEco(c.at)}</span>
              </div>
              {c.reason && <div className={`sv-reason sv-r-${rm.level}`}>{rm.ar}</div>}
              {c.text && <div className="sv-free">{c.text}</div>}
              {c.station && <div className="sv-where">{c.station}</div>}
              {c.postponedTo && <div className="sv-post">تأجّل لـ {fmtEco(c.postponedTo)}</div>}
            </div>
          );
        })}
      </div>

      <p className="sv-foot">
        باش تجاوبي الليفرور لازم تدخلي لإيكوتراك — ما عندهمش طريقة نكتبو ليهم من هنا.
      </p>

      <style jsx>{`
        .sv{border:2px solid #161310;border-radius:14px;background:#fffdf7;
            box-shadow:3px 3px 0 #161310;padding:14px;margin-bottom:14px}
        .sv-act{background:#fff5f4;border-color:#b3261e}
        .sv-watch{background:#fffbf0}
        .sv-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap}
        .sv-eco{font-size:1.05rem;font-weight:800}
        .sv-track{font-family:ui-monospace,monospace;font-size:.75rem;color:#675b4c;margin-top:2px}
        .sv-refresh{border:2px solid #161310;border-radius:9px;background:#fff;padding:6px 12px;
                    font-weight:800;font-size:.78rem;cursor:pointer;font-family:inherit}
        .sv-refresh:disabled{opacity:.5;cursor:not-allowed}
        .sv-stale{color:#675b4c;font-weight:700}
        .sv-alert{margin-top:10px;border-radius:10px;padding:8px 12px;font-weight:800;font-size:.9rem}
        .sv-alert-act{background:#fdeceb;border:2px solid #b3261e;color:#b3261e}
        .sv-alert-watch{background:#fff6d6;border:2px solid #c98a1b;color:#8a5a00}
        .sv-alert-ok{background:#eaf7e6;border:2px solid #5cb335;color:#2c7a1e}
        .sv-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));
                  gap:8px;margin:12px 0;padding:10px;background:#f3ece0;border-radius:10px}
        .sv-facts div{display:flex;flex-direction:column;gap:2px}
        .sv-facts span{font-size:.7rem;font-weight:800;color:#675b4c}
        .sv-facts b{font-size:.86rem}
        .sv-money{background:#fff6d6;border:2px solid #c98a1b;border-radius:10px;
                  padding:9px 12px;font-size:.84rem;font-weight:700;color:#8a5a00;margin-bottom:10px}
        .sv-acts{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}
        .sv-btn{border:2px solid #161310;border-radius:10px;padding:9px 14px;font-weight:800;
                font-size:.82rem;cursor:pointer;font-family:inherit;background:#fff;
                text-decoration:none;color:#161310;display:inline-flex;gap:6px;align-items:baseline}
        .sv-btn small{font-family:ui-monospace,monospace;font-weight:700;color:#675b4c}
        .sv-btn:disabled{opacity:.5;cursor:not-allowed}
        .sv-btn-call{background:#2aa9e0;color:#fff}
        .sv-btn-call small{color:#eaf4fb}
        .sv-btn-fix{background:#facc15}
        .sv-btn-ret{background:#fff}
        .sv-h{margin:16px 0 8px;font-size:.92rem;display:flex;align-items:baseline;
              gap:8px;justify-content:space-between;flex-wrap:wrap}
        .sv-hint{font-size:.7rem;font-weight:700;color:#675b4c}
        .sv-none{color:#675b4c;font-size:.8rem}
        .sv-tl{display:grid;gap:0}
        .sv-step{display:grid;grid-template-columns:76px 1fr;gap:10px;padding:7px 0;
                 border-right:3px solid #cbbfa8;padding-right:12px;margin-right:4px}
        .sv-step.sv-eco{border-right-color:#2aa9e0}
        .sv-step.sv-us{border-right-color:#c98a1b}
        .sv-step.sv-t-bad{border-right-color:#b3261e}
        .sv-step.sv-t-good{border-right-color:#5cb335}
        .sv-when{font-size:.72rem;color:#675b4c;font-weight:700;font-variant-numeric:tabular-nums}
        .sv-what b{font-size:.86rem}
        .sv-where{display:block;font-size:.72rem;color:#675b4c;margin-top:1px}
        .sv-thread{display:grid;gap:8px}
        .sv-msg{border:1.5px solid #cbbfa8;border-radius:10px;padding:8px 10px;background:#fff}
        .sv-msg-us{background:#fff6d6;border-color:#c98a1b}
        .sv-msg-driver{background:#eaf4fb;border-color:#2aa9e0}
        .sv-msg-station{background:#f6f2ea}
        .sv-msg-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:3px}
        .sv-msg-head b{font-size:.78rem}
        .sv-drv{font-size:.72rem;color:#675b4c;font-weight:700}
        .sv-reason{font-size:.85rem;font-weight:800}
        .sv-r-act{color:#b3261e}
        .sv-r-watch{color:#8a5a00}
        .sv-free{font-size:.88rem;margin-top:2px}
        .sv-post{font-size:.75rem;font-weight:800;color:#8a5a00;margin-top:3px}
        .sv-foot{margin:12px 0 0;font-size:.74rem;color:#675b4c;line-height:1.6}
      `}</style>
    </section>
  );
}
