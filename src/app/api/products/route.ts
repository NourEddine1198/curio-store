import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Returns all active products (games) with their prices and stock
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

    return NextResponse.json(products);
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json(
      { error: "Failed to load products" },
      { status: 500 }
    );
  }
}
