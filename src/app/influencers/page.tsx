"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ─── The Influencer Window ──────────────────────────────────
// One screen: every influencer, their deal, their orders funnel,
// what they cost us, owed vs paid — and the keep-or-drop number
// (cost per delivered order). Same admin key as the Command Center.

const ADMIN_KEY_STORAGE = "curio-admin-key";

interface Payment {
  id: string;
  amount: number;
  note: string | null;
  paidAt: string;
}
interface Stats {
  placed: number;
  junk: number;
  confirmed: number;
  delivered: number;
  returned: number;
  cancelled: number;
  inFlight: number;
  countedOrders: number;
  countedUnits: number;
  revenueDelivered: number;
  discountCost: number;
  commissionOwed: number;
  fixedFee: number;
  owedTotal: number;
  paidTotal: number;
  balance: number;
  totalCost: number;
  costPerDelivered: number | null;
  lastOrderAt: string | null;
}
interface Influencer {
  id: string;
  name: string;
  handle: string | null;
  platform: string | null;
  phone: string | null;
  couponCode: string;
  active: boolean;
  customerDiscount: number;
  applicableSlugs: string[];
  commissionRate: number;
  commissionBasis: string;
  countTrigger: string;
  fixedFee: number;
  shareToken: string;
  notes: string | null;
  createdAt: string;
  payments: Payment[];
  stats: Stats;
}
interface DetailOrder {
  orderNumber: number;
  status: string;
  customerName: string;
  wilayaName: string;
  total: number;
  couponDiscount: number;
  createdAt: string;
  items: { quantity: number; product: { name: string; slug: string } | null }[];
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  PENDING: { text: "Pending", cls: "s-wait" },
  CONFIRMED: { text: "Confirmed", cls: "s-ok" },
  PROCESSING: { text: "Confirmed", cls: "s-ok" },
  SHIPPED: { text: "Shipped", cls: "s-ship" },
  OUT_FOR_DELIVERY: { text: "Out for delivery", cls: "s-ship" },
  AT_STOPDESK: { text: "At stop-desk", cls: "s-ship" },
  DELIVERY_FAILED: { text: "Delivery failed", cls: "s-warn" },
  DELIVERED: { text: "Delivered", cls: "s-good" },
  IN_RETURN: { text: "Coming back", cls: "s-bad" },
  RETURNED: { text: "Returned", cls: "s-bad" },
  CANCELLED: { text: "Cancelled", cls: "s-off" },
  EXPIRED: { text: "Expired", cls: "s-off" },
  NO_ANSWER: { text: "No answer", cls: "s-wait" },
  CALLBACK: { text: "Callback", cls: "s-wait" },
  WRONG: { text: "Wrong number", cls: "s-off" },
  DUPLICATE: { text: "Duplicate", cls: "s-off" },
};

const EMPTY_FORM = {
  name: "",
  handle: "",
  platform: "instagram",
  phone: "",
  couponCode: "",
  customerDiscount: "200",
  commissionRate: "0",
  commissionBasis: "ORDER",
  countTrigger: "CONFIRMED",
  fixedFee: "0",
  notes: "",
};
type FormState = typeof EMPTY_FORM;

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
function dstr(s: string): string {
  return new Date(s).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
  });
}

