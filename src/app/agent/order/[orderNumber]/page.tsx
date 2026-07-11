"use client";

// Agent order screen v2 — call the client, edit anything (price
// auto-recomputes), move the status (attempts / callback / cancel
// reason), read+write the timeline, see the customer's history,
// then send to Ecotrack.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { STATUS_META, POST_SHIP_STATUSES, MAX_CALL_ATTEMPTS, type StatusKey } from "@/lib/order-status";

const TOKEN_KEY = "curio-agent-token";
const DA = (n: number) => (n || 0).toLocaleString("en") + " دج";

type Item = { slug: string; quantity: number; name: string };
type Wilaya = { code: number; ar: string; home: number | null; stopdesk: number | null; communes: { name: string; desk: boolean }[] };
type EventRow = { id: string; kind: string; status: string | null; note: string | null; actor: string; createdAt: string };
type PrevOrder = { orderNumber: number; status: string; total: number; createdAt: string };

const meta = (s: string) => STATUS_META[s as StatusKey] || { ar: s, color: "#888" };
const fmtDT = (s: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function AgentOrder() {
  const params = useParams();
  const orderNumber = String(params.orderNumber);
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [order, setOrder] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [prevOrders, setPrevOrders] = useState<PrevOrder[]>([]);
  const [cancelReasons, setCancelReasons] = useState<string[]>([]);
  const [wilayas, setWilayas] = useState<Wilaya[]>([]);
  const [priceMap, setPriceMap] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // status modals
  const [showCallback, setShowCallback] = useState(false);
  const [cbAt, setCbAt] = useState("");
  const [cbNote, setCbNote] = useState("");
  const [showCancel, setShowCancel] = useState(false);
  const [cReason, setCReason] = useState("");
  const [cReasonText, setCReasonText] = useState("");
  const [commentText, setCommentText] = useState("");

  // editable form
  const [f, setF] = useState({
    customerName: "", customerPhone: "", customerPhone2: "",
    deliveryType: "HOME", wilayaCode: "", commune: "", address: "",
    officeCommune: "", officeName: "", notes: "",
  });
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => { setToken(window.sessionStorage.getItem(TOKEN_KEY) || ""); setReady(true); }, []);

  const hydrate = useCallback((o: Record<string, unknown>) => {
    setOrder(o);
    setEvents(((o.events as EventRow[]) || []));
    setF({
      customerName: (o.customerName as string) || "",
      customerPhone: (o.customerPhone as string) || "",
      customerPhone2: (o.customerPhone2 as string) || "",
      deliveryType: (o.deliveryType as string) || "HOME",
      wilayaCode: (o.wilayaCode as string) || "",
      commune: (o.commune as string) || "",
      address: (o.address as string) || "",
      officeCommune: (o.officeCommune as string) || "",
      officeName: (o.officeName as string) || "",
      notes: (o.notes as string) || "",
    });
    const its = (o.items as { quantity: number; unitPrice: number; product: { name: string; slug: string } }[]) || [];
    setItems(its.map((i) => ({ slug: i.product.slug, quantity: i.quantity, name: i.product.name })));
    const pm: Record<string, number> = {};
    its.forEach((i) => (pm[i.product.slug] = i.unitPrice));
    setPriceMap((prev) => ({ ...pm, ...prev }));
  }, []);

  const load = useCallback(async (tok: string) => {
    setError("");
    const res = await fetch(`/api/agent/orders/${orderNumber}`, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
    if (res.status === 401) { window.location.href = "/agent"; return; }
    const j = await res.json();
    if (!res.ok) { setError(j.error || "مشكل"); return; }
    hydrate(j.order);
    setPrevOrders(j.prevOrders || []);
    if (Array.isArray(j.cancelReasons)) setCancelReasons(j.cancelReasons);
  }, [orderNumber, hydrate]);

  useEffect(() => {
    if (!token) return;
    load(token);
    // catalog prices + wilaya/commune options — retry (no-store) so a slow/dropped
    // request at open doesn't leave the editor without delivery data.
    const getJSON = (u: string, n: number): Promise<unknown> =>
      fetch(u, { cache: "no-store" }).then((r) => { if (!r.ok) throw 0; return r.json(); })
        .catch(() => (n > 0 ? new Promise((z) => setTimeout(z, 700)).then(() => getJSON(u, n - 1)) : null));
    getJSON("/api/products", 4).then((ps) => {
      if (!Array.isArray(ps)) return;
      setPriceMap((prev) => { const m = { ...prev }; (ps as { slug: string; price: number }[]).forEach((p) => (m[p.slug] = p.price)); return m; });
    });
    getJSON("/api/delivery", 4).then((d) => { if (d && (d as { wilayas?: unknown[] }).wilayas) setWilayas((d as { wilayas: Wilaya[] }).wilayas); });
  }, [token, load]);

  const wilaya = useMemo(() => wilayas.find((w) => String(w.code) === String(f.wilayaCode)), [wilayas, f.wilayaCode]);
  const communeOptions = useMemo(() => {
    if (!wilaya) return [];
    return f.deliveryType === "OFFICE" ? wilaya.communes.filter((c) => c.desk) : wilaya.communes;
  }, [wilaya, f.deliveryType]);

  const preview = useMemo(() => {
    const sub = items.reduce((s, it) => s + (priceMap[it.slug] || 0) * it.quantity, 0);
    const fee = wilaya ? (f.deliveryType === "OFFICE" ? wilaya.stopdesk : wilaya.home) : null;
    return { sub, fee, total: sub + (fee || 0) };
  }, [items, priceMap, wilaya, f.deliveryType]);

  function set<K extends keyof typeof f>(k: K, v: string) { setF((s) => ({ ...s, [k]: v })); setMsg(""); }
  function setQty(slug: string, d: number) {
    setItems((its) => its.map((i) => i.slug === slug ? { ...i, quantity: Math.max(1, i.quantity + d) } : i)); setMsg("");
  }
  function removeItem(slug: string) { setItems((its) => its.filter((i) => i.slug !== slug)); setMsg(""); }
  function addItem(slug: string) {
    if (!slug || items.some((i) => i.slug === slug)) return;
    const name = ({ roubla: "روبلة", dlala: "دلالة", "goul-bla-matgoul": "قول بلا متقول", "roubla-dlala-pack": "باك روبلة+دلالة", "eid-2026-bundle": "باك العيد" } as Record<string, string>)[slug] || slug;
    setItems((its) => [...its, { slug, quantity: 1, name }]); setMsg("");
  }

  async function saveEdit() {
    setBusy(true); setError(""); setMsg("");
    try {
      const edit: Record<string, unknown> = {
        customerName: f.customerName, customerPhone: f.customerPhone, customerPhone2: f.customerPhone2,
        deliveryType: f.deliveryType, wilayaCode: f.wilayaCode, notes: f.notes,
        items: items.map((i) => ({ slug: i.slug, quantity: i.quantity })),
      };
      if (f.deliveryType === "HOME") { edit.commune = f.commune; edit.address = f.address; }
      else { edit.officeCommune = f.officeCommune || f.commune; edit.officeName = f.officeName; }
      const res = await fetch(`/api/agent/orders/${orderNumber}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "edit", edit }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error || "فشل الحفظ"); return; }
      hydrate(j.order); setMsg("تسجلات التبديلات ✓");
    } finally { setBusy(false); }
  }

  async function postStatus(status: string, extra?: Record<string, unknown>) {
    setBusy(true); setError(""); setMsg("");
    try {
      const res = await fetch(`/api/agent/orders/${orderNumber}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "status", status, ...extra }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error || "فشل"); return false; }
      hydrate(j.order);
      setMsg(status === "CONFIRMED" ? "تأكد ✓ — دركا تقدري تبعثيه لإيكوتراك" : "تسجلات ✓");
      return true;
    } finally { setBusy(false); }
  }

  function openCallback() {
    const d = new Date(Date.now() + 3 * 3600000);
    d.setMinutes(0, 0, 0);
    setCbAt(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:00`);
    setCbNote((order?.callbackNote as string) || "");
    setShowCallback(true);
  }
  async function saveCallback() {
    if (!cbAt) return;
    const ok = await postStatus("CALLBACK", { callbackAt: new Date(cbAt).toISOString(), callbackNote: cbNote });
    if (ok) setShowCallback(false);
  }
  async function saveCancel() {
    const reason = cReason === "سبب آخر" || !cReason ? (cReasonText || cReason) : cReason + (cReasonText ? ` — ${cReasonText}` : "");
    const ok = await postStatus("CANCELLED", { reason });
    if (ok) setShowCancel(false);
  }

  async function addComment() {
    if (!commentText.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent/orders/${orderNumber}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "comment", text: commentText.trim() }),
      });
      const j = await res.json();
      if (res.ok) { hydrate(j.order); setCommentText(""); }
    } finally { setBusy(false); }
  }

  async function ship() {
    if (!confirm("تبعثي هذا الطلب لإيكوتراك؟")) return;
    setBusy(true); setError(""); setMsg("");
    try {
      const res = await fetch(`/api/agent/orders/${orderNumber}/ship`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error || "فشل الإرسال لإيكوتراك"); return; }
      hydrate(j.order); setMsg("تبعث لإيكوتراك ✓ — " + (j.trackingCode || "بلا كود تتبع"));
    } finally { setBusy(false); }
  }

  if (!ready) return null; // wait until we've read the stored token
  if (!token) { if (typeof window !== "undefined") window.location.href = "/agent"; return null; }

  const status = (order?.status as string) || "";
  const m = meta(status);
  const postShip = POST_SHIP_STATUSES.includes(status as StatusKey);
  const canShip = status === "CONFIRMED" || status === "PROCESSING";
  const attempts = (order?.callAttempts as number) || 0;

  // Stored (saved) totals from the order itself — shown instantly, no fetch needed.
  const oSub = order ? Number(order.subtotal) || 0 : 0;
  const oShip = order ? Number(order.deliveryPrice) || 0 : 0;
  const oTotal = order ? Number(order.total) || 0 : 0;
  const deliveryReady = wilayas.length > 0;                // wilaya/commune data loaded?
  // Show a "new total" line only when an edit actually changes the money.
  const editedTotal = deliveryReady && order != null && (preview.total !== oTotal || preview.fee !== oShip);

  return (
    <div className="ao-wrap">
      <a className="ao-back" href="/agent">← الطلبات</a>
      {error && <div className="ao-err">{error}</div>}
      {msg && <div className="ao-ok">{msg}</div>}
      {!order ? <div className="ao-info">يحمّل…</div> : (
        <>
          <div className="ao-head">
            <b>#{orderNumber}</b>
            <span className="ao-status" style={{ background: m.color }}>{m.ar}</span>
            {attempts > 0 && <span className="ao-att">محاولات: {attempts}/{MAX_CALL_ATTEMPTS}</span>}
            {order.trackingCode ? <span className="ao-track" dir="ltr">{order.trackingCode as string}</span> : null}
          </div>
          <div className="ao-created">جا في: {fmtDT(order.createdAt as string)}</div>

          {(order.callbackNote || (status === "CALLBACK" && order.nextCallAt)) ? (
            <div className="ao-cbinfo">
              معاودة: {fmtDT(order.nextCallAt as string)}{order.callbackNote ? ` — ${order.callbackNote as string}` : ""}
            </div>
          ) : null}
          {status === "CANCELLED" && order.cancelReason ? (
            <div className="ao-cbinfo ao-cancelinfo">السبب: {order.cancelReason as string}</div>
          ) : null}

          {prevOrders.length > 0 && (
            <section className="ao-sec ao-prev">
              <h3>زبون قديم — {prevOrders.length} طلبات أخرى بنفس الرقم</h3>
              {prevOrders.map((po) => (
                <a className="ao-prev-row" key={po.orderNumber} href={`/agent/order/${po.orderNumber}`}>
                  <b>#{po.orderNumber}</b>
                  <span className="ao-prev-status" style={{ background: meta(po.status).color }}>{meta(po.status).ar}</span>
                  <span>{DA(po.total)}</span>
                  <span className="ao-dim">{fmtDT(po.createdAt)}</span>
                </a>
              ))}
            </section>
          )}

          <section className="ao-sec">
            <h3>الزبون</h3>
            <label>الاسم<input value={f.customerName} onChange={(e) => set("customerName", e.target.value)} /></label>
            <div className="ao-2">
              <label>الهاتف<input value={f.customerPhone} onChange={(e) => set("customerPhone", e.target.value)} dir="ltr" /></label>
              <label>هاتف 2<input value={f.customerPhone2} onChange={(e) => set("customerPhone2", e.target.value)} dir="ltr" /></label>
            </div>
          </section>

          <section className="ao-sec">
            <h3>التوصيل</h3>
            <div className="ao-seg">
              <button className={f.deliveryType === "HOME" ? "on" : ""} onClick={() => set("deliveryType", "HOME")}>للدار</button>
              <button className={f.deliveryType === "OFFICE" ? "on" : ""} onClick={() => set("deliveryType", "OFFICE")}>مكتب</button>
            </div>
            <label>الولاية
              <select value={f.wilayaCode} onChange={(e) => { set("wilayaCode", e.target.value); set("commune", ""); set("officeCommune", ""); }}>
                <option value="">اختاري…</option>
                {wilayas.map((w) => <option key={w.code} value={String(w.code)}>{(w.code < 10 ? "0" + w.code : w.code) + " - " + w.ar}</option>)}
              </select>
            </label>
            <label>{f.deliveryType === "OFFICE" ? "مكتب ستوب ديسك" : "البلدية"}
              <select value={f.deliveryType === "OFFICE" ? (f.officeCommune || f.commune) : f.commune}
                onChange={(e) => set(f.deliveryType === "OFFICE" ? "officeCommune" : "commune", e.target.value)}>
                <option value="">اختاري…</option>
                {communeOptions.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            {f.deliveryType === "HOME" && (
              <label>العنوان<input value={f.address} onChange={(e) => set("address", e.target.value)} /></label>
            )}
          </section>

          <section className="ao-sec">
            <h3>المنتجات</h3>
            {items.map((it) => (
              <div className="ao-item" key={it.slug}>
                <span>{it.name} <small>({DA(priceMap[it.slug] || 0)})</small></span>
                <div className="ao-qty">
                  <button onClick={() => setQty(it.slug, -1)}>−</button><b>{it.quantity}</b><button onClick={() => setQty(it.slug, 1)}>+</button>
                  <button className="ao-x" onClick={() => removeItem(it.slug)}>حذف</button>
                </div>
              </div>
            ))}
            <select className="ao-add" value="" onChange={(e) => addItem(e.target.value)}>
              <option value="">+ زيدي منتج…</option>
              {Object.keys(priceMap).filter((s) => !items.some((i) => i.slug === s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </section>

          <div className="ao-total">
            <div className="ao-total-cur">
              <span>المنتجات {DA(oSub)} + التوصيل {DA(oShip)}</span>
              <b>الإجمالي: {DA(oTotal)}</b>
            </div>
            {!deliveryReady && (
              <div className="ao-total-hint">جاري تحميل بيانات التوصيل… (باش تقدري تبدلي الولاية/نوع التوصيل)</div>
            )}
            {editedTotal && (
              <div className="ao-total-new">
                <span>بعد التعديل: منتجات {DA(preview.sub)} + توصيل {preview.fee == null ? "—" : DA(preview.fee)}</span>
                <b>= {DA(preview.total)}</b>
                <em>اضغطي «احفظ» باش يتسجل</em>
              </div>
            )}
          </div>

          <button className="ao-save" disabled={busy} onClick={saveEdit}>{busy ? "…" : "احفظ التبديلات"}</button>

          {!postShip ? (
            <section className="ao-sec">
              <h3>نتيجة المكالمة</h3>
              <div className="ao-disp">
                <button className="ao-d-ok" disabled={busy} onClick={() => postStatus("CONFIRMED")}>مأكد ✓</button>
                <button className="ao-d-noans" disabled={busy} onClick={() => postStatus("NO_ANSWER")}>
                  ما جاوبش{attempts > 0 ? ` (${attempts}/${MAX_CALL_ATTEMPTS})` : ""}
                </button>
                <button className="ao-d-cb" disabled={busy} onClick={openCallback}>معاودة الاتصال…</button>
                <button className="ao-d-danger" disabled={busy} onClick={() => { setCReason(""); setCReasonText(""); setShowCancel(true); }}>ملغى…</button>
                <button className="ao-d-danger" disabled={busy} onClick={() => window.confirm("متأكدة؟ رقم غالط") && postStatus("WRONG")}>رقم غالط</button>
                <button className="ao-d-danger" disabled={busy} onClick={() => window.confirm("متأكدة؟ طلب مكرر") && postStatus("DUPLICATE")}>مكرر</button>
              </div>
              {["CANCELLED", "EXPIRED", "WRONG", "DUPLICATE"].includes(status) && (
                <button className="ao-recover" disabled={busy} onClick={() => postStatus("PENDING")}>رجعي الطلب للطابور (جديد)</button>
              )}
            </section>
          ) : (
            <div className="ao-postship">
              الطلب راه عند الموصّل — الحالة تتبدل وحدها من إيكوتراك.
              تقدري تزيدي تعليق تحت، و«فشل التسليم» معناها لازم تعيطي للزبون.
            </div>
          )}

          {canShip && (
            <button className="ao-ship" disabled={busy} onClick={ship}>ابعث لإيكوتراك</button>
          )}

          {/* ── timeline ── */}
          <section className="ao-sec">
            <h3>التعليقات والتاريخ</h3>
            <div className="ao-cmt-add">
              <input value={commentText} onChange={(e) => setCommentText(e.target.value)}
                placeholder="اكتبي تعليق… (واش قال الزبون)" onKeyDown={(e) => e.key === "Enter" && addComment()} />
              <button disabled={busy || !commentText.trim()} onClick={addComment}>زيدي</button>
            </div>
            <div className="ao-timeline">
              {events.length === 0 && <div className="ao-dim">مازال والو</div>}
              {events.map((e) => (
                <div key={e.id} className={`ao-ev ao-ev-${e.kind}`}>
                  <div className="ao-ev-head">
                    <b>
                      {e.kind === "courier" ? "الموصّل (إيكوتراك)"
                        : e.kind === "attempt" ? `${e.actor} — محاولة`
                        : e.actor}
                    </b>
                    <span className="ao-dim">{fmtDT(e.createdAt)}</span>
                  </div>
                  {e.kind === "status" && e.status ? (
                    <div>
                      الحالة ولات: <span className="ao-ev-status" style={{ background: meta(e.status).color }}>{meta(e.status).ar}</span>
                      {e.note ? <span className="ao-dim"> — {e.note}</span> : null}
                    </div>
                  ) : (
                    <div>{e.note}</div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* ── callback modal ── */}
      {showCallback && (
        <div className="ao-overlay" onClick={() => setShowCallback(false)}>
          <div className="ao-modal" onClick={(e) => e.stopPropagation()}>
            <h3>معاودة الاتصال</h3>
            <label>وقتاش نعاودو؟
              <input type="datetime-local" value={cbAt} onChange={(e) => setCbAt(e.target.value)} />
            </label>
            <label>ملاحظة (واش قال الزبون؟)
              <input value={cbNote} onChange={(e) => setCbNote(e.target.value)} placeholder="مثلا: عيّطلي بعد السادسة" />
            </label>
            <div className="ao-modal-btns">
              <button className="ao-mbtn" disabled={busy || !cbAt} onClick={saveCallback}>سجلي</button>
              <button className="ao-mghost" onClick={() => setShowCallback(false)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* ── cancel modal ── */}
      {showCancel && (
        <div className="ao-overlay" onClick={() => setShowCancel(false)}>
          <div className="ao-modal" onClick={(e) => e.stopPropagation()}>
            <h3>علاش تلغى؟</h3>
            <div className="ao-reasons">
              {cancelReasons.map((r) => (
                <button key={r} className={`ao-reason ${cReason === r ? "on" : ""}`} onClick={() => setCReason(r)}>{r}</button>
              ))}
            </div>
            <label>تفاصيل زايدة (اختياري)
              <input value={cReasonText} onChange={(e) => setCReasonText(e.target.value)} />
            </label>
            <div className="ao-modal-btns">
              <button className="ao-mbtn ao-mdanger" disabled={busy || (!cReason && !cReasonText)} onClick={saveCancel}>ألغي الطلب</button>
              <button className="ao-mghost" onClick={() => setShowCancel(false)}>رجوع</button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{styles}</style>
    </div>
  );
}

const styles = `
  .ao-wrap{max-width:680px;margin:0 auto;padding:16px 14px 70px;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;color:#161310;direction:rtl}
  .ao-back{display:inline-block;margin-bottom:12px;font-weight:800;text-decoration:none;color:#161310}
  .ao-err{background:#fdeeee;border:2px solid #ec2c24;border-radius:10px;padding:10px 14px;margin:8px 0;font-weight:700;color:#b52c35}
  .ao-ok{background:#eaf7e6;border:2px solid #5cb335;border-radius:10px;padding:10px 14px;margin:8px 0;font-weight:800;color:#2c7a1e}
  .ao-info{padding:24px 0;color:#675b4c;text-align:center}
  .ao-dim{color:#675b4c;font-size:.78rem}
  .ao-head{display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap}
  .ao-head b{font-size:1.4rem}
  .ao-status{font-size:.75rem;font-weight:800;padding:4px 12px;border-radius:999px;border:2px solid #161310;color:#fff}
  .ao-att{font-size:.75rem;color:#675b4c;font-weight:700}
  .ao-track{font-family:ui-monospace,monospace;font-size:.78rem;background:#eaf4fb;border:1.5px solid #2aa9e0;border-radius:8px;padding:2px 8px}
  .ao-created{color:#675b4c;font-size:.8rem;margin-bottom:12px}
  .ao-cbinfo{background:#f3e8ff;border:2px solid #8b5cf6;border-radius:10px;padding:8px 12px;font-weight:700;font-size:.85rem;margin-bottom:12px}
  .ao-cancelinfo{background:#f4f4f5;border-color:#6b7280}
  .ao-sec{border:2px solid #161310;border-radius:14px;background:#fffdf7;box-shadow:3px 3px 0 #161310;padding:14px;margin-bottom:14px}
  .ao-sec h3{margin:0 0 10px;font-size:1rem}
  .ao-sec label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;font-weight:700;color:#675b4c;margin-bottom:10px}
  .ao-sec input,.ao-sec select{border:1.5px solid #cbbfa8;border-radius:9px;padding:10px;font-size:1rem;font-family:inherit;background:#fff}
  .ao-2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .ao-seg{display:flex;gap:8px;margin-bottom:10px}
  .ao-seg button{flex:1;border:2px solid #161310;border-radius:10px;background:#fff;padding:10px;font-weight:800;cursor:pointer}
  .ao-seg button.on{background:#facc15;box-shadow:2px 2px 0 #161310}
  .ao-item{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px dashed #cbbfa8}
  .ao-item small{color:#675b4c}
  .ao-qty{display:flex;align-items:center;gap:8px}
  .ao-qty button{width:34px;height:34px;border:2px solid #161310;border-radius:8px;background:#fff;font-size:1.1rem;cursor:pointer}
  .ao-qty .ao-x{width:auto;padding:0 10px;font-size:.8rem;font-weight:800;background:#f3ece0}
  .ao-add{margin-top:10px;border:1.5px dashed #161310;border-radius:9px;padding:9px;width:100%;background:#fff;font-family:inherit}
  .ao-total{padding:12px 14px;border:2px dashed #161310;border-radius:12px;margin-bottom:12px;font-weight:700}
  .ao-total-cur{display:flex;justify-content:space-between;align-items:baseline;gap:10px}
  .ao-total-cur b{font-size:1.2rem}
  .ao-total-hint{margin-top:8px;font-size:.82rem;color:#8a5a00;background:#fff6d6;border-radius:8px;padding:6px 10px;font-weight:700}
  .ao-total-new{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-top:10px;padding-top:10px;border-top:1px dashed #cbbfa8;color:#2c7a1e}
  .ao-total-new b{font-size:1.15rem}
  .ao-total-new em{font-style:normal;font-size:.72rem;color:#675b4c;background:#eaf7e6;border:1px solid #a9d99a;border-radius:6px;padding:2px 7px}
  .ao-save{width:100%;background:#161310;color:#fff;border:2px solid #161310;border-radius:12px;padding:13px;font-weight:800;font-size:1rem;cursor:pointer;margin-bottom:16px}
  .ao-save:disabled{opacity:.5}
  .ao-disp{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .ao-disp button{border:2px solid #161310;border-radius:10px;background:#fff;padding:12px;font-weight:800;cursor:pointer;font-size:.9rem}
  .ao-disp .ao-d-ok{background:#22c55e;color:#fff;box-shadow:3px 3px 0 #161310}
  .ao-disp .ao-d-noans{background:#ffe9d6}
  .ao-disp .ao-d-cb{background:#f3e8ff}
  .ao-disp .ao-d-danger{background:#fff0f0}
  .ao-recover{margin-top:10px;width:100%;border:2px dashed #161310;border-radius:10px;background:#fff;padding:11px;font-weight:800;cursor:pointer}
  .ao-postship{background:#eaf4fb;border:2px solid #2aa9e0;border-radius:12px;padding:12px 14px;font-weight:700;font-size:.9rem;margin-bottom:14px}
  .ao-ship{width:100%;background:#2aa9e0;color:#fff;border:2px solid #161310;border-radius:12px;padding:15px;font-weight:800;font-size:1.15rem;cursor:pointer;box-shadow:4px 4px 0 #161310;margin:6px 0 16px}
  .ao-ship:disabled{opacity:.5}
  .ao-prev{background:#f0f6ff}
  .ao-prev-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed #cbbfa8;text-decoration:none;color:#161310;font-size:.88rem;flex-wrap:wrap}
  .ao-prev-row:last-child{border-bottom:none}
  .ao-prev-status{font-size:.68rem;font-weight:800;color:#fff;border-radius:999px;padding:2px 9px;border:1.5px solid #161310}
  .ao-cmt-add{display:flex;gap:8px;margin-bottom:12px}
  .ao-cmt-add input{flex:1}
  .ao-cmt-add button{border:2px solid #161310;border-radius:9px;background:#161310;color:#fff;font-weight:800;padding:0 16px;cursor:pointer}
  .ao-cmt-add button:disabled{opacity:.5}
  .ao-timeline{display:grid;gap:8px;max-height:420px;overflow-y:auto}
  .ao-ev{background:#fff;border:1.5px solid #cbbfa8;border-radius:10px;padding:8px 12px;font-size:.86rem}
  .ao-ev-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:3px}
  .ao-ev-courier{background:#fff7ed;border-color:#f59e0b}
  .ao-ev-attempt{background:#ffe9d6;border-color:#f97316}
  .ao-ev-comment{background:#f0f6ff;border-color:#93c5fd}
  .ao-ev-status{display:inline-block;font-size:.68rem;font-weight:800;color:#fff;border-radius:999px;padding:2px 9px;border:1.5px solid #161310}
  .ao-overlay{position:fixed;inset:0;background:rgba(22,19,16,.45);z-index:70;display:grid;place-items:center;padding:16px}
  .ao-modal{background:#fff;border:2px solid #161310;border-radius:16px;box-shadow:6px 6px 0 #161310;padding:20px;width:min(94vw,440px);direction:rtl}
  .ao-modal h3{margin:0 0 14px}
  .ao-modal label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;font-weight:800;color:#675b4c;margin-bottom:12px}
  .ao-modal input{border:1.5px solid #cbbfa8;border-radius:9px;padding:10px;font-size:.95rem;font-family:inherit}
  .ao-modal-btns{display:flex;gap:10px}
  .ao-mbtn{background:#161310;color:#fff;border:2px solid #161310;border-radius:9px;padding:9px 18px;font-weight:800;cursor:pointer}
  .ao-mbtn:disabled{opacity:.5}
  .ao-mdanger{background:#dc2626}
  .ao-mghost{background:#fff;border:2px solid #161310;border-radius:9px;padding:9px 14px;font-weight:800;cursor:pointer}
  .ao-reasons{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
  .ao-reason{background:#fff;border:2px solid #161310;border-radius:999px;padding:7px 12px;font-size:.8rem;font-weight:800;cursor:pointer}
  .ao-reason.on{background:#dc2626;color:#fff}
`;
