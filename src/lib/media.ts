// Media storage abstraction.
//
// In production (on Netlify) images live in a Netlify Blobs store called
// "media" — built-in object storage, no extra account or signup.
// In local dev (plain `next dev`) Netlify Blobs has no context, so we fall
// back to a git-ignored folder on disk (.media-dev/) so uploads still work
// while testing on this machine.

import { getStore } from "@netlify/blobs";
import { promises as fs } from "fs";
import path from "path";

const DEV_DIR = path.join(process.cwd(), ".media-dev");

export interface StoredMedia {
  data: ArrayBuffer;
  contentType: string;
}

function devPath(key: string) {
  // keys are random hex + extension, so no traversal risk, but be safe
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(DEV_DIR, safe);
}

async function usingBlobs(): Promise<ReturnType<typeof getStore> | null> {
  try {
    // getStore throws (MissingBlobsEnvironment) when not on Netlify.
    return getStore("media");
  } catch {
    return null;
  }
}

export async function putMedia(
  key: string,
  data: ArrayBuffer,
  contentType: string
): Promise<void> {
  const store = await usingBlobs();
  if (store) {
    await store.set(key, data, { metadata: { contentType } });
    return;
  }
  // Dev fallback → disk
  await fs.mkdir(DEV_DIR, { recursive: true });
  await fs.writeFile(devPath(key), Buffer.from(data));
  await fs.writeFile(devPath(key) + ".type", contentType, "utf8");
}

export async function getMedia(key: string): Promise<StoredMedia | null> {
  const store = await usingBlobs();
  if (store) {
    const res = await store.getWithMetadata(key, { type: "arrayBuffer" });
    if (!res) return null;
    const contentType =
      (res.metadata?.contentType as string) || "application/octet-stream";
    return { data: res.data as ArrayBuffer, contentType };
  }
  // Dev fallback → disk
  try {
    const buf = await fs.readFile(devPath(key));
    let contentType = "application/octet-stream";
    try {
      contentType = await fs.readFile(devPath(key) + ".type", "utf8");
    } catch {
      /* no type sidecar */
    }
    return { data: new Uint8Array(buf).buffer, contentType };
  } catch {
    return null;
  }
}
