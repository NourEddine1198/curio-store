import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/pricing — public. Current prices for the key products so the
// marketing pages display live prices (and reflect backend edits without a
// re-deploy). Includes the bundle even while it's inactive (price only).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const SLUGS = ["roubla", "dlala", "roubla-dlala-pack", "goul-bla-matgoul"];

export async function GET() {
  try {
    const products = await db.product.findMany({
      where: { slug: { in: SLUGS } },
      select: { slug: true, price: true, compareAt: true, stock: true, active: true },
    });
    const map: Record<string, { price: number; compareAt: number | null; inStock: boolean; active: boolean }> = {};
    for (const p of products) {
      map[p.slug] = { price: p.price, compareAt: p.compareAt, inStock: p.stock > 0, active: p.active };
    }
    return NextResponse.json(map, { headers: { "Cache-Control": "public, max-age=120" } });
  } catch (error) {
    console.error("GET /api/pricing error:", error);
    return NextResponse.json({}, { status: 500 });
  }
}
