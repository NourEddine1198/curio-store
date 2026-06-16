// ─────────────────────────────────────────────────────────────
// Netlify Scheduled Function — auto-runs the delivery sync.
//
// Fires the store's own /api/sync/delivery?apply=1 endpoint on a
// schedule so DELIVERED / RETURNED outcomes get frozen into the DB
// *before* they age off Ecotrack's short in-process list. The heavy
// lifting (read Ecotrack, match, guarded writes, cap, audit) lives in
// the Next.js route — this just triggers it with the secret.
//
// Safe: the route is read-only against Ecotrack and only ever writes
// DELIVERED/RETURNED (never CANCELLED, never stock). See
// DELIVERY-SYNC-PLAN.md. Runs only on the deployed site (not locally).
// ─────────────────────────────────────────────────────────────

export const config = {
  // Every 6 hours (UTC). Change to "@daily" for once a day.
  schedule: "0 */6 * * *",
};

export default async () => {
  const base =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    "https://stirring-marigold-3dd8e9.netlify.app";
  const secret = process.env.SYNC_SECRET;

  if (!secret) {
    console.error("[sync-delivery cron] SYNC_SECRET not set — skipping run.");
    return new Response("SYNC_SECRET not set", { status: 500 });
  }

  try {
    const res = await fetch(`${base}/api/sync/delivery?apply=1`, {
      method: "POST",
      headers: { "x-sync-secret": secret },
    });
    const text = await res.text();
    console.log(`[sync-delivery cron] ${res.status} ${text.slice(0, 600)}`);
    return new Response(text, { status: res.status });
  } catch (err) {
    console.error("[sync-delivery cron] failed:", err);
    return new Response("sync cron failed", { status: 500 });
  }
};
