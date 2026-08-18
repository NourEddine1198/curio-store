"use client";

// ─────────────────────────────────────────────────────────────
// AGENT BOARD v2 — OrderDZ-style confirmation console.
// One colored tab per status with live counts; search + filters;
// dense table with inline status changes, call attempts, callbacks,
// cancel reasons, comments, attention dots; bulk-ship to Ecotrack
// from the Confirmed tab; auto-refresh + new-order sound.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TAB_ORDER, STATUS_META, AGENT_SET_STATUSES, POST_SHIP_STATUSES, MAX_CALL_ATTEMPTS, type StatusKey } from "@/lib/order-status";
import SuiviBoard from "./SuiviBoard";

// The follow-up board is a view, not a status — parcels already in the air,
// grouped by what has gone wrong. Kept out of TAB_ORDER so it can't be
// mistaken for something an agent sets on an order.
const SUIVI_TAB = "SUIVI";

const TOKEN_KEY = "curio-agent-token";
const NAME_KEY = "curio-agent-name";
const DA = (n: number) => (n || 0).toLocaleString("en") + " دج";

type OrderRow = {
  orderNumber: number; createdAt: string; status: string; total: number;
  customerName: string; customerPhone: string; wilayaName: string; wilayaCode: string;
  deliveryType: string; commune: string | null; officeName: string | null; officeCommune: string | null;
  callAttempts: number; lastCallAt: string | null; nextCallAt: string | null; callbackNote: string | null;
  cancelReason: string | null; trackingCode: string | null; notes: string | null;
  items: { quantity: number; product: { name: string; slug: string } }[];
  commentsCount: number; prevOrders: number; attention: boolean;
};
type EventRow = { id: string; kind: string; status: string | null; note: string | null; actor: string; createdAt: string };

const fmtDT = (s: string | null) => {
  if (!s) return "";
  const d = new Date(s);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const meta = (s: string) => STATUS_META[s as StatusKey] || { ar: s, color: "#888" };

// Little two-tone ding (WebAudio — no mp3 asset, works offline)
let audioCtx: AudioContext | null = null;
function ding() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const play = (freq: number, at: number) => {
      const o = audioCtx!.createOscillator();
      const g = audioCtx!.createGain();
      o.frequency.value = freq; o.type = "sine";
      g.gain.setValueAtTime(0.001, audioCtx!.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.24, audioCtx!.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx!.currentTime + at + 0.5);
      o.connect(g).connect(audioCtx!.destination);
      o.start(audioCtx!.currentTime + at); o.stop(audioCtx!.currentTime + at + 0.55);
    };
    play(880, 0); play(1174, 0.18);
  } catch { /* audio blocked — fine */ }
}

