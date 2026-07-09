import { NextRequest, NextResponse } from "next/server";
import { getMedia } from "@/lib/media";

// GET /api/media/<key>  → serves an uploaded image (public, cached).

export async function GET(
  _request: NextRequest,
  { params }: { params: { key: string } }
) {
  try {
    const media = await getMedia(params.key);
    if (!media) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return new NextResponse(media.data, {
      status: 200,
      headers: {
        "Content-Type": media.contentType,
        // Uploaded images are immutable (unique random key), cache hard.
        "Cache-Control": "public, max-age=31536000, immutable",
        // Defense-in-depth: never sniff, and neutralise any active content if a
        // non-raster file is ever served (SVG is already blocked at upload).
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    console.error("GET /api/media error:", error);
    return NextResponse.json({ error: "Failed to load image" }, { status: 500 });
  }
}
