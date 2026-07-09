"use client";

// Products & Prices editor — the "backend" where the founders change any
// product's price, compare-at (strike-through), stock, and whether it's
// shown/hidden. Reuses the shared admin-key login. Saves via PATCH /api/products.

import { useCallback, useEffect, useState } from "react";

const ADMIN_KEY_STORAGE = "curio-admin-key";

type Product = {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  price: number;
  compareAt: number | null;
  stock: number;
  active: boolean;
};

export default function ProductsAdmin() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Partial<Product>>>({});
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const load = useCallback(async (key: string) => {
    setError(null);
    try {
      const res = await fetch("/api/products?admin=1", { headers: { "x-admin-key": key }, cache: "no-store" });
      if (res.status === 401) {
        setLoginError(true);
        window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setAdminKey("");
        return;
      }
      const j = await res.json();
      setProducts(j.products || []);
      setDrafts({});
    } catch {
      setError("ما نجمناش نجيبو المنتجات");
    }
  }, []);

  useEffect(() => { if (adminKey) load(adminKey); }, [adminKey, load]);

  function login() {
    const k = keyInput.trim();
    if (!k) return;
    setLoginError(false);
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE, k);
    setAdminKey(k);
  }

  function val(p: Product, field: keyof Product) {
    const d = drafts[p.slug];
    return d && field in d ? (d[field] as string | number | boolean) : p[field];
  }
  function setField(slug: string, field: keyof Product, value: string | number | boolean | null) {
    setDrafts((d) => ({ ...d, [slug]: { ...d[slug], [field]: value } }));
    setMsg("");
  }

  async function save(p: Product) {
    const d = drafts[p.slug];
    if (!d) return;
    setSavingSlug(p.slug);
    setError(null);
    try {
      const body: Record<string, unknown> = { slug: p.slug };
      if ("price" in d) body.price = Number(d.price);
      if ("compareAt" in d) body.compareAt = d.compareAt === null || d.compareAt === ("" as unknown) ? null : Number(d.compareAt);
      if ("stock" in d) body.stock = Number(d.stock);
      if ("active" in d) body.active = Boolean(d.active);
      const res = await fetch("/api/products", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error || "فشل الحفظ"); return; }
      setProducts((ps) => ps.map((x) => (x.slug === p.slug ? { ...x, ...j.product } : x)));
      setDrafts((dr) => { const n = { ...dr }; delete n[p.slug]; return n; });
      setMsg(`✅ تسجل: ${p.slug}`);
    } catch {
      setError("فشل الحفظ، عاود حاول");
    } finally {
      setSavingSlug(null);
    }
  }

  if (!adminKey) {
    return (
      <div className="pa-login">
        <div className="pa-card">
          <h1>Curio — الأسعار</h1>
          <input type="password" placeholder="Admin key" value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && login()} />
          {loginError && <div className="pa-err">كلمة السر غالطة</div>}
          <button onClick={login}>دخول</button>
        </div>
        <style jsx global>{styles}</style>
      </div>
    );
  }

  return (
    <div className="pa-wrap">
      <h1>المنتجات و الأسعار</h1>
      <p className="pa-sub">بدّل الثمن، الثمن القديم (لي يتشطب), الستوك، وإذا يبان ولا لا. يتسجّل ديركت بلا نشر.</p>
      {error && <div className="pa-err pa-banner">{error}</div>}
      {msg && <div className="pa-ok">{msg}</div>}

      <div className="pa-grid">
        {products.map((p) => {
          const dirty = !!drafts[p.slug];
          return (
            <div className={`pa-prod ${val(p, "active") ? "" : "pa-off"}`} key={p.slug}>
              <div className="pa-prod-head">
                <b>{p.name}</b>
                <span className="pa-slug">{p.slug}</span>
              </div>
              <div className="pa-fields">
                <label>الثمن (دج)
                  <input type="number" value={String(val(p, "price"))} onChange={(e) => setField(p.slug, "price", e.target.value)} />
                </label>
                <label>الثمن القديم
                  <input type="number" placeholder="—" value={val(p, "compareAt") == null ? "" : String(val(p, "compareAt"))}
                    onChange={(e) => setField(p.slug, "compareAt", e.target.value === "" ? null : e.target.value)} />
                </label>
                <label>الستوك
                  <input type="number" value={String(val(p, "stock"))} onChange={(e) => setField(p.slug, "stock", e.target.value)} />
                </label>
                <label className="pa-check">
                  <input type="checkbox" checked={!!val(p, "active")} onChange={(e) => setField(p.slug, "active", e.target.checked)} />
                  يبان في الموقع
                </label>
              </div>
              <button className="pa-save" disabled={!dirty || savingSlug === p.slug} onClick={() => save(p)}>
                {savingSlug === p.slug ? "يحفظ…" : dirty ? "💾 احفظ" : "محفوظ"}
              </button>
            </div>
          );
        })}
      </div>
      <style jsx global>{styles}</style>
    </div>
  );
}

const styles = `
  .pa-wrap{max-width:820px;margin:0 auto;padding:24px 16px 80px;font-family:system-ui,"Segoe UI",Tahoma,sans-serif;color:#161310;direction:rtl}
  .pa-wrap h1{font-size:1.5rem;margin:0 0 4px}
  .pa-sub{color:#675b4c;font-size:.9rem;margin-bottom:18px}
  .pa-login{min-height:100vh;display:grid;place-items:center;background:#fbf6ec;direction:rtl;font-family:system-ui,sans-serif}
  .pa-card{background:#fff;border:2px solid #161310;border-radius:18px;box-shadow:6px 6px 0 #161310;padding:28px;width:min(92vw,360px);text-align:center}
  .pa-card h1{margin:0 0 14px}
  .pa-card input{width:100%;border:2px solid #161310;border-radius:10px;padding:12px;font-size:1rem;margin-bottom:12px}
  .pa-card button,.pa-save{background:#5cb335;color:#fff;border:2px solid #161310;border-radius:10px;padding:11px 16px;font-weight:800;cursor:pointer;box-shadow:3px 3px 0 #161310}
  .pa-save:disabled{opacity:.45;box-shadow:none;cursor:default;background:#9b9b93}
  .pa-err{color:#ec2c24;font-weight:700}
  .pa-banner{background:#fdeeee;border:2px solid #ec2c24;border-radius:10px;padding:10px 14px;margin:10px 0}
  .pa-ok{color:#2c7a1e;font-weight:800;margin:8px 0}
  .pa-grid{display:grid;gap:14px}
  .pa-prod{border:2px solid #161310;border-radius:14px;background:#fffdf7;box-shadow:4px 4px 0 #161310;padding:16px}
  .pa-prod.pa-off{opacity:.62;background:#f3ece0}
  .pa-prod-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:12px}
  .pa-prod-head b{font-size:1.15rem}
  .pa-slug{font-size:.72rem;color:#675b4c;font-family:ui-monospace,monospace;direction:ltr}
  .pa-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;align-items:end;margin-bottom:12px}
  .pa-fields label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;font-weight:700;color:#675b4c}
  .pa-fields input[type=number]{border:1.5px solid #cbbfa8;border-radius:9px;padding:9px 10px;font-size:1rem;font-family:inherit;direction:ltr;text-align:right}
  .pa-check{flex-direction:row!important;align-items:center;gap:8px!important}
  .pa-check input{width:20px;height:20px}
`;
