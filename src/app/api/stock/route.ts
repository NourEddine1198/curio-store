import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Lightweight public endpoint: returns stock counts for all active products.
// The bundle's effective stock = min(goul, roubla) since it contains both.
// Original print run was 500 per game.
const PRINT_RUN = 500;

export async function GET() {
  try {
    const products = await db.product.findMany({
      where: { active: true },
      select: { slug: true, stock: true },
      orderBy: { createdAt: "asc" },
    });

    // Find individual game stocks for bundle calculation
    const goulStock = products.find((p) => p.slug === "goul-bla-matgoul")?.stock ?? 0;
    const roublaStock = products.find((p) => p.slug === "roubla")?.stock ?? 0;

    const result = products.map((p) => {
      // Bundle availability is limited by the scarcer game
      const effectiveStock =
        p.slug === "eid-2026-bundle"
          ? Math.min(goulStock, roublaStock, p.stock)
          : p.stock;

      return {
        slug: p.slug,
        stock: Math.max(0, effectiveStock),
        soldCount: Math.max(0, PRINT_RUN - effectiveStock),
      };
    });

    const response = NextResponse.json({ products: result });
    response.headers.set(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=60"
    );
    return response;
  } catch (error) {
    console.error("GET /api/stock error:", error);
    return NextResponse.json(
      { error: "Failed to load stock" },
      { status: 500 }
    );
  }
}
