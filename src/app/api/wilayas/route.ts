import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Returns all active wilayas with delivery prices and stop-desk offices
export async function GET() {
  try {
    const wilayas = await db.wilaya.findMany({
      where: { active: true },
      select: {
        code: true,
        name: true,
        homePrice: true,
        officePrice: true,
        offices: true,
      },
      orderBy: { code: "asc" },
    });

    return NextResponse.json(wilayas);
  } catch (error) {
    console.error("GET /api/wilayas error:", error);
    return NextResponse.json(
      { error: "Failed to load wilayas" },
      { status: 500 }
    );
  }
}
