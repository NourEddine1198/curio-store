import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dbPg } from "@/lib/db-pg";

// This route powers the mini-CMS.
//   GET  /api/content?page=roubla   → public. Returns { key: value } for that page.
//   GET  /api/content?admin=1       → admin. Returns full rows (with labels/groups).
//   POST /api/content               → admin. Upserts one or more rows.
// Content edits here go live on the pages instantly — no re-deploy.

// Always read the freshest content (Netlify must not cache this).
export const dynamic = "force-dynamic";

const ADMIN_KEY = process.env.ADMIN_KEY;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function isAdmin(request: NextRequest) {
  return Boolean(ADMIN_KEY) && request.headers.get("x-admin-key") === ADMIN_KEY;
}

// ─── GET ────────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const page = url.searchParams.get("page");
    const admin = url.searchParams.get("admin");

    // Admin view: full rows so the panel can render labels + groups.
    if (admin) {
      if (!isAdmin(request)) return unauthorized();
      const rows = await db.pageContent.findMany({
        where: page ? { page } : undefined,
        orderBy: [{ page: "asc" }, { group: "asc" }, { sort: "asc" }],
      });
      return NextResponse.json({ rows });
    }

    // Public view: a flat { key: value } map the pages swap in.
    const rows = await db.pageContent.findMany({
      where: page ? { page } : undefined,
      select: { key: true, value: true },
    });

    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;

    return NextResponse.json(map);
  } catch (error) {
    console.error("GET /api/content error:", error);
    return NextResponse.json({ error: "Failed to load content" }, { status: 500 });
  }
}

// ─── POST (admin only) ──────────────────────────────────────
// Body: { updates: [{ key, value, page?, type?, label?, group?, sort? }, ...] }
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();

  try {
    const body = await request.json();
    const updates = body?.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: "Body must have updates: [{ key, value }]" },
        { status: 400 }
      );
    }

    if (updates.length > 500) {
      return NextResponse.json({ error: "Too many updates at once" }, { status: 400 });
    }

    const results = [];
    const errors = [];
    for (const item of updates) {
      if (!item || typeof item.key !== "string" || typeof item.value !== "string") {
        errors.push({ key: item?.key, error: "key and value (strings) required" });
        continue;
      }

      // Infer page from the key prefix (e.g. "roubla.hero.title" → "roubla")
      const page = item.page || item.key.split(".")[0];

      const data = {
        create: {
          key: item.key,
          value: item.value,
          page,
          type: item.type || "text",
          label: item.label ?? null,
          group: item.group ?? null,
          sort: typeof item.sort === "number" ? item.sort : 0,
        },
        update: {
          value: item.value,
          page, // keep page in sync with the key prefix (self-heals)
          // Only overwrite metadata when explicitly provided (seeding vs. editing)
          ...(item.type ? { type: item.type } : {}),
          ...(item.label !== undefined ? { label: item.label } : {}),
          ...(item.group !== undefined ? { group: item.group } : {}),
          ...(typeof item.sort === "number" ? { sort: item.sort } : {}),
        },
      };

      // Per-row try/catch + retry. The Neon HTTP driver very occasionally
      // fails to serialize a request (a transient "hex escape" parse error);
      // a simple retry clears it, so one row never fails the whole save.
      let saved = false;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        try {
          const row = await dbPg.pageContent.upsert({
            where: { key: item.key },
            create: data.create,
            update: data.update,
            select: { key: true, value: true },
          });
          results.push(row);
          saved = true;
        } catch (rowErr) {
          lastErr = rowErr;
        }
      }
      if (!saved) {
        console.error(`content upsert failed for key "${item.key}":`, lastErr);
        errors.push({ key: item.key, error: String((lastErr as Error)?.message || lastErr) });
      }
    }

    return NextResponse.json({ success: errors.length === 0, results, errors });
  } catch (error) {
    console.error("POST /api/content error:", error);
    return NextResponse.json({ error: "Failed to save content" }, { status: 500 });
  }
}

// ─── DELETE (admin only) ────────────────────────────────────
// Remove content rows. Body: { keys: ["roubla.test", ...] }
export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();

  try {
    const body = await request.json();
    const keys = body?.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      return NextResponse.json({ error: "Body must have keys: [...]" }, { status: 400 });
    }
    const result = await dbPg.pageContent.deleteMany({ where: { key: { in: keys } } });
    return NextResponse.json({ success: true, deleted: result.count });
  } catch (error) {
    console.error("DELETE /api/content error:", error);
    return NextResponse.json({ error: "Failed to delete content" }, { status: 500 });
  }
}
