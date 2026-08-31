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
  // Twice an hour, during Algerian working hours only.
  //
  // This ran every 15 minutes round the clock, which on 31 Aug 2026 was the
  // main reason the database ran out of its monthly compute allowance and the
  // whole store stopped taking orders for a morning. Neon puts an idle
  // database to sleep after 5 minutes, so a wake every 15 means it never
  // actually sleeps — roughly 8 hours a day billed for nothing.
  //
  // The freshness this was tightened for still matters, so it is kept where
  // it earns its keep: 06:00-20:59 UTC = 07:00-21:59 Algiers. A failed
  // delivery now surfaces within half an hour during the day instead of a
  // quarter, and Ecotrack does not move parcels overnight anyway.
  //
  // 96 runs a day -> 30. The overnight gap is what lets the database rest.
  schedule: "14,44 6-20 * * *",
};
