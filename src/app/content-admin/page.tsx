"use client";

// ── Curio content editor ────────────────────────────────────
// The screen the founders use to edit the words + images on the
// marketing pages (home / roubla / dlala) WITHOUT re-deploying.
// Saves to /api/content; changes go live on the pages instantly.

import { useCallback, useEffect, useMemo, useState } from "react";

const ADMIN_KEY_STORAGE = "curio-admin-key"; // shared with the dashboard login

type Row = {
  id: string;
  page: string;
  key: string;
  type: string;      // "text" | "image"
  value: string;
  label: string | null;
  group: string | null;
  sort: number;
};

const PAGES = [
  { id: "home", label: "الصفحة الرئيسية · Home" },
  { id: "roubla", label: "روبلة · Roubla" },
  { id: "dlala", label: "دلالة · Dlala" },
];

// Where the live pages + their images live (for preview links/thumbnails).
function siteBase() {
  if (typeof window === "undefined") return "https://curiodz.com/";
  return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
    ? "http://localhost:5510/"
    : "https://curiodz.com/";
}
function pagePreviewUrl(page: string) {
  const base = siteBase();
  if (base.includes("localhost")) {
    const file = page === "home" ? "index" : page;
    return `${base}pages/${file}.html`;
  }
  return page === "home" ? `${base}home` : `${base}${page}`;
}
// Resolve a stored image value to something the browser can show here.
function resolveImg(v: string) {
  if (!v) return "";
  if (/^https?:\/\//.test(v)) return v;
  if (v.startsWith("/api/")) return v; // served by this same app
  return siteBase() + v.replace(/^\.\.\//, "").replace(/^\.\//, "");
}

export default function ContentAdmin() {
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [activePage, setActivePage] = useState("roubla");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);

  // Restore a saved login
  useEffect(() => {
    const saved = window.sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (saved) setAdminKey(saved);
  }, []);

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/content?admin=1", {
        headers: { "x-admin-key": key },
        cache: "no-store",
      });
      if (res.status === 401) {
        setLoginError(true);
        window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
        setAdminKey("");
        return;
      }
      const json = await res.json();
      setRows(json.rows || []);
      setDrafts({});
    } catch {
      setError("ما نجمناش نجيبو المحتوى. عاود حاول.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (adminKey) load(adminKey);
  }, [adminKey, load]);

  function login() {
    const key = keyInput.trim();
    if (!key) return;
    setLoginError(false);
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    setAdminKey(key);
  }
  function logout() {
    window.sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    setAdminKey("");
    setRows([]);
    setDrafts({});
    setKeyInput("");
  }

  // Rows for the active page, grouped by section
  const grouped = useMemo(() => {
    const list = rows
      .filter((r) => r.page === activePage)
      .sort((a, b) => a.sort - b.sort);
    const map = new Map<string, Row[]>();
    for (const r of list) {
      const g = r.group || "أخرى";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    }
    return Array.from(map.entries());
  }, [rows, activePage]);

  const changedKeys = useMemo(
    () =>
      Object.keys(drafts).filter((k) => {
        const row = rows.find((r) => r.key === k);
        return row && drafts[k] !== row.value;
      }),
    [drafts, rows]
  );

  function setDraft(key: string, value: string) {
    setDrafts((d) => ({ ...d, [key]: value }));
    setSaveMsg("");
  }
  function currentValue(row: Row) {
    return row.key in drafts ? drafts[row.key] : row.value;
  }

  async function uploadImage(row: Row, file: File) {
    setUploading(row.key);
    setSaveMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { "x-admin-key": adminKey },
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.url) {
        setError(json.error || "ما نجحش الرفع");
        return;
      }
      setDraft(row.key, json.url);
    } catch {
      setError("ما نجحش رفع الصورة");
    } finally {
      setUploading(null);
    }
  }

  async function saveAll() {
    if (changedKeys.length === 0) return;
    setSaving(true);
    setSaveMsg("");
    setError(null);
    try {
      const updates = changedKeys.map((k) => {
        const row = rows.find((r) => r.key === k)!;
        return { key: k, value: drafts[k], page: row.page, type: row.type };
      });
      const res = await fetch("/api/content", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ updates }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "ما نجح الحفظ");
        return;
      }
      // merge saved values into rows, clear drafts for saved keys
      setRows((rs) =>
        rs.map((r) =>
          changedKeys.includes(r.key) ? { ...r, value: drafts[r.key] } : r
        )
      );
      setDrafts({});
      const failed = (json.errors || []).length;
      setSaveMsg(
        failed
          ? `تسجل ${json.results.length}، فشل ${failed}. عاود حاول.`
          : `✅ تسجل كلش (${json.results.length}). ولّى مباشر على الموقع.`
      );
    } catch {
      setError("ما نجح الحفظ. عاود حاول.");
    } finally {
      setSaving(false);
    }
  }

  // ── Login screen ──────────────────────────────────────────
  if (!adminKey) {
    return (
      <div className="ca-login">
        <div className="ca-card">
          <h1>Curio — تعديل المحتوى</h1>
          <p>دخل كلمة السر باش تبدل النصوص و الصور.</p>
          <input
            type="password"
            placeholder="Admin key"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {loginError && <div className="ca-err">كلمة السر غالطة</div>}
          <button onClick={login}>دخول</button>
        </div>
        <style jsx global>{styles}</style>
      </div>
    );
  }

  // ── Editor ────────────────────────────────────────────────
  return (
    <div className="ca-wrap">
      <header className="ca-head">
        <div>
          <h1>تعديل المحتوى</h1>
          <span className="ca-sub">بدّل النص أو الصورة، احفظ، و يولّي مباشر — بلا ما تعاود تنشر</span>
        </div>
        <div className="ca-head-actions">
          <a className="ca-ghost" href={pagePreviewUrl(activePage)} target="_blank" rel="noreferrer">👁 شوف الصفحة</a>
          <button className="ca-ghost" onClick={logout}>خروج</button>
        </div>
      </header>

      <div className="ca-tabs">
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={p.id === activePage ? "on" : ""}
            onClick={() => setActivePage(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {loading && <div className="ca-info">يحمّل…</div>}
      {error && <div className="ca-err ca-banner">{error}</div>}

      {!loading &&
        grouped.map(([group, groupRows]) => (
          <section className="ca-group" key={group}>
            <h2>{group}</h2>
            {groupRows.map((row) => (
              <div className="ca-field" key={row.key}>
                <label>
                  {row.label || row.key}
                  {row.key in drafts && drafts[row.key] !== row.value && (
                    <span className="ca-dot" title="فيه تبديل ماحفظتوش">●</span>
                  )}
                </label>

                {row.type === "image" ? (
                  <div className="ca-img-row">
                    {currentValue(row) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="ca-thumb" src={resolveImg(currentValue(row))} alt="" />
                    ) : (
                      <div className="ca-thumb ca-thumb-empty">لا صورة</div>
                    )}
                    <div className="ca-img-controls">
                      <label className="ca-upload">
                        {uploading === row.key ? "يرفع…" : "📤 رفع صورة جديدة"}
                        <input
                          type="file"
                          accept="image/*"
                          disabled={uploading === row.key}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) uploadImage(row, f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      <input
                        className="ca-input"
                        type="text"
                        value={currentValue(row)}
                        onChange={(e) => setDraft(row.key, e.target.value)}
                        placeholder="أو الصق رابط صورة"
                        dir="ltr"
                      />
                    </div>
                  </div>
                ) : (
                  <textarea
                    className="ca-textarea"
                    value={currentValue(row)}
                    onChange={(e) => setDraft(row.key, e.target.value)}
                    rows={Math.min(6, Math.max(1, Math.ceil(currentValue(row).length / 60)))}
                    dir="auto"
                  />
                )}
              </div>
            ))}
          </section>
        ))}

      {/* Sticky save bar */}
      <div className={`ca-savebar ${changedKeys.length ? "show" : ""}`}>
        <span>{changedKeys.length} تبديل ماحفظتوش</span>
        {saveMsg && <span className="ca-savemsg">{saveMsg}</span>}
        <button disabled={saving || changedKeys.length === 0} onClick={saveAll}>
          {saving ? "يحفظ…" : "💾 احفظ التبديلات"}
        </button>
      </div>

      <style jsx global>{styles}</style>
    </div>
  );
}

