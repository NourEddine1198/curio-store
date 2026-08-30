// Netlify scheduled function — the finance autopilot.
//
// Pulls Meta's daily ad spend into the ledger and runs the money watch that
// looks for parcels set to collect nothing. Calls our own API route with the
// sync secret; a no-op if SYNC_SECRET isn't configured.
export default async () => {
  const secret = process.env.SYNC_SECRET;
  const base = process.env.URL || "https://stirring-marigold-3dd8e9.netlify.app";
  if (!secret) {
    console.log("finance-sync: SYNC_SECRET not set — skipping");
    return new Response("skipped", { status: 200 });
  }
  try {
    // Seven days back, not one: Meta revises recent spend for a day or two
    // after the fact, so re-pulling the past week keeps the ledger honest.
    const res = await fetch(`${base}/api/sync/finance?days=7`, {
      method: "POST",
      headers: { "x-sync-secret": secret },
    });
    const body = await res.text();
    console.log("finance-sync:", res.status, body.slice(0, 700));
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("finance-sync failed:", e);
    return new Response("error", { status: 200 });
  }
};

export const config = {
  // 06:20 UTC = 07:20 in Algiers. Late enough that Meta has closed off
  // yesterday, early enough that an alert about a parcel collecting 0 DA
  // lands before the day's boxes go out.
  schedule: "20 6 * * *",
};