export default function AgentBoard() {
  const [token, setToken] = useState("");
  const [agentName, setAgentName] = useState("");
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [loginErr, setLoginErr] = useState("");

  // board state
  const [tab, setTab] = useState<string>("PENDING");
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [fWilaya, setFWilaya] = useState("");
  const [fType, setFType] = useState("");
  const [fProduct, setFProduct] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [dueNow, setDueNow] = useState(0);
  const [cancelReasons, setCancelReasons] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [err, setErr] = useState("");

  // reference data
  const [wilayas, setWilayas] = useState<{ code: number; ar: string }[]>([]);
  const [products, setProducts] = useState<{ slug: string; name: string }[]>([]);

  // modals
  const [callbackFor, setCallbackFor] = useState<OrderRow | null>(null);
  const [cbAt, setCbAt] = useState("");
  const [cbNote, setCbNote] = useState("");
  const [cancelFor, setCancelFor] = useState<OrderRow | null>(null);
  const [cReason, setCReason] = useState("");
  const [cReasonText, setCReasonText] = useState("");
  const [commentsFor, setCommentsFor] = useState<OrderRow | null>(null);
  const [thread, setThread] = useState<EventRow[]>([]);
  const [commentText, setCommentText] = useState("");
  const [busy, setBusy] = useState(false);

  // bulk ship
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [shipResults, setShipResults] = useState<{ orderNumber: number; ok: boolean; trackingCode?: string; error?: string }[] | null>(null);

  const prevPending = useRef<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const t = window.sessionStorage.getItem(TOKEN_KEY);
    if (t) { setToken(t); setAgentName(window.sessionStorage.getItem(NAME_KEY) || ""); }
  }, []);

  const buildQuery = useCallback(() => {
    const sp = new URLSearchParams();
    // SUIVI is a view, not a status. Ask for "all" so the other tabs keep
    // their live counts while the follow-up board is open — querying an
    // unknown status would blank every badge.
    sp.set("status", tab === SUIVI_TAB ? "all" : tab);
    if (q) sp.set("q", q);
    sp.set("page", String(page));
    if (fWilaya) sp.set("wilaya", fWilaya);
    if (fType) sp.set("deliveryType", fType);
    if (fProduct) sp.set("product", fProduct);
    if (fFrom) sp.set("from", fFrom);
    if (fTo) sp.set("to", fTo);
    return sp.toString();
  }, [tab, q, page, fWilaya, fType, fProduct, fFrom, fTo]);

  const load = useCallback(async (tok: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setErr("");
    try {
      const res = await fetch(`/api/agent/orders?${buildQuery()}`, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
      if (res.status === 401) { logout(); return; }
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "مشكل في التحميل"); return; }
      setOrders(j.orders || []);
      setCounts(j.counts || {});
      setPages(j.pages || 1);
      setTotal(j.total || 0);
      setDueNow(j.dueNow || 0);
      if (Array.isArray(j.cancelReasons)) setCancelReasons(j.cancelReasons);
      const pend = (j.counts || {}).PENDING || 0;
      if (prevPending.current != null && pend > prevPending.current) {
        ding();
        setToast("طلب جديد وصل!");
        setTimeout(() => setToast(""), 4000);
      }
      prevPending.current = pend;
    } catch {
      if (!opts?.silent) setErr("مشكل في الشبكة — عاودي");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => { if (token) load(token); }, [token, load]);

  // background refresh every 75s (keeps counts fresh + rings on new orders)
  useEffect(() => {
    if (!token) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (document.visibilityState === "visible") load(token, { silent: true });
    }, 75000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [token, load]);

  // reference data once
  useEffect(() => {
    if (!token) return;
    fetch("/api/delivery", { cache: "no-store" }).then((r) => r.json()).then((d) => {
      if (d?.wilayas) setWilayas(d.wilayas.map((w: { code: number; ar: string }) => ({ code: w.code, ar: w.ar })));
    }).catch(() => {});
    // Agent list, not the public one: retired products (قول بلا متقول, باك
    // العيد) must stay filterable — legacy orders holding them still need working.
    fetch("/api/agent/products", { cache: "no-store", headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json()).then((j) => {
        const ps = j?.products;
        if (Array.isArray(ps)) {
          setProducts(ps.map((p: { slug: string; name: string; active: boolean }) => ({
            slug: p.slug, name: p.active ? p.name : `${p.name} — موقّف`,
          })));
        }
      }).catch(() => {});
  }, [token]);

  async function login() {
    setLoginErr("");
    try {
      const res = await fetch("/api/agents/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.trim(), password: p }),
      });
      const j = await res.json();
      if (!res.ok || !j.token) { setLoginErr(j.error || "غلط في الدخول"); return; }
      window.sessionStorage.setItem(TOKEN_KEY, j.token);
      window.sessionStorage.setItem(NAME_KEY, j.agent?.name || "");
      setAgentName(j.agent?.name || "");
      setToken(j.token);
    } catch { setLoginErr("مشكل في الشبكة"); }
  }
  function logout() {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(NAME_KEY);
    setToken(""); setOrders([]); setU(""); setP("");
  }

  function switchTab(t: string) { setTab(t); setPage(1); setSelected(new Set()); }
  function submitSearch() { setQ(qInput.trim()); setPage(1); }

  // ── status change plumbing ──
  async function postStatus(o: OrderRow, status: string, extra?: Record<string, unknown>) {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/agent/orders/${o.orderNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "status", status, ...extra }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "فشل تغيير الحالة"); return false; }
      await load(token, { silent: true });
      return true;
    } finally { setBusy(false); }
  }

  // ── مأكد from the board → create the parcel in the same click ──
  // The board used to only save the status. Ecotrack was reachable ONLY via
  // the bulk-ship bar at the bottom, which is easy to never notice — so orders
  // confirmed from here piled up as مأكد with no parcel behind them.
  async function confirmAndShip(o: OrderRow) {
    const ok = await postStatus(o, "CONFIRMED");
    if (!ok) return;
    // We still ask once. Ecotrack has no cancel endpoint, so a mis-click here
    // would create a courier parcel we cannot take back.
    if (!window.confirm(`#${o.orderNumber} تأكد ✓ — نبعثوه لإيكوتراك دركا؟`)) {
      setErr(`#${o.orderNumber} مأكد لكن مازال ما تبعثش لإيكوتراك — كي تكوني واجدة اضغطي «ابعث لإيكوتراك» في السطر.`);
      return;
    }
    await shipOne(o);
  }

  async function shipOne(o: OrderRow) {
    setBusy(true); setErr(""); setToast("");
    try {
      const res = await fetch(`/api/agent/orders/${o.orderNumber}/ship`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (!res.ok) { setErr(`#${o.orderNumber} — ${j.error || "فشل الإرسال لإيكوتراك"}`); return; }
      setToast(`#${o.orderNumber} تبعث لإيكوتراك ✓ — ${j.trackingCode || "بلا كود تتبع"}`);
      setTimeout(() => setToast(""), 5000);
    } catch {
      setErr(`#${o.orderNumber} — مشكل في الشبكة، ما تبعثش`);
    } finally {
      setBusy(false);
      load(token, { silent: true });
    }
  }

  function onStatusPick(o: OrderRow, next: string) {
    if (next === o.status) return;
    if (next === "CONFIRMED") { confirmAndShip(o); return; }
    if (next === "CALLBACK") {
      const d = new Date(Date.now() + 3 * 3600000);
      d.setMinutes(0, 0, 0);
      setCbAt(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:00`);
      setCbNote(o.callbackNote || "");
      setCallbackFor(o);
      return;
    }
    if (next === "CANCELLED") { setCReason(""); setCReasonText(""); setCancelFor(o); return; }
    if (next === "WRONG" || next === "DUPLICATE") {
      if (!window.confirm(next === "WRONG" ? "متأكدة؟ رقم غالط / طلب مش صحيح" : "متأكدة؟ الطلب مكرر")) return;
    }
    postStatus(o, next);
  }

  async function saveCallback() {
    if (!callbackFor || !cbAt) return;
    const ok = await postStatus(callbackFor, "CALLBACK", { callbackAt: new Date(cbAt).toISOString(), callbackNote: cbNote });
    if (ok) setCallbackFor(null);
  }
  async function saveCancel() {
    if (!cancelFor) return;
    const reason = cReason === "سبب آخر" || !cReason ? (cReasonText || cReason) : cReason + (cReasonText ? ` — ${cReasonText}` : "");
    const ok = await postStatus(cancelFor, "CANCELLED", { reason });
    if (ok) setCancelFor(null);
  }

  // ── comments ──
  async function openComments(o: OrderRow) {
    setCommentsFor(o); setThread([]); setCommentText("");
    try {
      const res = await fetch(`/api/agent/orders/${o.orderNumber}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const j = await res.json();
      if (res.ok && j.order?.events) {
        setThread((j.order.events as EventRow[]).filter((e) => e.kind === "comment" || e.kind === "courier"));
      }
    } catch { /* keep empty */ }
  }
  async function addComment() {
    if (!commentsFor || !commentText.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent/orders/${commentsFor.orderNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "comment", text: commentText.trim() }),
      });
      const j = await res.json();
      if (res.ok && j.order?.events) {
        setThread((j.order.events as EventRow[]).filter((e) => e.kind === "comment" || e.kind === "courier"));
        setCommentText("");
        load(token, { silent: true });
      }
    } finally { setBusy(false); }
  }

  // ── bulk ship ──
  function toggleSel(n: number) {
    setSelected((s) => { const c = new Set(s); if (c.has(n)) c.delete(n); else c.add(n); return c; });
  }
  function toggleSelAll() {
    setSelected((s) => s.size === orders.length ? new Set<number>() : new Set(orders.map((o) => o.orderNumber)));
  }
  async function shipSelected() {
    if (!selected.size) return;
    if (!window.confirm(`تبعثي ${selected.size} طلب${selected.size > 1 ? "ات" : ""} لإيكوتراك؟`)) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/agent/ship-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ orderNumbers: Array.from(selected) }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "فشل الإرسال"); return; }
      setShipResults(j.results || []);
      setSelected(new Set());
      load(token, { silent: true });
    } finally { setBusy(false); }
  }

  // ── tracking refresh (rescue loop on demand) ──
  async function refreshTracking() {
    setBusy(true); setErr(""); setToast("");
    try {
      const res = await fetch("/api/agent/refresh-tracking", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "فشل تحديث التتبع"); return; }
      setToast(j.changed > 0 ? `تحدّث التتبع — ${j.changed} طلب تبدلت حالتو` : "تحدّث التتبع — ما كان والو جديد");
      setTimeout(() => setToast(""), 5000);
      load(token, { silent: true });
    } finally { setBusy(false); }
  }

  const isConfirmedTab = tab === "CONFIRMED";
  const now = Date.now();

  const filtersActive = useMemo(() => [fWilaya, fType, fProduct, fFrom, fTo].filter(Boolean).length, [fWilaya, fType, fProduct, fFrom, fTo]);

  if (!token) {
    return (
      <div className="ag-login">
        <div className="ag-card">
          <h1>Curio — عون التأكيد</h1>
          <input placeholder="username" value={u} onChange={(e) => setU(e.target.value)} />
          <input type="password" placeholder="كلمة السر" value={p}
            onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} />
          {loginErr && <div className="ag-err">{loginErr}</div>}
          <button onClick={login}>دخول</button>
        </div>
        <style jsx global>{styles}</style>
      </div>
    );
  }

  return (
    <div className="ab-wrap">
      <header className="ab-head">
        <div className="ab-head-r">
          <b>{agentName}</b>
          <span className="ab-sub">لوحة التأكيد</span>
          {dueNow > 0 && <span className="ab-due">يستنوا مكالمة: {dueNow}</span>}
        </div>
        <div className="ab-head-l">
          <button className="ab-ghost" disabled={busy} onClick={refreshTracking} title="يجيب آخر حالات التوصيل من إيكوتراك">تحديث التتبع</button>
          <button className="ab-ghost" onClick={() => load(token)}>تحديث</button>
          <button className="ab-ghost" onClick={logout}>خروج</button>
        </div>
      </header>

      {toast && <div className="ab-toast">{toast}</div>}
      {err && <div className="ab-err" onClick={() => setErr("")}>{err}</div>}

      <div className="ab-searchrow">
        <input
          className="ab-search"
          placeholder="ابحثي: اسم، رقم هاتف، ولاية، بلدية، رقم طلب…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitSearch()}
        />
        <button className="ab-btn" onClick={submitSearch}>بحث</button>
        {q && <button className="ab-ghost" onClick={() => { setQ(""); setQInput(""); setPage(1); }}>مسح</button>}
        <button className={`ab-ghost ${showFilters || filtersActive ? "ab-on" : ""}`} onClick={() => setShowFilters((v) => !v)}>
          فلاتر{filtersActive ? ` (${filtersActive})` : ""}
        </button>
      </div>

      {showFilters && (
        <div className="ab-filters">
          <label>الولاية
            <select value={fWilaya} onChange={(e) => { setFWilaya(e.target.value); setPage(1); }}>
              <option value="">الكل</option>
              {wilayas.map((w) => <option key={w.code} value={String(w.code)}>{(w.code < 10 ? "0" + w.code : w.code) + " - " + w.ar}</option>)}
            </select>
          </label>
          <label>التوصيل
            <select value={fType} onChange={(e) => { setFType(e.target.value); setPage(1); }}>
              <option value="">الكل</option>
              <option value="HOME">للدار</option>
              <option value="OFFICE">مكتب</option>
            </select>
          </label>
          <label>المنتج
            <select value={fProduct} onChange={(e) => { setFProduct(e.target.value); setPage(1); }}>
              <option value="">الكل</option>
              {products.map((pr) => <option key={pr.slug} value={pr.slug}>{pr.name}</option>)}
            </select>
          </label>
          <label>من
            <input type="date" value={fFrom} onChange={(e) => { setFFrom(e.target.value); setPage(1); }} />
          </label>
          <label>حتى
            <input type="date" value={fTo} onChange={(e) => { setFTo(e.target.value); setPage(1); }} />
          </label>
          {filtersActive > 0 && (
            <button className="ab-ghost" onClick={() => { setFWilaya(""); setFType(""); setFProduct(""); setFFrom(""); setFTo(""); setPage(1); }}>مسح الفلاتر</button>
          )}
        </div>
      )}

      <div className="ab-tabs">
        <button className={`ab-tab ${tab === "all" ? "on" : ""}`} style={tab === "all" ? { background: "#161310", color: "#fff" } : undefined} onClick={() => switchTab("all")}>
          الكل{counts.ALL ? <span className="ab-count">{counts.ALL}</span> : null}
        </button>
        <button className={`ab-tab ${tab === SUIVI_TAB ? "on" : ""}`}
          style={tab === SUIVI_TAB ? { background: "#0f766e", color: "#fff", borderColor: "#0f766e" } : undefined}
          onClick={() => switchTab(SUIVI_TAB)}>
          <i className="ab-dot" style={{ background: "#0f766e" }} />
          المتابعة
        </button>
        {TAB_ORDER.map((s) => {
          const m = meta(s);
          const c = counts[s] || 0;
          const on = tab === s;
          return (
            <button key={s} className={`ab-tab ${on ? "on" : ""}`}
              style={on ? { background: m.color, color: "#fff", borderColor: m.color } : undefined}
              onClick={() => switchTab(s)}>
              <i className="ab-dot" style={{ background: m.color }} />
              {m.ar}
              {c > 0 && <span className="ab-count">{c}</span>}
            </button>
          );
        })}
      </div>

      {/* The follow-up board replaces the orders table — it reads its own
          endpoint (cached parcels) and has nothing to do with the status
          tabs' pagination, filters or bulk selection. */}
      {tab === SUIVI_TAB && <SuiviBoard token={token} />}

      {tab !== SUIVI_TAB && loading && <div className="ab-info">يحمّل…</div>}
      {tab !== SUIVI_TAB && !loading && orders.length === 0 && <div className="ab-info">ماكانش طلبات هنا</div>}

      {tab !== SUIVI_TAB && !loading && orders.length > 0 && (
        <div className="ab-tablewrap">
          <table className="ab-table">
            <thead>
              <tr>
                {isConfirmedTab && (
                  <th className="ab-ck">
                    <input type="checkbox" checked={selected.size === orders.length && orders.length > 0} onChange={toggleSelAll} />
                  </th>
                )}
                <th>الطلب</th>
                <th>الزبون</th>
                <th>المنتجات</th>
                <th>التوصيل</th>
                <th>الإجمالي</th>
                <th className="ab-th-status">الحالة</th>
                <th>أعمال</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const m = meta(o.status);
                const editable = !POST_SHIP_STATUSES.includes(o.status as StatusKey);
                const overdue = o.nextCallAt && new Date(o.nextCallAt).getTime() <= now;
                return (
                  <tr key={o.orderNumber} className={o.attention ? "ab-attn" : ""}>
                    {isConfirmedTab && (
                      <td className="ab-ck">
                        <input type="checkbox" checked={selected.has(o.orderNumber)} onChange={() => toggleSel(o.orderNumber)} />
                      </td>
                    )}
                    <td data-l="الطلب">
                      <div className="ab-num">
                        {o.attention && <span className="ab-ping" style={{ background: m.color }} />}
                        <a href={`/agent/order/${o.orderNumber}`}><b>#{o.orderNumber}</b></a>
                      </div>
                      <div className="ab-dim">{fmtDT(o.createdAt)}</div>
                    </td>
                    <td data-l="الزبون">
                      <div className="ab-cname">{o.customerName}</div>
                      <div className="ab-phone" dir="ltr">{o.customerPhone}</div>
                      <div className="ab-dim">{o.wilayaName}{(o.commune || o.officeCommune) ? ` · ${o.commune || o.officeCommune}` : ""}</div>
                      {o.prevOrders > 0 && <span className="ab-chip ab-chip-prev">زبون قديم · {o.prevOrders} طلبات قبل</span>}
                    </td>
                    <td data-l="المنتجات">
                      {o.items.map((i, ix) => (
                        <div key={ix} className="ab-item">{i.product.name}{i.quantity > 1 ? ` ×${i.quantity}` : ""}</div>
                      ))}
                    </td>
                    <td data-l="التوصيل">
                      <div>{o.deliveryType === "OFFICE" ? "مكتب" : "للدار"}</div>
                      {o.trackingCode && <div className="ab-track" dir="ltr">{o.trackingCode}</div>}
                    </td>
                    <td data-l="الإجمالي"><span className="ab-total">{DA(o.total)}</span></td>
                    <td data-l="الحالة" className="ab-td-status">
                      {editable ? (
                        <select
                          className="ab-status"
                          style={{ background: m.color }}
                          value={AGENT_SET_STATUSES.includes(o.status as StatusKey) ? o.status : ""}
                          disabled={busy}
                          onChange={(e) => onStatusPick(o, e.target.value)}
                        >
                          {!AGENT_SET_STATUSES.includes(o.status as StatusKey) && <option value="">{m.ar}</option>}
                          {AGENT_SET_STATUSES.map((s) => (
                            <option key={s} value={s}>{meta(s).ar}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="ab-status ab-status-fixed" style={{ background: m.color }}>{m.ar}</span>
                      )}
                      {o.status === "NO_ANSWER" && (
                        <button className="ab-mini ab-mini-red" disabled={busy} onClick={() => postStatus(o, "NO_ANSWER")}>
                          محاولة جديدة ({o.callAttempts}/{MAX_CALL_ATTEMPTS})
                        </button>
                      )}
                      {o.status === "CALLBACK" && o.nextCallAt && (
                        <div className={`ab-cb ${overdue ? "ab-cb-due" : ""}`}>
                          {overdue ? "راهو وقتها: " : "معاودة: "}{fmtDT(o.nextCallAt)}
                          {o.callbackNote ? <div className="ab-dim">{o.callbackNote}</div> : null}
                        </div>
                      )}
                      {o.status === "CANCELLED" && o.cancelReason && <div className="ab-dim">{o.cancelReason}</div>}
                      {o.status === "EXPIRED" && <div className="ab-dim">{o.callAttempts} محاولات</div>}
                      {/* A confirmed order with no tracking code has NO parcel at
                          Ecotrack. Say so on the row and make the rescue one click. */}
                      {o.status === "CONFIRMED" && !o.trackingCode && (
                        <>
                          <div className="ab-nosend">ما تبعثش لإيكوتراك</div>
                          <button className="ab-mini ab-mini-blue" disabled={busy} onClick={() => shipOne(o)}>ابعث لإيكوتراك</button>
                        </>
                      )}
                    </td>
                    <td data-l="أعمال">
                      <div className="ab-actions">
                        <a className="ab-mini" href={`/agent/order/${o.orderNumber}`}>فتح</a>
                        <button className="ab-mini ab-rel" onClick={() => openComments(o)}>
                          تعليقات
                          {o.commentsCount > 0 && <span className="ab-badge">{o.commentsCount}</span>}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab !== SUIVI_TAB && !loading && pages > 1 && (
        <div className="ab-pager">
          <button className="ab-ghost" disabled={page <= 1} onClick={() => setPage((p2) => p2 - 1)}>السابق</button>
          <span>صفحة {page} من {pages} — {total} طلب</span>
          <button className="ab-ghost" disabled={page >= pages} onClick={() => setPage((p2) => p2 + 1)}>التالي</button>
        </div>
      )}

      {isConfirmedTab && selected.size > 0 && (
        <div className="ab-shipbar">
          <span>{selected.size} مختار</span>
          <button className="ab-ship" disabled={busy} onClick={shipSelected}>ابعث المختارين لإيكوتراك</button>
        </div>
      )}

      {/* ── callback modal ── */}
      {callbackFor && (
        <div className="ab-overlay" onClick={() => setCallbackFor(null)}>
          <div className="ab-modal" onClick={(e) => e.stopPropagation()}>
            <h3>معاودة الاتصال — طلب #{callbackFor.orderNumber}</h3>
            <label>وقتاش نعاودو؟
              <input type="datetime-local" value={cbAt} onChange={(e) => setCbAt(e.target.value)} />
            </label>
            <label>ملاحظة (واش قال الزبون؟)
              <input value={cbNote} onChange={(e) => setCbNote(e.target.value)} placeholder="مثلا: عيّطلي بعد السادسة" />
            </label>
            <div className="ab-modal-btns">
              <button className="ab-btn" disabled={busy || !cbAt} onClick={saveCallback}>سجلي المعاودة</button>
              <button className="ab-ghost" onClick={() => setCallbackFor(null)}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* ── cancel-reason modal ── */}
      {cancelFor && (
        <div className="ab-overlay" onClick={() => setCancelFor(null)}>
          <div className="ab-modal" onClick={(e) => e.stopPropagation()}>
            <h3>علاش تلغى؟ — طلب #{cancelFor.orderNumber}</h3>
            <div className="ab-reasons">
              {cancelReasons.map((r) => (
                <button key={r} className={`ab-reason ${cReason === r ? "on" : ""}`} onClick={() => setCReason(r)}>{r}</button>
              ))}
            </div>
            <label>تفاصيل زايدة (اختياري)
              <input value={cReasonText} onChange={(e) => setCReasonText(e.target.value)} />
            </label>
            <div className="ab-modal-btns">
              <button className="ab-btn ab-danger" disabled={busy || (!cReason && !cReasonText)} onClick={saveCancel}>ألغي الطلب</button>
              <button className="ab-ghost" onClick={() => setCancelFor(null)}>رجوع</button>
            </div>
          </div>
        </div>
      )}

      {/* ── comments modal ── */}
      {commentsFor && (
        <div className="ab-overlay" onClick={() => setCommentsFor(null)}>
          <div className="ab-modal" onClick={(e) => e.stopPropagation()}>
            <h3>تعليقات — طلب #{commentsFor.orderNumber}</h3>
            <div className="ab-thread">
              {thread.length === 0 && <div className="ab-dim">ما كان حتى تعليق</div>}
              {thread.map((e) => (
                <div key={e.id} className={`ab-cmt ${e.kind === "courier" ? "ab-cmt-courier" : ""}`}>
                  <div className="ab-cmt-head">
                    <b>{e.kind === "courier" ? "الموصّل (إيكوتراك)" : e.actor}</b>
                    <span className="ab-dim">{fmtDT(e.createdAt)}</span>
                  </div>
                  <div>{e.note}</div>
                </div>
              ))}
            </div>
            <div className="ab-cmt-add">
              <input value={commentText} onChange={(e) => setCommentText(e.target.value)}
                placeholder="اكتبي تعليق…" onKeyDown={(e) => e.key === "Enter" && addComment()} />
              <button className="ab-btn" disabled={busy || !commentText.trim()} onClick={addComment}>زيدي</button>
            </div>
          </div>
        </div>
      )}

      {/* ── bulk ship results ── */}
      {shipResults && (
        <div className="ab-overlay" onClick={() => setShipResults(null)}>
          <div className="ab-modal" onClick={(e) => e.stopPropagation()}>
            <h3>نتيجة الإرسال لإيكوتراك</h3>
            <div className="ab-thread">
              {shipResults.map((r) => (
                <div key={r.orderNumber} className={`ab-cmt ${r.ok ? "ab-cmt-ok" : "ab-cmt-bad"}`}>
                  <b>#{r.orderNumber}</b> — {r.ok ? `تبعث ✓ ${r.trackingCode ? `(${r.trackingCode})` : ""}` : `فشل: ${r.error}`}
                </div>
              ))}
            </div>
            <div className="ab-modal-btns">
              <button className="ab-btn" onClick={() => setShipResults(null)}>تمام</button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{styles}</style>
    </div>
  );
}

const styles = `
  :root{--ink:#161310;--paper:#fbf6ec;--card:#fffdf7;--dim:#675b4c}
  body{background:var(--paper)}
  .ag-login{min-height:100vh;display:grid;place-items:center;background:var(--paper);direction:rtl;font-family:system-ui,sans-serif}
  .ag-card{background:#fff;border:2px solid var(--ink);border-radius:18px;box-shadow:6px 6px 0 var(--ink);padding:28px;width:min(92vw,360px);text-align:center}
  .ag-card h1{font-size:1.3rem;margin:0 0 16px}
  .ag-card input{width:100%;border:2px solid var(--ink);border-radius:10px;padding:12px;font-size:1rem;margin-bottom:10px}
  .ag-card button{cursor:pointer;font-weight:800;background:#5cb335;color:#fff;border:2px solid var(--ink);border-radius:10px;padding:12px 18px;font-size:1rem;box-shadow:3px 3px 0 var(--ink);width:100%}
  .ag-err{color:#ec2c24;font-weight:700;margin-bottom:10px}

  .ab-wrap{max-width:1280px;margin:0 auto;padding:14px 14px 90px;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;color:var(--ink);direction:rtl}
  .ab-head{display:flex;justify-content:space-between;align-items:center;gap:10px;border-bottom:2px solid var(--ink);padding-bottom:10px;margin-bottom:12px;flex-wrap:wrap}
  .ab-head b{font-size:1.1rem}
  .ab-head-r{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .ab-head-l{display:flex;gap:8px}
  .ab-sub{color:var(--dim);font-size:.82rem}
  .ab-due{background:#dc2626;color:#fff;border:2px solid var(--ink);border-radius:999px;font-size:.75rem;font-weight:800;padding:3px 10px}
  .ab-ghost{background:#fff;border:2px solid var(--ink);border-radius:9px;padding:7px 12px;font-size:.83rem;font-weight:800;cursor:pointer;white-space:nowrap}
  .ab-ghost:disabled{opacity:.5;cursor:default}
  .ab-ghost.ab-on{background:#facc15}
  .ab-btn{background:#161310;color:#fff;border:2px solid var(--ink);border-radius:9px;padding:8px 16px;font-weight:800;cursor:pointer;font-size:.9rem}
  .ab-btn:disabled{opacity:.5;cursor:default}
  .ab-btn.ab-danger{background:#dc2626}
  .ab-toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#161310;color:#fff;font-weight:800;border-radius:12px;padding:10px 20px;z-index:60;box-shadow:4px 4px 0 rgba(0,0,0,.25)}
  .ab-err{background:#fdeeee;border:2px solid #ec2c24;border-radius:10px;padding:10px 14px;margin:8px 0;font-weight:700;color:#b52c35;cursor:pointer}
  .ab-info{color:var(--dim);padding:30px 0;text-align:center;font-weight:700}

  .ab-searchrow{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}
  .ab-search{flex:1;min-width:220px;border:2px solid var(--ink);border-radius:10px;padding:10px 12px;font-size:.95rem;font-family:inherit;background:#fff}
  .ab-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:end;background:var(--card);border:2px solid var(--ink);border-radius:12px;box-shadow:3px 3px 0 var(--ink);padding:10px 12px;margin-bottom:10px}
  .ab-filters label{display:flex;flex-direction:column;gap:4px;font-size:.75rem;font-weight:800;color:var(--dim)}
  .ab-filters select,.ab-filters input{border:1.5px solid #cbbfa8;border-radius:8px;padding:7px 9px;font-size:.88rem;background:#fff;font-family:inherit;min-width:130px}

  .ab-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:10px;scrollbar-width:thin}
  .ab-tab{display:inline-flex;align-items:center;gap:6px;background:#fff;border:2px solid var(--ink);border-radius:999px;padding:7px 12px;font-weight:800;font-size:.82rem;cursor:pointer;white-space:nowrap;color:var(--ink)}
  .ab-tab.on{box-shadow:2px 2px 0 var(--ink)}
  .ab-dot{width:9px;height:9px;border-radius:50%;display:inline-block}
  .ab-tab.on .ab-dot{background:#fff!important}
  .ab-count{background:rgba(0,0,0,.14);border-radius:999px;font-size:.72rem;padding:1px 7px;font-weight:800}
  .ab-tab.on .ab-count{background:rgba(255,255,255,.28)}

  .ab-tablewrap{overflow-x:auto;border:2px solid var(--ink);border-radius:14px;background:var(--card);box-shadow:4px 4px 0 var(--ink)}
  .ab-table{width:100%;border-collapse:collapse;font-size:.88rem}
  .ab-table th{background:#f3ece0;text-align:right;padding:10px 12px;font-size:.78rem;border-bottom:2px solid var(--ink);white-space:nowrap;position:sticky;top:0}
  .ab-table td{padding:10px 12px;border-bottom:1px solid #e7ddc9;vertical-align:top}
  .ab-table tr:last-child td{border-bottom:none}
  .ab-table tr.ab-attn{background:#fff7ed}
  .ab-ck{width:34px;text-align:center}
  .ab-ck input{width:17px;height:17px;cursor:pointer}
  .ab-num{display:flex;align-items:center;gap:7px}
  .ab-num a{color:var(--ink);text-decoration:none}
  .ab-num a:hover{text-decoration:underline}
  .ab-ping{width:10px;height:10px;border-radius:50%;display:inline-block;animation:abping 1.2s ease-in-out infinite}
  @keyframes abping{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(1.35)}}
  .ab-dim{color:var(--dim);font-size:.78rem;margin-top:2px}
  .ab-cname{font-weight:800}
  .ab-phone{font-family:ui-monospace,monospace;font-size:.85rem}
  .ab-chip{display:inline-block;font-size:.68rem;font-weight:800;border-radius:999px;padding:2px 8px;margin-top:4px;border:1.5px solid var(--ink)}
  .ab-chip-prev{background:#e0edff}
  .ab-item{white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
  .ab-track{font-family:ui-monospace,monospace;font-size:.75rem;color:var(--dim);margin-top:2px}
  .ab-total{font-weight:800;font-family:ui-monospace,monospace;white-space:nowrap}
  .ab-th-status{min-width:150px}
  .ab-td-status{min-width:150px}
  .ab-status{display:block;width:100%;color:#fff;font-weight:800;border:2px solid var(--ink);border-radius:9px;padding:7px 8px;font-size:.8rem;cursor:pointer;font-family:inherit}
  .ab-status option{background:#fff;color:var(--ink)}
  .ab-status-fixed{text-align:center;cursor:default}
  .ab-mini{display:inline-block;background:#fff;border:2px solid var(--ink);border-radius:8px;padding:5px 9px;font-size:.74rem;font-weight:800;cursor:pointer;margin-top:6px;text-decoration:none;color:var(--ink);white-space:nowrap}
  .ab-mini-red{background:#dc2626;color:#fff;width:100%;text-align:center}
  .ab-mini-blue{background:#2aa9e0;color:#fff;width:100%;text-align:center}
  .ab-nosend{margin-top:6px;font-size:.72rem;font-weight:800;color:#b91c1c}
  .ab-rel{position:relative}
  .ab-badge{position:absolute;top:-8px;left:-7px;background:#dc2626;color:#fff;border-radius:999px;font-size:.62rem;padding:1px 6px;font-weight:800}
  .ab-cb{font-size:.76rem;font-weight:700;margin-top:6px;background:#f3e8ff;border:1.5px solid #8b5cf6;border-radius:8px;padding:4px 8px}
  .ab-cb-due{background:#fee2e2;border-color:#dc2626}
  .ab-actions{display:flex;gap:8px;align-items:flex-start}

  .ab-pager{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:14px;font-weight:700;font-size:.88rem}
  .ab-shipbar{position:fixed;bottom:0;right:0;left:0;background:#161310;color:#fff;display:flex;justify-content:center;align-items:center;gap:16px;padding:12px;z-index:50;font-weight:800}
  .ab-ship{background:#2aa9e0;color:#fff;border:2px solid #fff;border-radius:10px;padding:10px 22px;font-weight:800;font-size:1rem;cursor:pointer}
  .ab-ship:disabled{opacity:.5}

  .ab-overlay{position:fixed;inset:0;background:rgba(22,19,16,.45);z-index:70;display:grid;place-items:center;padding:16px}
  .ab-modal{background:#fff;border:2px solid var(--ink);border-radius:16px;box-shadow:6px 6px 0 var(--ink);padding:20px;width:min(94vw,460px);max-height:86vh;overflow-y:auto;direction:rtl}
  .ab-modal h3{margin:0 0 14px;font-size:1.05rem}
  .ab-modal label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;font-weight:800;color:var(--dim);margin-bottom:12px}
  .ab-modal input{border:1.5px solid #cbbfa8;border-radius:9px;padding:10px;font-size:.95rem;font-family:inherit;background:#fff}
  .ab-modal-btns{display:flex;gap:10px;margin-top:6px}
  .ab-reasons{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
  .ab-reason{background:#fff;border:2px solid var(--ink);border-radius:999px;padding:7px 12px;font-size:.8rem;font-weight:800;cursor:pointer}
  .ab-reason.on{background:#dc2626;color:#fff}
  .ab-thread{display:grid;gap:8px;margin-bottom:12px;max-height:44vh;overflow-y:auto}
  .ab-cmt{background:var(--card);border:1.5px solid #cbbfa8;border-radius:10px;padding:8px 12px;font-size:.86rem}
  .ab-cmt-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:3px}
  .ab-cmt-courier{background:#fff7ed;border-color:#f59e0b}
  .ab-cmt-ok{background:#eaf7e6;border-color:#5cb335}
  .ab-cmt-bad{background:#fdeeee;border-color:#ec2c24}
  .ab-cmt-add{display:flex;gap:8px}
  .ab-cmt-add input{flex:1;border:1.5px solid #cbbfa8;border-radius:9px;padding:10px;font-size:.92rem;font-family:inherit}

  @media (max-width: 760px){
    .ab-table thead{display:none}
    .ab-table, .ab-table tbody, .ab-table tr, .ab-table td{display:block;width:100%}
    .ab-table tr{border-bottom:2px solid var(--ink);padding:10px 4px}
    .ab-table td{border-bottom:none;padding:5px 10px}
    .ab-table td[data-l]::before{content:attr(data-l);display:block;font-size:.68rem;color:var(--dim);font-weight:800;margin-bottom:2px}
    .ab-td-status{max-width:280px}
    .ab-ck{display:flex!important;justify-content:flex-start}
  }
`;
