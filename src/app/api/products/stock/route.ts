import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const ADMIN_KEY = process.env.ADMIN_KEY;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// GET /api/products/stock — Admin: returns exact stock for all products
export async function GET(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return unauthorized();
  }

  const products = await db.product.findMany({
    select: { id: true, slug: true, name: true, nameEn: true, stock: true, active: true },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ products });
}

// PATCH /api/products/stock — Admin: update stock for one or more products
// Body: { updates: [{ slug: "roubla", stock: 40 }, ...] }
export async function PATCH(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return unauthorized();
  }

  try {
    const body = await request.json();
    const updates = body?.updates;

    if (!Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json(
        { error: "Body must have updates: [{ slug, stock }]" },
        { status: 400 }
      );
    }

    const results = [];

    for (const item of updates) {
      if (!item.slug || typeof item.stock !== "number" || item.stock < 0) {
        results.push({ slug: item.slug, error: "Invalid slug or stock value" });
        continue;
      }

      const product = await db.product.update({
        where: { slug: item.slug },
        data: { stock: Math.floor(item.stock) },
        select: { slug: true, name: true, stock: true },
      });

      results.push(product);
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error("PATCH /api/products/stock error:", error);
    return NextResponse.json(
      { error: "Failed to update stock" },
      { status: 500 }
    );
  }
}
