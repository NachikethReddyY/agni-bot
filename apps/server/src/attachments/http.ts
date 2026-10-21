import type { Database } from "bun:sqlite";
import type { Router } from "../models/router";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@agni/protocol";
import { verifyToken } from "../auth/tokens";
import { attachmentInfo, canReadAttachment, deleteDraftAttachment, getAttachment, saveAttachment, validateAttachments } from "./store";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "cache-control": "no-store",
};
let activeUploads = 0;
export async function attachmentRequest(request: Request, db: Database, dbPath: string, router: Router): Promise<Response> {
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const device = token ? await verifyToken(db, token) : null;
  if (!device) return reply({ error: "Pair this device before uploading or opening files." }, 401);
  const path = new URL(request.url).pathname;
  try {
    if (path === "/attachments/validate" && request.method === "POST") {
      const body = await request.json() as { ids?: unknown };
      if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) return reply({ error: "Expected attachment IDs." }, 400);
      const attachments = validateAttachments(db, body.ids, device.id);
      if (attachments.some((file) => file.kind === "image") && !router.supportsVision()) {
        return reply({ error: "No vision model is configured. Set AGNI_VISION_MODELS to a configured image-capable model ID and restart the server, or remove the images." }, 409);
      }
      return reply({ attachments });
    }
    if (path === "/attachments" && request.method === "GET") {
      return reply({ maxFiles: MAX_ATTACHMENTS, maxBytes: MAX_ATTACHMENT_BYTES, vision: router.supportsVision() });
    }
    if (path === "/attachments" && request.method === "POST") {
      if (activeUploads >= 2) return reply({ error: "Two uploads are already processing. Please retry shortly." }, 429);
      activeUploads++;
      try {
        if (Number(request.headers.get("content-length")) > MAX_ATTACHMENT_BYTES + 65_536) return reply({ error: "File exceeds 10 MB." }, 413);
        const data = await request.formData();
        const file = data.get("file");
        if (!(file instanceof File) || data.getAll("file").length !== 1) return reply({ error: "Upload one file at a time." }, 400);
        return reply({ attachment: await saveAttachment(db, dbPath, device.id, file) }, 201);
      } finally { activeUploads--; }
    }
    const id = /^\/attachments\/(att_[a-zA-Z0-9_-]+)$/.exec(path)?.[1];
    if (!id) return reply({ error: "Not found." }, 404);
    const row = getAttachment(db, id);
    if (!row || !canReadAttachment(db, row, device.id)) return reply({ error: "Attachment not found." }, 404);
    if (request.method === "DELETE") {
      await deleteDraftAttachment(db, id, device.id);
      return reply({ ok: true });
    }
    if (request.method === "GET") {
      return new Response(Bun.file(row.path), { headers: {
        ...headers,
        "content-type": attachmentInfo(row).mimeType,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "x-content-type-options": "nosniff",
      } });
    }
    return reply({ error: "Method not allowed." }, 405);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Attachment processing failed." }, 400);
  }
}
