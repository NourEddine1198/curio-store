import { NextRequest, NextResponse } from "next/server";
import { putMedia } from "@/lib/media";
import { randomBytes } from "crypto";

// POST /api/upload  (admin only)
// multipart/form-data with field "file". Stores the image and returns
// { url: "/api/media/<key>" } to drop straight into a content field.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const ADMIN_KEY = process.env.ADMIN_KEY;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export async function POST(request: NextRequest) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const contentType = file.type || "application/octet-stream";
    const ext = EXT[contentType];
    if (!ext) {
      return NextResponse.json(
        { error: "Unsupported file type (use JPG, PNG, WEBP, GIF, AVIF or SVG)" },
        { status: 400 }
      );
    }

    const data = await file.arrayBuffer();
    if (data.byteLength > MAX_BYTES) {
      return NextResponse.json(
        { error: "Image too big (max 8 MB)" },
        { status: 400 }
      );
    }

    const key = `${randomBytes(12).toString("hex")}.${ext}`;
    await putMedia(key, data, contentType);

    return NextResponse.json({ success: true, url: `/api/media/${key}`, key });
  } catch (error) {
    console.error("POST /api/upload error:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
