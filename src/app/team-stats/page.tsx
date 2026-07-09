"use client";

// Owner stats — confirmation-team performance + order funnel.
// Admin-key login (shared with the other owner screens). Read-only.

import { useCallback, useEffect, useState } from "react";

const ADMIN_KEY_STORAGE = "curio-admin-key";

type AgentStat = {
  id: string; name: string; username: string; active: boolean; role: string;
  handled: number; confirmed: number; cancelled: number; noAnswer: number;
  postponed: number; shipped: number; inQueue: number; confirmRate: number | null;
};
type Stats = {
  cutoverAt: string | null;
  today: { confirmed: number; shipped: number };
  week: { confirmed: number; orders: number };
  funnel: { total: number; pending: number; confirmed: number; shipped: number; cancelled: number };
  dispositions: Record<string, number>;
  agents: AgentStat[];
};

const DISP_AR: Record<string, string> = {
  confirmed: "مأكد", no_answer: "ما ردش", postponed: "مؤجل",
  cancelled: "ملغى", wrong_number: "رقم غالط", duplicate: "مكرر",
};

export default function TeamStats() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const s = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (s) setAdminKey(s);
  }, []);

  const load = useCallback(async (key: string) => {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/agent-stats", { headers: { "x-admin-key": key }, cache: "no-store" });
      if (res.status === 401) { setLoginError(true); window.sessionStorage.removeItem(ADMIN_KEY_STORAGE); setAdminKey(""); return; }
      const j = await res.json();
      if (!res.ok) { setError(j.error || "مشكل"); return; }
      setData(j);
    } catch { setError("ما نجمناش نجيبو الإحصائيات"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (adminKey) load(adminKey); }, [adminKey, load]);

  function login() {
    const k = keyInput.trim(); if (!k) return;
    setLoginError(false); window.sessionStorage.setItem(ADMIN_KEY_STORAGE, k); setAdminKey(k);
  }

  if (!adminKey) {
    return (
      <div className="ts-login">
        <div className="ts-card">
          <h1>Curio — إحصائيات الفريق</h1>
          <input type="password" placeholder="Admin key" value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} />
          {loginError && <div className="ts-err">كلمة السر غالطة</div>}
          <button onClick={login}>دخول</button>
        </div>
        <style jsx global>{styles}</style>
      </div>
    );
  }

  const f = data?.funnel;
  const cutoverTxt = data?.cutoverAt ? new Date(data.cutoverAt).toLocaleDateString("fr") : "—";

  return (
    <div className="ts-wrap">
      <header className="ts-head">
        <div><h1>إحصائيات فريق التأكيد</h1><span className="ts-sub">من تاريخ البداية: {cutoverTxt}</span></div>
        <button className="ts-ghost" onClick={() => load(adminKey)}>↻ حدّث</button>
      </header>
      {error && <div className="ts-err ts-banner">{error}</div>}
      {loading && !data && <div className="ts-info">يحمّل…</div>}

      {data && (
        <>
          <div className="ts-cards">
            <div className="ts-c ts-green"><span>مأكد اليوم</span><b>{data.today.confirmed}</b></div>
            <div className="ts-c ts-blue"><span>مبعوث اليوم</span><b>{data.today.shipped}</b></div>
            <div className="ts-c"><span>طلبات هذا الأسبوع</span><b>{data.week.orders}</b></div>
            <div className="ts-c"><span>مأكد هذا الأسبوع</span><b>{data.week.confirmed}</b></div>
          </div>

          <h2>مسار الطلبات (منذ البداية)</h2>
          <div className="ts-funnel">
            <div className="ts-fc ts-yellow"><b>{f?.pending ?? 0}</b><span>للتأكيد</span></div>
            <div className="ts-fc ts-green"><b>{f?.confirmed ?? 0}</b><span>مأكد</span></div>
            <div className="ts-fc ts-blue"><b>{f?.shipped ?? 0}</b><span>مبعوث</span></div>
            <div className="ts-fc ts-red"><b>{f?.cancelled ?? 0}</b><span>ملغى</span></div>
            <div className="ts-fc"><b>{f?.total ?? 0}</b><span>المجموع</span></div>
          </div>

          <h2>نتائج المكالمات</h2>
          <div className="ts-disp">
            {Object.entries(data.dispositions).map(([k, v]) => (
              <div className="ts-d" key={k}><b>{v}</b><span>{DISP_AR[k] || k}</span></div>
            ))}
          </div>

          <h2>الأعوان</h2>
          <div className="ts-table-wrap">
            <table className="ts-table">
              <thead><tr>
                <th>العون</th><th>في الانتظار</th><th>عالج</th><th>مأكد</th><th>ملغى</th><th>ما ردش</th><th>مبعوث</th><th>نسبة التأكيد</th>
              </tr></thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.id} className={a.active ? "" : "ts-off"}>
                    <td className="ts-name">{a.name}{!a.active && " (موقّف)"}{a.role === "owner" ? " ⭐" : ""}</td>
                    <td>{a.inQueue}</td><td>{a.handled}</td><td>{a.confirmed}</td><td>{a.cancelled}</td>
                    <td>{a.noAnswer}</td><td>{a.shipped}</td>
                    <td>{a.confirmRate == null ? "—" : a.confirmRate + "%"}</td>
                  </tr>
                ))}
                {data.agents.length === 0 && <tr><td colSpan={8} className="ts-empty">ماكانش أعوان</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="ts-note">الأرقام تحسب غير الطلبات لي جات بعد تاريخ البداية (باش ما يتخلطوش مع القدماء).</p>
        </>
      )}
      <style jsx global>{styles}</style>
    </div>
  );
}

