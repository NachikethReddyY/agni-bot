import type { Database } from "bun:sqlite";
import { mkdir, chmod, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { imageSize } from "image-size";
import { requestToken, verifyToken } from "../auth/tokens";
import { newID, nowISO } from "../util/ids";

const MAX_BYTES = 10 * 1024 * 1024;
const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "cache-control": "private, no-store",
};

interface BackgroundRow { id: string; device_id: string; mime_type: string; size: number; path: string; created_at: string }

function referenced(db: Database, id: string): boolean {
  return db.query<{ profile_json: string }, []>("SELECT profile_json FROM appearance_profiles").all()
    .some((profile) => profile.profile_json.includes(`\"assetID\":\"${id}\"`));
}

export async function backgroundRequest(request: Request, db: Database, dbPath: string): Promise<Response> {
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const token = requestToken(request);
  const device = token ? await verifyToken(db, token) : null;
  if (!device) return reply({ error: "Pair this device before changing appearance." }, 401);
  const path = new URL(request.url).pathname;
  try {
    if (path === "/backgrounds" && request.method === "POST") {
      if (Number(request.headers.get("content-length")) > MAX_BYTES + 65_536) return reply({ error: "Image exceeds 10 MB." }, 413);
      const data = await request.formData();
      const file = data.get("file");
      if (!(file instanceof File) || data.getAll("file").length !== 1) return reply({ error: "Upload one image at a time." }, 400);
      if (file.size === 0 || file.size > MAX_BYTES) return reply({ error: "Images must be between 1 byte and 10 MB." }, 413);
      const stale = db.query<BackgroundRow, [string]>("SELECT * FROM background_assets WHERE created_at < ?")
        .all(new Date(Date.now() - 86_400_000).toISOString());
      for (const row of stale) {
        if (referenced(db, row.id)) continue;
        db.run("DELETE FROM background_assets WHERE id = ?", [row.id]);
        await unlink(row.path).catch(() => undefined);
      }
      const used = db.query<{ size: number }, []>("SELECT COALESCE(SUM(size), 0) AS size FROM background_assets").get()?.size ?? 0;
      if (used + file.size > 500 * 1024 * 1024) return reply({ error: "Background storage is full (500 MB)." }, 507);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const dimensions = imageSize(bytes);
      const mimeType = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[dimensions.type ?? ""];
      if (!mimeType) return reply({ error: "Use a PNG, JPEG, or WebP image." }, 415);
      if (!dimensions.width || !dimensions.height || dimensions.width > 8192 || dimensions.height > 8192 || dimensions.width * dimensions.height > 24_000_000) {
        return reply({ error: "Backgrounds are limited to 8192 pixels per side and 24 megapixels." }, 413);
      }
      const id = newID("bg");
      const directory = join(dirname(dbPath), "backgrounds");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const diskPath = join(directory, id);
      await Bun.write(diskPath, bytes);
      await chmod(diskPath, 0o600);
      try {
        db.run("INSERT INTO background_assets (id, device_id, mime_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [id, device.id, mimeType, file.size, diskPath, nowISO()]);
      } catch (error) { await unlink(diskPath).catch(() => undefined); throw error; }
      return reply({ id }, 201);
    }
    const id = /^\/backgrounds\/(bg_[a-zA-Z0-9_-]+)$/.exec(path)?.[1];
    if (!id) return reply({ error: "Not found." }, 404);
    const row = db.query<BackgroundRow, [string]>("SELECT * FROM background_assets WHERE id = ?").get(id);
    if (!row) return reply({ error: "Background not found." }, 404);
    if (request.method === "GET") {
      return new Response(Bun.file(row.path), { headers: { ...headers, "content-type": row.mime_type, "x-content-type-options": "nosniff" } });
    }
    if (request.method === "DELETE") {
      if (referenced(db, id)) return reply({ error: "Choose another background before deleting this image." }, 409);
      db.run("DELETE FROM background_assets WHERE id = ?", [id]);
      await unlink(row.path).catch(() => undefined);
      return reply({ ok: true });
    }
    return reply({ error: "Method not allowed." }, 405);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Background processing failed." }, 400);
  }
}
