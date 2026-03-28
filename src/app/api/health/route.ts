import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    // Quick DB query to keep Neon database awake
    const productCount = await db.product.count();
    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      products: productCount,
    });
  } catch {
    return NextResponse.json(
      { status: "degraded", timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