const styles = `
  .ca-wrap { max-width: 860px; margin: 0 auto; padding: 20px 16px 120px; font-family: system-ui, "Segoe UI", Tahoma, sans-serif; color: #161310; direction: rtl; }
  .ca-login { min-height: 100vh; display: grid; place-items: center; background: #fbf6ec; font-family: system-ui, sans-serif; direction: rtl; }
  .ca-card { background: #fff; border: 2px solid #161310; border-radius: 18px; box-shadow: 6px 6px 0 #161310; padding: 30px; width: min(92vw, 380px); text-align: center; }
  .ca-card h1 { font-size: 1.4rem; margin: 0 0 6px; }
  .ca-card p { color: #675b4c; font-size: .92rem; margin: 0 0 16px; }
  .ca-card input { width: 100%; border: 2px solid #161310; border-radius: 10px; padding: 12px; font-size: 1rem; margin-bottom: 12px; }
  .ca-card button, .ca-savebar button { background: #5cb335; color: #fff; border: 2px solid #161310; border-radius: 10px; padding: 12px 18px; font-weight: 800; font-size: 1rem; cursor: pointer; box-shadow: 3px 3px 0 #161310; }
  .ca-card button:disabled, .ca-savebar button:disabled { opacity: .5; cursor: default; box-shadow: none; }
  .ca-err { color: #ec2c24; font-weight: 700; margin-bottom: 10px; }
  .ca-banner { background: #fdeeee; border: 2px solid #ec2c24; border-radius: 10px; padding: 10px 14px; margin: 12px 0; }
  .ca-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 2px solid #161310; padding-bottom: 14px; margin-bottom: 16px; }
  .ca-head h1 { font-size: 1.5rem; margin: 0; }
  .ca-sub { color: #675b4c; font-size: .85rem; }
  .ca-head-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .ca-ghost { background: #fff; border: 2px solid #161310; border-radius: 9px; padding: 8px 12px; font-weight: 700; font-size: .85rem; cursor: pointer; text-decoration: none; color: #161310; white-space: nowrap; }
  .ca-tabs { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
  .ca-tabs button { background: #fff; border: 2px solid #161310; border-radius: 999px; padding: 8px 16px; font-weight: 800; font-size: .9rem; cursor: pointer; }
  .ca-tabs button.on { background: #facc15; box-shadow: 3px 3px 0 #161310; }
  .ca-group { margin-bottom: 22px; }
  .ca-group h2 { font-size: 1rem; background: #161310; color: #facc15; display: inline-block; padding: 4px 12px; border-radius: 8px; margin: 0 0 12px; }
  .ca-field { margin-bottom: 14px; }
  .ca-field > label { display: block; font-size: .8rem; color: #675b4c; font-weight: 700; margin-bottom: 4px; }
  .ca-dot { color: #ec2c24; margin-inline-start: 6px; }
  .ca-textarea, .ca-input { width: 100%; border: 1.5px solid #cbbfa8; border-radius: 10px; padding: 10px 12px; font-size: .98rem; font-family: inherit; background: #fff; resize: vertical; line-height: 1.5; }
  .ca-textarea:focus, .ca-input:focus { outline: 2px solid #2aa9e0; border-color: #2aa9e0; }
  .ca-img-row { display: flex; gap: 12px; align-items: flex-start; }
  .ca-thumb { width: 84px; height: 84px; object-fit: cover; border: 2px solid #161310; border-radius: 10px; flex-shrink: 0; background: #f3ecdd; }
  .ca-thumb-empty { display: grid; place-items: center; font-size: .7rem; color: #675b4c; }
  .ca-img-controls { flex: 1; display: flex; flex-direction: column; gap: 8px; }
  .ca-upload { background: #2aa9e0; color: #fff; border: 2px solid #161310; border-radius: 9px; padding: 9px 12px; font-weight: 800; font-size: .85rem; cursor: pointer; text-align: center; box-shadow: 2px 2px 0 #161310; }
  .ca-upload input { display: none; }
  .ca-info { color: #675b4c; padding: 20px 0; }
  .ca-savebar { position: fixed; inset-inline: 0; bottom: 0; background: #fffdf7; border-top: 2px solid #161310; box-shadow: 0 -4px 0 -1px rgba(22,19,16,.1); display: none; align-items: center; justify-content: flex-end; gap: 14px; padding: 12px clamp(14px,4vw,40px); font-weight: 700; direction: rtl; }
  .ca-savebar.show { display: flex; }
  .ca-savemsg { color: #5cb335; font-weight: 800; font-size: .9rem; }
`;
