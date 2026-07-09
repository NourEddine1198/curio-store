import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// Always serve fresh product data (stock/new products must not be cached).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;
function isAdmin(req: NextRequest) {
  return Boolean(ADMIN_KEY) && req.headers.get("x-admin-key") === ADMIN_KEY;
}

// GET /api/products            → public: active products, stock hidden
// GET /api/products?admin=1    → admin: ALL products with full fields (for the editor)
export async function GET(request: NextRequest) {
  try {
    const admin = new URL(request.url).searchParams.get("admin");

    if (admin) {
      if (!isAdmin(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const products = await db.product.findMany({
        select: {
          id: true, slug: true, name: true, nameEn: true, description: true,
          price: true, compareAt: true, stock: true, active: true, images: true,
        },
        orderBy: { createdAt: "asc" },
      });
      return NextResponse.json({ products });
    }

    const products = await db.product.findMany({
      where: { active: true },
      select: {
        id: true, slug: true, name: true, nameEn: true, description: true,
        price: true, compareAt: true, images: true, stock: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const safeProducts = products.map((p) => ({ ...p, inStock: p.stock > 0, stock: undefined }));
    return NextResponse.json(safeProducts);
  } catch (error) {
    console.error("GET /api/products error:", error);
    return NextResponse.json({ error: "Failed to load products" }, { status: 500 });
  }
}

// PATCH /api/products  (admin) — edit price / compareAt / stock / active / name.
// Body: { slug (or id), price?, compareAt?, stock?, active?, name?, nameEn? }
export async function PATCH(request: NextRequest) {
  if (!isAdmin(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json();
    const where = body?.slug ? { slug: String(body.slug) } : body?.id ? { id: String(body.id) } : null;
    if (!where) return NextResponse.json({ error: "slug or id required" }, { status: 400 });

    const data: Record<string, unknown> = {};
    if (Number.isFinite(body.price) && body.price >= 0) data.price = Math.floor(body.price);
    if (body.compareAt === null) data.compareAt = null;
    else if (Number.isFinite(body.compareAt) && body.compareAt >= 0) data.compareAt = Math.floor(body.compareAt);
    if (Number.isFinite(body.stock) && body.stock >= 0) data.stock = Math.floor(body.stock);
    if (typeof body.active === "boolean") data.active = body.active;
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.nameEn === "string") data.nameEn = body.nameEn.trim();

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    const product = await db.product.update({
      where,
      data,
      select: { slug: true, name: true, price: true, compareAt: true, stock: true, active: true },
    });
    return NextResponse.json({ success: true, product });
  } catch (error) {
    console.error("PATCH /api/products error:", error);
    return NextResponse.json({ error: "Failed to update product" }, { status: 500 });
  }
}
