import { NextRequest, NextResponse } from "next/server";
import { sendTelegram, telegramConfigured } from "@/lib/telegram";
import { previewLatestAlert } from "@/lib/checkout-failures";

// GET /api/alerts/test — admin only.
// Proves the Telegram wiring end to end: reports whether the env vars are
// present, and (unless ?dry=1) sends a clearly-labelled test message to the
// alert chat. Exists so the plumbing can be checked without having to break
// a real checkout to see whether alerts work.

export const dynamic = "force-dynamic";

const ADMIN_KEY = process.env.ADMIN_KEY;

export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ?preview=1 — show the REAL alert text for the most recent qualifying
  // failure, rendered by the same builder that sends it. Sends nothing.
  if (new URL(request.url).searchParams.get("preview") === "1") {
    const preview = await previewLatestAlert().catch(() => null);
    return NextResponse.json({
      preview: preview ?? "no alertable failures in the last 24h — nothing to render",
    });
  }

  const configured = telegramConfigured();
  const status = {
    configured,
    hasBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    hasChatId: Boolean(process.env.TELEGRAM_CHAT_ID),
  };

  if (!configured) {
    return NextResponse.json(
      { ...status, sent: false, hint: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the Netlify environment, then redeploy." },
      { status: 200 }
    );
  }

  // ?dry=1 checks configuration without actually messaging anyone.
  if (new URL(request.url).searchParams.get("dry") === "1") {
    return NextResponse.json({ ...status, sent: false, dryRun: true });
  }

  const sent = await sendTelegram(
    [
      "✅ Curio — checkout alerts are working",
      "",
      "This is a test. If you can read this, the store can reach you.",
      "",
      "From now on you get a message here when customers can't check out",
      "for a reason that's our fault — a wilaya refused, stock, a coupon,",
      "or a crash. Typos on the customer's side stay quiet.",
    ].join("\n")
  );

  return NextResponse.json({ ...status, sent });
}
