import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Returns all active products (games) with prices and availability
// NOTE: Exact stock count is hidden from public. Only shows "in stock" or "sold out".
export async function GET() {
  try {
    const products = await db.product.findMany({
      where: { active: true },
      select: {
        id: true,
        slug: true,
        name: true,
        nameEn: true,
        description: true,
        price: true,
        compareAt: true,
        images: true,
        stock: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Don't expose exact stock counts publicly — just show availability
    const safeProducts = products.map((p) => ({
      ...p,
      inStock: p.stock > 0,
      stock: undefined, // hide exact number
    }));

    return NextResponse.json(safeProducts);
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json(
      { error: "Failed to load products" },
      { status: 500 }
    );
  }
}
