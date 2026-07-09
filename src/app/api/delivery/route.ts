import { NextResponse } from "next/server";
import delivery from "@/data/delivery.json";

// GET /api/delivery — public. Returns the wilaya → commune → stop-desk +
// price reference the checkout dropdowns are built from. Sourced from
// Anderson's live Ecotrack account (see operations/ecotrack + build script).
// Cached hard because it changes rarely; refresh = rebuild the JSON + deploy.
export async function GET() {
  return NextResponse.json(delivery, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