export default function InfluencersPage() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [rows, setRows] = useState<Influencer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  // add / edit form
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  // detail drawer
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailOrders, setDetailOrders] = useState<DetailOrder[] | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payNote, setPayNote] = useState("");

  const detail = useMemo(
    () => rows?.find((r) => r.id === detailId) ?? null,
    [rows, detailId]
  );

  function ping(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(""), 2600);
  }

  const fetchData = useCallback(async (key: string) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/influencers", {
        headers: { "x-admin-key": key },
        cache: "no-store",
      });
      if (res.status === 401) {
        window.localStorage.removeItem(ADMIN_KEY_STORAGE);
        setAdminKey("");
        setLoginError(true);
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      setRows(json.influencers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);
  useEffect(() => {
    if (adminKey) fetchData(adminKey);
  }, [adminKey, fetchData]);

  function tryLogin() {
    if (!keyInput.trim()) return;
    window.localStorage.setItem(ADMIN_KEY_STORAGE, keyInput.trim());
    setLoginError(false);
    setAdminKey(keyInput.trim());
  }
  function logout() {
    window.localStorage.removeItem(ADMIN_KEY_STORAGE);
    setAdminKey("");
    setRows(null);
  }

  async function api(path: string, method: string, body?: unknown) {
    const res = await fetch(path, {
      method,
      headers: {
        "x-admin-key": adminKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "HTTP " + res.status);
    return json;
  }

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowForm(true);
  }
  function openEdit(inf: Influencer) {
    setEditingId(inf.id);
    setForm({
      name: inf.name,
      handle: inf.handle ?? "",
      platform: inf.platform ?? "instagram",
      phone: inf.phone ?? "",
      couponCode: inf.couponCode,
      customerDiscount: String(inf.customerDiscount),
      commissionRate: String(inf.commissionRate),
      commissionBasis: inf.commissionBasis,
      countTrigger: inf.countTrigger,
      fixedFee: String(inf.fixedFee),
      notes: inf.notes ?? "",
    });
    setFormError("");
    setShowForm(true);
  }

  async function submitForm() {
    setSaving(true);
    setFormError("");
    try {
      const payload = {
        name: form.name,
        handle: form.handle,
        platform: form.platform,
        phone: form.phone,
        couponCode: form.couponCode,
        customerDiscount: form.customerDiscount,
        commissionRate: form.commissionRate,
        commissionBasis: form.commissionBasis,
        countTrigger: form.countTrigger,
        fixedFee: form.fixedFee,
        notes: form.notes,
      };
      if (editingId) {
        await api("/api/influencers/" + editingId, "PATCH", payload);
        ping("Saved ✓");
      } else {
        await api("/api/influencers", "POST", payload);
        ping("Influencer added ✓");
      }
      setShowForm(false);
      await fetchData(adminKey);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "failed");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(inf: Influencer) {
    try {
      await api("/api/influencers/" + inf.id, "PATCH", { active: !inf.active });
      ping(inf.active ? "Code paused" : "Code active ✓");
      await fetchData(adminKey);
    } catch (e) {
      ping(e instanceof Error ? e.message : "failed");
    }
  }

  const openDetail = useCallback(
    async (id: string) => {
      setDetailId(id);
      setDetailOrders(null);
      try {
        const json = await api("/api/influencers/" + id + "/orders", "GET");
        setDetailOrders(json.orders);
      } catch {
        setDetailOrders([]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adminKey]
  );

  async function addPayment() {
    if (!detail) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      ping("Enter a valid amount");
      return;
    }
    try {
      await api("/api/influencers/" + detail.id + "/payments", "POST", {
        amount,
        note: payNote,
      });
      setPayAmount("");
      setPayNote("");
      ping("Payment logged ✓");
      await fetchData(adminKey);
    } catch (e) {
      ping(e instanceof Error ? e.message : "failed");
    }
  }

  async function removePayment(paymentId: string) {
    if (!detail) return;
    try {
      await api(
        "/api/influencers/" + detail.id + "/payments?paymentId=" + paymentId,
        "DELETE"
      );
      ping("Payment removed");
      await fetchData(adminKey);
    } catch (e) {
      ping(e instanceof Error ? e.message : "failed");
    }
  }

  function copyLink(inf: Influencer) {
    const url = window.location.origin + "/i/" + inf.shareToken;
    navigator.clipboard.writeText(url).then(
      () => ping("Private link copied ✓ — send it to " + inf.name),
      () => ping(url)
    );
  }

  const totals = useMemo(() => {
    if (!rows) return null;
    const t = {
      influencers: rows.length,
      active: rows.filter((r) => r.active).length,
      placed: 0,
      delivered: 0,
      owed: 0,
      paid: 0,
      cost: 0,
      revenue: 0,
    };
    for (const r of rows) {
      t.placed += r.stats.placed;
      t.delivered += r.stats.delivered;
      t.owed += r.stats.owedTotal;
      t.paid += r.stats.paidTotal;
      t.cost += r.stats.totalCost;
      t.revenue += r.stats.revenueDelivered;
    }
    return t;
  }, [rows]);

  // ─── LOGIN ───
  if (!adminKey) {
    return (
      <div className="iw" dir="ltr">
        <Style />
        <div className="iw-login">
          <div className="iw-card iw-login-card">
            <div className="iw-logo">Curio</div>
            <h1>Influencer Window</h1>
            <p className="iw-muted">Enter your admin key (same as the Command Center).</p>
            <input
              className="iw-input"
              type="password"
              placeholder="Admin key"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryLogin()}
              autoFocus
            />
            {loginError && <div className="iw-err">Wrong key — try again.</div>}
            <button className="iw-btn iw-primary iw-wfull" onClick={tryLogin}>
              Open the window
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="iw" dir="ltr">
      <Style />
      <header className="iw-bar">
        <div>
          <span className="iw-brand">Curio</span>
          <span className="iw-bar-sub">Influencer Window</span>
        </div>
        <div className="iw-bar-r">
          <button className="iw-btn" onClick={() => fetchData(adminKey)} disabled={loading}>
            {loading ? "…" : "↻ Refresh"}
          </button>
          <button className="iw-btn iw-primary" onClick={openAdd}>
            + Add influencer
          </button>
          <button className="iw-btn" onClick={logout}>
            Logout
          </button>
        </div>
      </header>

      <div className="iw-wrap">
        {error && <div className="iw-err">Could not load: {error}</div>}

        {totals && (
          <div className="iw-strip">
            <div className="iw-num">
              <b>{totals.active}</b>
              <span>active / {totals.influencers} total</span>
            </div>
            <div className="iw-num">
              <b>{fmt(totals.placed)}</b>
              <span>orders via codes</span>
            </div>
            <div className="iw-num">
              <b>{fmt(totals.delivered)}</b>
              <span>delivered</span>
            </div>
            <div className="iw-num">
              <b>{fmt(totals.revenue)}</b>
              <span>revenue delivered (DA)</span>
            </div>
            <div className="iw-num">
              <b>{fmt(totals.cost)}</b>
              <span>total cost (DA)</span>
            </div>
            <div className="iw-num iw-hot">
              <b>{fmt(totals.owed - totals.paid)}</b>
              <span>unpaid balance (DA)</span>
            </div>
          </div>
        )}

        {rows && rows.length === 0 && (
          <div className="iw-card iw-empty">
            <h3>No influencers yet</h3>
            <p className="iw-muted">
              Click <b>+ Add influencer</b> to create the first one. Each gets a
              personal coupon code — every order that types it lands here
              automatically.
            </p>
          </div>
        )}

        {rows && rows.length > 0 && (
          <div className="iw-card iw-tablewrap">
            <table className="iw-table">
              <thead>
                <tr>
                  <th>Influencer</th>
                  <th>Code</th>
                  <th>Deal</th>
                  <th className="r">Placed</th>
                  <th className="r">Confirmed</th>
                  <th className="r">Delivered</th>
                  <th className="r">Returned</th>
                  <th className="r">Owed</th>
                  <th className="r">Paid</th>
                  <th className="r">Balance</th>
                  <th className="r">Cost / delivered</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.active ? "" : "iw-rowoff"}>
                    <td>
                      <b>{r.name}</b>
                      <span className="iw-sub">
                        {r.platform || ""} {r.handle ? "· " + r.handle : ""}
                        {!r.active && " · PAUSED"}
                      </span>
                    </td>
                    <td>
                      <code className="iw-code">{r.couponCode}</code>
                      {r.customerDiscount > 0 && (
                        <span className="iw-sub">−{fmt(r.customerDiscount)} DA for customer</span>
                      )}
                    </td>
                    <td>
                      <span className="iw-sub">
                        {r.commissionRate > 0
                          ? fmt(r.commissionRate) +
                            " DA / " +
                            (r.commissionBasis === "UNIT" ? "game" : "order") +
                            " · counts " +
                            (r.countTrigger === "PLACED" ? "placed" : "confirmed")
                          : "no commission"}
                        {r.fixedFee > 0 ? " · fixed " + fmt(r.fixedFee) + " DA" : ""}
                      </span>
                    </td>
                    <td className="r">{fmt(r.stats.placed)}</td>
                    <td className="r">{fmt(r.stats.confirmed)}</td>
                    <td className="r iw-good">{fmt(r.stats.delivered)}</td>
                    <td className="r iw-bad">{fmt(r.stats.returned)}</td>
                    <td className="r">{fmt(r.stats.owedTotal)}</td>
                    <td className="r">{fmt(r.stats.paidTotal)}</td>
                    <td className={"r " + (r.stats.balance > 0 ? "iw-hotcell" : "")}>
                      {fmt(r.stats.balance)}
                    </td>
                    <td className="r">
                      {r.stats.costPerDelivered === null ? (
                        <span className="iw-muted">—</span>
                      ) : (
                        <b
                          className={
                            r.stats.costPerDelivered > 500 ? "iw-bad" : "iw-good"
                          }
                        >
                          {fmt(r.stats.costPerDelivered)}
                        </b>
                      )}
                    </td>
                    <td className="iw-actions">
                      <button className="iw-btn iw-sm" onClick={() => openDetail(r.id)}>
                        Details
                      </button>
                      <button className="iw-btn iw-sm" onClick={() => copyLink(r)}>
                        Their link
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="iw-tiny iw-muted">
              Cost / delivered = (commission + fixed fee + customer discounts on
              delivered orders) ÷ delivered orders. Green under 500 DA (your ad
              target), red above — the keep-or-drop number.
            </p>
          </div>
        )}
      </div>

      {/* ─── ADD / EDIT FORM ─── */}
      {showForm && (
        <div className="iw-overlay" onClick={() => setShowForm(false)}>
          <div className="iw-card iw-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingId ? "Edit influencer" : "New influencer"}</h3>
            <div className="iw-grid2">
              <label>
                Name*
                <input className="iw-input" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label>
                Handle (@username)
                <input className="iw-input" value={form.handle}
                  onChange={(e) => setForm({ ...form, handle: e.target.value })} />
              </label>
              <label>
                Platform
                <select className="iw-input" value={form.platform}
                  onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                  <option value="instagram">Instagram</option>
                  <option value="tiktok">TikTok</option>
                  <option value="youtube">YouTube</option>
                  <option value="facebook">Facebook</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                Phone
                <input className="iw-input" value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
              <label>
                Coupon code* <span className="iw-hint">what followers type — e.g. SARA200</span>
                <input className="iw-input iw-upper" value={form.couponCode}
                  onChange={(e) => setForm({ ...form, couponCode: e.target.value.toUpperCase() })} />
              </label>
              <label>
                Customer gets (DA off) <span className="iw-hint">what the code gives the buyer</span>
                <input className="iw-input" type="number" min={0} value={form.customerDiscount}
                  onChange={(e) => setForm({ ...form, customerDiscount: e.target.value })} />
              </label>
              <label>
                Commission (DA) <span className="iw-hint">what THEY earn per counted order/game</span>
                <input className="iw-input" type="number" min={0} value={form.commissionRate}
                  onChange={(e) => setForm({ ...form, commissionRate: e.target.value })} />
              </label>
              <label>
                Commission per
                <select className="iw-input" value={form.commissionBasis}
                  onChange={(e) => setForm({ ...form, commissionBasis: e.target.value })}>
                  <option value="ORDER">Order (flat, whatever is inside)</option>
                  <option value="UNIT">Game (a 2-game pack pays double)</option>
                </select>
              </label>
              <label>
                Payable orders <span className="iw-hint">which orders count for payment</span>
                <select className="iw-input" value={form.countTrigger}
                  onChange={(e) => setForm({ ...form, countTrigger: e.target.value })}>
                  <option value="CONFIRMED">Confirmed (passed our call — safer)</option>
                  <option value="PLACED">Placed (raw, junk removed)</option>
                </select>
              </label>
              <label>
                Fixed fee (DA) <span className="iw-hint">for fixed / hybrid deals, 0 = none</span>
                <input className="iw-input" type="number" min={0} value={form.fixedFee}
                  onChange={(e) => setForm({ ...form, fixedFee: e.target.value })} />
              </label>
            </div>
            <label>
              Notes (deal details, agreed terms)
              <textarea className="iw-input" rows={2} value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            {formError && <div className="iw-err">{formError}</div>}
            <div className="iw-modal-actions">
              <button className="iw-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="iw-btn iw-primary" onClick={submitForm} disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Create influencer"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── DETAIL DRAWER ─── */}
      {detail && (
        <div className="iw-overlay" onClick={() => setDetailId(null)}>
          <div className="iw-card iw-modal iw-wide" onClick={(e) => e.stopPropagation()}>
            <div className="iw-detail-head">
              <div>
                <h3>{detail.name}</h3>
                <span className="iw-sub">
                  <code className="iw-code">{detail.couponCode}</code>
                  {" · "}
                  {detail.platform || ""} {detail.handle ? "· " + detail.handle : ""}
                  {detail.phone ? " · " + detail.phone : ""}
                </span>
              </div>
              <div className="iw-detail-actions">
                <button className="iw-btn iw-sm" onClick={() => openEdit(detail)}>Edit deal</button>
                <button className="iw-btn iw-sm" onClick={() => toggleActive(detail)}>
                  {detail.active ? "Pause code" : "Activate code"}
                </button>
                <button className="iw-btn iw-sm" onClick={() => copyLink(detail)}>Copy their link</button>
                <button className="iw-btn iw-sm" onClick={() => setDetailId(null)}>Close</button>
              </div>
            </div>

            <div className="iw-strip iw-strip-tight">
              <div className="iw-num"><b>{fmt(detail.stats.placed)}</b><span>placed</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.confirmed)}</b><span>confirmed</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.delivered)}</b><span>delivered</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.returned)}</b><span>returned</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.inFlight)}</b><span>in flight</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.revenueDelivered)}</b><span>revenue (DA)</span></div>
            </div>
            <div className="iw-strip iw-strip-tight">
              <div className="iw-num"><b>{fmt(detail.stats.commissionOwed)}</b><span>commission owed</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.fixedFee)}</b><span>fixed fee</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.discountCost)}</b><span>discounts given</span></div>
              <div className="iw-num"><b>{fmt(detail.stats.paidTotal)}</b><span>paid so far</span></div>
              <div className="iw-num iw-hot"><b>{fmt(detail.stats.balance)}</b><span>balance to pay</span></div>
              <div className="iw-num">
                <b>{detail.stats.costPerDelivered === null ? "—" : fmt(detail.stats.costPerDelivered)}</b>
                <span>cost / delivered</span>
              </div>
            </div>

            <div className="iw-cols">
              <div>
                <h4>Log a payment</h4>
                <div className="iw-payform">
                  <input className="iw-input" type="number" min={0} placeholder="Amount (DA)"
                    value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                  <input className="iw-input" placeholder="Note (e.g. CCP transfer)"
                    value={payNote} onChange={(e) => setPayNote(e.target.value)} />
                  <button className="iw-btn iw-primary" onClick={addPayment}>Log it</button>
                </div>
                <ul className="iw-paylist">
                  {detail.payments.length === 0 && (
                    <li className="iw-muted">No payments logged yet.</li>
                  )}
                  {detail.payments.map((p) => (
                    <li key={p.id}>
                      <b>{fmt(p.amount)} DA</b> · {dstr(p.paidAt)}
                      {p.note ? " · " + p.note : ""}
                      <button className="iw-x" title="Remove" onClick={() => removePayment(p.id)}>×</button>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Orders with this code {detailOrders ? "(" + detailOrders.length + ")" : ""}</h4>
                {!detailOrders && <p className="iw-muted">Loading orders…</p>}
                {detailOrders && detailOrders.length === 0 && (
                  <p className="iw-muted">No orders yet — the counter starts the moment someone uses the code.</p>
                )}
                {detailOrders && detailOrders.length > 0 && (
                  <div className="iw-orderscroll">
                    <table className="iw-table iw-table-sm">
                      <thead>
                        <tr><th>#</th><th>Date</th><th>Customer</th><th>Wilaya</th><th>Items</th><th className="r">Total</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {detailOrders.map((o) => {
                          const st = STATUS_LABEL[o.status] ?? { text: o.status, cls: "s-off" };
                          return (
                            <tr key={o.orderNumber}>
                              <td>{o.orderNumber}</td>
                              <td>{dstr(o.createdAt)}</td>
                              <td>{o.customerName}</td>
                              <td>{o.wilayaName}</td>
                              <td>{o.items.map((it) => it.quantity + "× " + (it.product?.slug ?? "?")).join(", ")}</td>
                              <td className="r">{fmt(o.total)}</td>
                              <td><span className={"iw-chip " + st.cls}>{st.text}</span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="iw-toast">{toast}</div>}
    </div>
  );
}

function Style() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .iw{min-height:100vh;background:#FBF6EC;color:#141414;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;}
      .iw *{box-sizing:border-box;}
      .iw h1{font-size:22px;margin:8px 0;} .iw h3{font-size:17px;margin:0 0 12px;} .iw h4{font-size:14px;margin:14px 0 8px;}
      .iw-bar{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#141414;color:#FBF6EC;}
      .iw-brand{font-weight:800;color:#F9C22E;margin-right:10px;font-size:16px;}
      .iw-bar-sub{opacity:.8;} .iw-bar-r{display:flex;gap:8px;}
      .iw-wrap{max-width:1240px;margin:0 auto;padding:20px;}
      .iw-card{background:#fff;border:2px solid #141414;border-radius:12px;box-shadow:4px 4px 0 #141414;padding:16px;}
      .iw-btn{border:2px solid #141414;background:#fff;border-radius:9px;padding:7px 13px;font-weight:700;cursor:pointer;font-size:13px;color:#141414;}
      .iw-btn:hover{background:#f4eee0;} .iw-btn:disabled{opacity:.5;cursor:default;}
      .iw-primary{background:#F9C22E;} .iw-primary:hover{background:#f0b81f;}
      .iw-sm{padding:4px 9px;font-size:12px;} .iw-wfull{width:100%;}
      .iw-input{width:100%;border:2px solid #141414;border-radius:9px;padding:8px 10px;font-size:14px;background:#fff;margin-top:4px;}
      .iw-upper{text-transform:uppercase;letter-spacing:.06em;font-weight:700;}
      .iw-login{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
      .iw-login-card{max-width:380px;width:100%;text-align:center;display:flex;flex-direction:column;gap:10px;}
      .iw-logo{font-weight:800;font-size:24px;color:#141414;background:#F9C22E;border-radius:10px;display:inline-block;padding:2px 14px;margin:0 auto;}
      .iw-muted{color:#6b6b6b;} .iw-tiny{font-size:12px;margin:10px 4px 0;}
      .iw-err{background:#fdecea;border:2px solid #E5443A;color:#a32d2d;border-radius:9px;padding:8px 12px;margin:10px 0;font-weight:600;}
      .iw-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:0 0 18px;}
      .iw-strip-tight{margin:0 0 12px;}
      .iw-num{background:#fff;border:2px solid #141414;border-radius:10px;box-shadow:3px 3px 0 #141414;padding:10px 12px;text-align:center;}
      .iw-num b{display:block;font-size:20px;} .iw-num span{font-size:11.5px;color:#6b6b6b;font-weight:600;}
      .iw-hot b{color:#E5443A;}
      .iw-empty{text-align:center;padding:40px;}
      .iw-tablewrap{overflow-x:auto;padding:10px;}
      .iw-table{width:100%;border-collapse:collapse;font-size:13px;}
      .iw-table th{text-align:left;padding:8px 9px;border-bottom:2px solid #141414;font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;}
      .iw-table td{padding:9px;border-bottom:1px solid #eee7d7;vertical-align:top;}
      .iw-table .r{text-align:right;}
      .iw-table-sm th,.iw-table-sm td{padding:6px;font-size:12.5px;}
      .iw-sub{display:block;font-size:11.5px;color:#6b6b6b;}
      .iw-code{background:#141414;color:#F9C22E;border-radius:6px;padding:2px 8px;font-weight:700;letter-spacing:.05em;}
      .iw-good{color:#2E9E5B;font-weight:700;} .iw-bad{color:#E5443A;font-weight:700;}
      .iw-hotcell{color:#E5443A;font-weight:800;}
      .iw-rowoff{opacity:.5;}
      .iw-actions{white-space:nowrap;display:flex;gap:6px;}
      .iw-overlay{position:fixed;inset:0;background:rgba(20,20,20,.45);display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow-y:auto;z-index:50;}
      .iw-modal{max-width:640px;width:100%;} .iw-wide{max-width:1050px;}
      .iw-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin-bottom:10px;}
      .iw-modal label{display:block;font-weight:700;font-size:12.5px;margin-bottom:2px;}
      .iw-hint{font-weight:400;color:#6b6b6b;}
      .iw-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:14px;}
      .iw-detail-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px;}
      .iw-detail-actions{display:flex;gap:6px;flex-wrap:wrap;}
      .iw-cols{display:grid;grid-template-columns:320px 1fr;gap:20px;}
      .iw-payform{display:flex;flex-direction:column;gap:8px;}
      .iw-paylist{list-style:none;margin:10px 0 0;padding:0;}
      .iw-paylist li{padding:6px 8px;border-bottom:1px dashed #ddd;font-size:13px;position:relative;}
      .iw-x{position:absolute;right:2px;top:4px;border:none;background:none;color:#E5443A;font-size:16px;cursor:pointer;font-weight:700;}
      .iw-orderscroll{max-height:380px;overflow-y:auto;border:1px solid #eee7d7;border-radius:8px;}
      .iw-chip{display:inline-block;border-radius:8px;padding:2px 8px;font-size:11px;font-weight:700;white-space:nowrap;}
      .s-ok{background:#e1f5ee;color:#0f6e56;} .s-good{background:#2E9E5B;color:#fff;}
      .s-bad{background:#fdecea;color:#a32d2d;} .s-warn{background:#faeeda;color:#854f0b;}
      .s-ship{background:#e6f1fb;color:#185fa5;} .s-wait{background:#f1efe8;color:#5f5e5a;}
      .s-off{background:#eee;color:#888;}
      .iw-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#141414;color:#FBF6EC;border-radius:10px;padding:10px 18px;font-weight:700;z-index:99;}
      @media(max-width:800px){.iw-grid2{grid-template-columns:1fr;}.iw-cols{grid-template-columns:1fr;}}
    ` }} />
  );
}
