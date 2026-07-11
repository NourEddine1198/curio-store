// Netlify scheduled function — runs the Ecotrack tracking sync every hour.
// It simply calls our own API route with the sync secret. If SYNC_SECRET
// isn't configured, it does nothing (safe no-op).
export default async () => {
  const secret = process.env.SYNC_SECRET;
  const base = process.env.URL || "https://stirring-marigold-3dd8e9.netlify.app";
  if (!secret) {
    console.log("tracking-sync: SYNC_SECRET not set — skipping");
    return new Response("skipped", { status: 200 });
  }
  try {
    const res = await fetch(`${base}/api/sync/tracking`, {
      method: "POST",
      headers: { "x-sync-secret": secret },
    });
    const body = await res.text();
    console.log("tracking-sync:", res.status, body.slice(0, 500));
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("tracking-sync failed:", e);
    return new Response("error", { status: 200 });
  }
};

export const config = {
  schedule: "14 * * * *", // hourly at :14 (offset avoids top-of-hour crowds)
};