const styles = `
  .ts-wrap{max-width:900px;margin:0 auto;padding:20px 16px 70px;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;color:#161310;direction:rtl}
  .ts-login{min-height:100vh;display:grid;place-items:center;background:#fbf6ec;direction:rtl;font-family:system-ui,sans-serif}
  .ts-card{background:#fff;border:2px solid #161310;border-radius:18px;box-shadow:6px 6px 0 #161310;padding:28px;width:min(92vw,360px);text-align:center}
  .ts-card h1{font-size:1.25rem;margin:0 0 14px}
  .ts-card input{width:100%;border:2px solid #161310;border-radius:10px;padding:12px;font-size:1rem;margin-bottom:12px}
  .ts-card button,.ts-ghost{cursor:pointer;font-weight:800}
  .ts-card button{background:#5cb335;color:#fff;border:2px solid #161310;border-radius:10px;padding:12px 18px;font-size:1rem;box-shadow:3px 3px 0 #161310;width:100%}
  .ts-err{color:#ec2c24;font-weight:700}
  .ts-banner{background:#fdeeee;border:2px solid #ec2c24;border-radius:10px;padding:10px 14px;margin:10px 0}
  .ts-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #161310;padding-bottom:12px;margin-bottom:16px}
  .ts-head h1{font-size:1.4rem;margin:0}
  .ts-sub{color:#675b4c;font-size:.82rem}
  .ts-ghost{background:#fff;border:2px solid #161310;border-radius:9px;padding:8px 12px;font-size:.85rem}
  .ts-info{color:#675b4c;padding:24px 0;text-align:center}
  h2{font-size:1.05rem;margin:22px 0 10px}
  .ts-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .ts-c{border:2px solid #161310;border-radius:14px;background:#fffdf7;box-shadow:4px 4px 0 #161310;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
  .ts-c span{font-size:.82rem;color:#675b4c;font-weight:700}
  .ts-c b{font-family:"Anton",system-ui,sans-serif;font-size:2rem;line-height:1}
  .ts-c.ts-green{background:#eaf7e6}.ts-c.ts-blue{background:#eaf4fb}
  .ts-funnel,.ts-disp{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px}
  .ts-fc,.ts-d{border:2px solid #161310;border-radius:12px;background:#fff;padding:12px;text-align:center;box-shadow:3px 3px 0 #161310}
  .ts-fc b,.ts-d b{display:block;font-size:1.6rem;font-weight:800;line-height:1}
  .ts-fc span,.ts-d span{font-size:.78rem;color:#675b4c;font-weight:700}
  .ts-fc.ts-yellow{background:#fff6d6}.ts-fc.ts-green{background:#eaf7e6}.ts-fc.ts-blue{background:#eaf4fb}.ts-fc.ts-red{background:#fdeeee}
  .ts-table-wrap{overflow-x:auto;border:2px solid #161310;border-radius:14px;box-shadow:4px 4px 0 #161310}
  .ts-table{width:100%;border-collapse:collapse;background:#fffdf7;min-width:560px}
  .ts-table th,.ts-table td{padding:10px 12px;text-align:center;border-bottom:1px solid #e7dcc6;font-size:.9rem}
  .ts-table th{background:#161310;color:#fff;font-size:.78rem}
  .ts-table .ts-name{text-align:right;font-weight:800}
  .ts-table tr.ts-off{opacity:.5}
  .ts-empty{color:#675b4c;padding:16px}
  .ts-note{color:#675b4c;font-size:.82rem;margin-top:12px}
`;
