// ─── Telegram alerts ────────────────────────────────────────
// Pushes ops alerts to the founder's phone. Same bot and same chat the DM
// agent already escalates to (see `agent meta + tiktok/src/connectors/
// telegram.py`) so everything lands in one place he already watches.
//
// Config — both must be set in the Netlify environment:
//   TELEGRAM_BOT_TOKEN — from @BotFather
//   TELEGRAM_CHAT_ID   — the chat alerts land in
// If either is missing this module quietly does nothing, so a missing env
// var can never take the store down.
//
// HARD RULE, same as the failure log: sending must never break a checkout.
// Every function swallows its own errors.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Telegram's hard cap is 4096; stay well under it.
const MAX_LEN = 3500;

export function telegramConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

/**
 * Send a plain-text Telegram message. Returns true on success, false on any
 * failure (logged, never thrown).
 *
 * Deliberately no parse_mode: customer names and Arabic messages routinely
 * contain _ * [ ` which Telegram rejects as bad markdown. Plain text always
 * delivers — the Python connector learned the same lesson.
 */
export async function sendTelegram(text: string): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn("[Telegram] skipped: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
    return false;
  }
  const body = (text || "").trim();
  if (!body) return false;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: body.length > MAX_LEN ? body.slice(0, MAX_LEN) + "…" : body,
        disable_web_page_preview: true,
      }),
      // Netlify functions have a hard timeout; don't let Telegram hold a
      // checkout response hostage if their API is slow.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[Telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Telegram] send failed:", err);
    return false;
  }
}
