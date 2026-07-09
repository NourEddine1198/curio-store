"use client";

// Agent console — login + order queue.
// The confirmation agent logs in, sees orders to call (and to ship), and
// clicks into one to work it.

import { useCallback, useEffect, useState } from "react";

const TOKEN_KEY = "curio-agent-token";
const NAME_KEY = "curio-agent-name";

type OrderRow = {
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  wilayaName: string;
  total: number;
  status: string;
  disposition: string | null;
  callAttempts: number;
  nextCallAt: string | null;
  createdAt: string;
  items: { quantity: number; product: { name: string; slug: string } }[];
};

const DA = (n: number) => (n || 0).toLocaleString("en") + " دج";
const DISP_LABEL: Record<string, string> = {
  no_answer: "ما ردش",
  postponed: "مؤجل",
  confirmed: "مأكد",
};

export default function AgentQueue() {
  const [token, setToken] = useState("");
  const [agentName, setAgentName] = useState("");
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [bucket, setBucket] = useState<"call" | "ship" | "done">("call");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [counts, setCounts] = useState<{ call: number; ship: number }>({ call: 0, ship: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = window.sessionStorage.getItem(TOKEN_KEY);
    if (t) { setToken(t); setAgentName(window.sessionStorage.getItem(NAME_KEY) || ""); }
  }, []);

  const loadQueue = useCallback(async (tok: string, b: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agent/orders?bucket=${b}`, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
      if (res.status === 401) { logout(); return; }
      const j = await res.json();
      setOrders(j.orders || []);
      if (j.counts) setCounts(j.counts);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (token) loadQueue(token, bucket); }, [token, bucket, loadQueue]);

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
    <div className="ag-wrap">
      <header className="ag-head">
        <div><b>👋 {agentName}</b><span className="ag-sub">لوحة التأكيد</span></div>
        <button className="ag-ghost" onClick={logout}>خروج</button>
      </header>

      <div className="ag-tabs">
        <button className={bucket === "call" ? "on" : ""} onClick={() => setBucket("call")}>📞 للتأكيد ({counts.call})</button>
        <button className={bucket === "ship" ? "on" : ""} onClick={() => setBucket("ship")}>📦 للشحن ({counts.ship})</button>
        <button className={bucket === "done" ? "on" : ""} onClick={() => setBucket("done")}>✅ تبعثو</button>
      </div>

      {loading && <div className="ag-info">يحمّل…</div>}
      {!loading && orders.length === 0 && <div className="ag-info">ماكانش طلبات هنا 👌</div>}

      <div className="ag-list">
        {orders.map((o) => (
          <a className="ag-order" href={`/agent/order/${o.orderNumber}`} key={o.orderNumber}>
            <div className="ag-order-top">
              <b>#{o.orderNumber}</b>
              <span className="ag-total">{DA(o.total)}</span>
            </div>
            <div className="ag-cust">{o.customerName} · {o.customerPhone}</div>
            <div className="ag-meta">
              <span>{o.wilayaName}</span>
              <span>·</span>
              <span>{o.items.map((i) => i.product.name + (i.quantity > 1 ? ` ×${i.quantity}` : "")).join("، ")}</span>
            </div>
            {o.disposition && DISP_LABEL[o.disposition] && (
              <span className={`ag-badge ag-${o.disposition}`}>
                {DISP_LABEL[o.disposition]}{o.disposition === "no_answer" ? ` (${o.callAttempts}/9)` : ""}
              </span>
            )}
          </a>
        ))}
      </div>
      <style jsx global>{styles}</style>
    </div>
  );
}

const styles = `
  .ag-wrap{max-width:720px;margin:0 auto;padding:18px 14px 60px;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;color:#161310;direction:rtl}
  .ag-login{min-height:100vh;display:grid;place-items:center;background:#fbf6ec;direction:rtl;font-family:system-ui,sans-serif}
  .ag-card{background:#fff;border:2px solid #161310;border-radius:18px;box-shadow:6px 6px 0 #161310;padding:28px;width:min(92vw,360px);text-align:center}
  .ag-card h1{font-size:1.3rem;margin:0 0 16px}
  .ag-card input{width:100%;border:2px solid #161310;border-radius:10px;padding:12px;font-size:1rem;margin-bottom:10px}
  .ag-card button,.ag-ghost{cursor:pointer;font-weight:800}
  .ag-card button{background:#5cb335;color:#fff;border:2px solid #161310;border-radius:10px;padding:12px 18px;font-size:1rem;box-shadow:3px 3px 0 #161310;width:100%}
  .ag-err{color:#ec2c24;font-weight:700;margin-bottom:10px}
  .ag-head{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #161310;padding-bottom:12px;margin-bottom:14px}
  .ag-head b{font-size:1.15rem}
  .ag-sub{color:#675b4c;font-size:.82rem;margin-inline-start:8px}
  .ag-ghost{background:#fff;border:2px solid #161310;border-radius:9px;padding:7px 12px;font-size:.85rem}
  .ag-tabs{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
  .ag-tabs button{background:#fff;border:2px solid #161310;border-radius:999px;padding:8px 14px;font-weight:800;font-size:.88rem;cursor:pointer}
  .ag-tabs button.on{background:#facc15;box-shadow:3px 3px 0 #161310}
  .ag-info{color:#675b4c;padding:24px 0;text-align:center}
  .ag-list{display:grid;gap:10px}
  .ag-order{display:block;border:2px solid #161310;border-radius:14px;background:#fffdf7;box-shadow:4px 4px 0 #161310;padding:14px;text-decoration:none;color:#161310;transition:transform .1s}
  .ag-order:hover{transform:translate(-1px,-1px)}
  .ag-order-top{display:flex;justify-content:space-between;align-items:baseline}
  .ag-order-top b{font-size:1.05rem}
  .ag-total{font-weight:800;font-family:ui-monospace,monospace}
  .ag-cust{font-weight:700;margin-top:4px}
  .ag-meta{color:#675b4c;font-size:.85rem;margin-top:3px;display:flex;gap:6px;flex-wrap:wrap}
  .ag-badge{display:inline-block;margin-top:8px;font-size:.72rem;font-weight:800;padding:3px 9px;border-radius:999px;border:2px solid #161310}
  .ag-no_answer{background:#ffe08a}
  .ag-postponed{background:#cfe8ff}
  .ag-confirmed{background:#b6f0c0}
`;
