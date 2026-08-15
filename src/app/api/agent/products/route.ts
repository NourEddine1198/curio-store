import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentFromRequest } from "@/lib/agent-guard";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// GET /api/agent/products — the catalog as the CONSOLE needs to see it.
//
// The public /api/products hides `active: false`, which is right for the shop
// but wrong on the phone: retired products (قول بلا متقول, باك العيد) still sit
// inside real orders that agents have to open, edit and reprice. When the
// console read the public list those orders showed a product the picker could
// not offer back, so removing a line was a one-way door.
//
// Retired products come back with active:false so the UI can label them and
// stop anyone quietly selling a discontinued game on a NEW order.
export async function GET(request: NextRequest) {
  const agent = agentFromRequest(request);
  if (!agent) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const products = await db.product.findMany({
      select: { slug: true, name: true, price: true, active: true },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    });
    return NextResponse.json({ products });
  } catch (error) {
    console.error("GET /api/agent/products error:", error);
    return NextResponse.json({ error: "Failed to load products" }, { status: 500 });
  }
}
