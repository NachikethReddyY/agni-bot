import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { mintToken } from "../src/auth/tokens";
import { attachmentRequest } from "../src/attachments/http";
import { getAttachment, messageAttachments, saveAttachment, withAttachmentContent } from "../src/attachments/store";
import { Router } from "../src/models/router";
import { HealthTracker } from "../src/models/health";
import { createThread, recentMessages } from "../src/stores/threads";
import { runTaskTurn } from "../src/agent/task-loop";
import type { AttachmentInfo } from "@agni/protocol";
import { AgniSocket } from "../../../apps/cli/src/client";
import { startServer, type RunningServer } from "../src/ws/server";
import { loadConfig } from "../src/config";

const directory = mkdtempSync(join(tmpdir(), "agni-files-test-"));
const databases: ReturnType<typeof openDatabase>[] = [];
let server: RunningServer | undefined;
let socket: AgniSocket | undefined;
afterEach(() => { socket?.close(); server?.stop(); socket = undefined; server = undefined; for (const db of databases.splice(0)) db.close(); });
import { afterAll } from "bun:test";
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const provider = { id: "test", label: "Test", apiKey: "fixture", baseUrl: "https://fixture.invalid/v1", model: "vision-test", supportsVision: true };
function response() { return new Response('data: {"choices":[{"delta":{"content":"Read the file."}}]}\n\ndata: [DONE]\n\n'); }
async function setup(vision = true, fetcher: typeof fetch = (async () => response()) as unknown as typeof fetch) {
  const dbPath = join(directory, `${crypto.randomUUID()}.sqlite`);
  const db = openDatabase(dbPath); databases.push(db);
  const { device, token } = await mintToken(db, "attachment-test");
  const router = new Router([{ ...provider, supportsVision: vision }], new HealthTracker(), fetcher);
  const request = (path: string, init: RequestInit = {}) => attachmentRequest(new Request(`http://localhost${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers },
  }), db, dbPath, router);
  const upload = async (file: File) => {
    const body = new FormData(); body.append("file", file);
    return request("/attachments", { method: "POST", body });
  };
  return { db, dbPath, device, token, router, request, upload };
}
const png = () => new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")], "pixel.png", { type: "image/png" });

function pdf(text: string): File {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([body], "notes.pdf", { type: "application/pdf" });
}

test("uploads require auth, validate bytes/types, and keep drafts private", async () => {
  const { db, dbPath, router, request, upload } = await setup();
  expect((await attachmentRequest(new Request("http://localhost/attachments"), db, dbPath, router)).status).toBe(401);
  expect((await upload(new File(["not an image"], "fake.png"))).status).toBe(400);
  expect((await upload(new File(["x"], "run.exe"))).status).toBe(400);
  expect((await upload(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.txt"))).status).toBe(400);
  const uploaded = await upload(new File(["hello\nworld"], "notes.txt"));
  expect(uploaded.status).toBe(201);
  const { attachment } = await uploaded.json() as { attachment: AttachmentInfo };
  expect(await (await request(`/attachments/${attachment.id}`)).text()).toBe("hello\nworld");
  const other = await mintToken(db, "another-device");
  expect((await request(`/attachments/${attachment.id}`, { headers: { Authorization: `Bearer ${other.token}` } })).status).toBe(404);
  expect((await request("/attachments/validate", { method: "POST", body: JSON.stringify({ ids: [attachment.id, attachment.id] }) })).status).toBe(400);
  await request(`/attachments/${attachment.id}`, { method: "DELETE" });
  expect(getAttachment(db, attachment.id)).toBeNull();
});

test("PDF text extraction works; blank and malformed PDFs explain the failure", async () => {
  const { db, upload } = await setup();
  const uploaded = await upload(pdf("Project launch is Friday"));
  const payload = await uploaded.json() as { attachment: AttachmentInfo; error?: string };
  expect(payload.error).toBeUndefined();
  expect(getAttachment(db, payload.attachment.id)?.extracted_text).toContain("Project launch is Friday");
  const blank = await upload(pdf(""));
  expect(blank.status).toBe(400);
  expect((await blank.json() as { error: string }).error).toContain("no selectable text");
  expect((await upload(new File(["%PDF-broken"], "broken.pdf"))).status).toBe(400);
}, 30_000);

test("task attachments are stored under the configured database data directory", async () => {
  const { db, dbPath, device } = await setup();
  const attachment = await saveAttachment(db, dbPath, device.id, new File(["task document"], "notes.txt"), "task");
  expect(getAttachment(db, attachment.id)?.path).toBe(join(directory, "attachments", "documents", attachment.id));
});

test("image preflight rejects text-only models; image routing skips them", async () => {
  const { upload, request } = await setup(false);
  const { attachment } = await (await upload(png())).json() as { attachment: AttachmentInfo };
  expect((await request("/attachments/validate", { method: "POST", body: JSON.stringify({ ids: [attachment.id] }) })).status).toBe(409);
  const calls: string[] = [];
  const router = new Router([{ ...provider, id: "text", model: "text-only", supportsVision: false }, provider], new HealthTracker(), (async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)).model); return response();
  }) as unknown as typeof fetch);
  await router.route({ messages: [{ role: "user", content: "Look", images: ["data:image/png;base64,fixture"] }], firstTokenTimeoutMs: 1000, onDelta() {} });
  expect(calls).toEqual(["vision-test"]);
});

test("attachments reach model requests, stay out of session base64, and persist for follow-ups", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const { db, dbPath, device, router } = await setup(true, (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body))); return response();
  }) as unknown as typeof fetch);
  const text = await saveAttachment(db, dbPath, device.id, new File(["launch code: lilac"], "notes.txt"));
  const image = await saveAttachment(db, dbPath, device.id, png());
  const thread = createThread(db, "agni");
  const persona = { id: "agni", name: "Agni", color: "#fff", role: "assistant", systemPromptTemplate: "Help", systemPrompt: "Help", tools: [] };
  const run = (prompt: string, attachmentIDs?: string[]) => runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
    threadID: thread.id, text: prompt, attachmentIDs, persona, emit() {}, signal: new AbortController().signal,
  });
  expect((await run("Read these", [text.id, image.id])).stopReason).toBe("end");
  expect(JSON.stringify(requests[0])).toContain("launch code: lilac");
  expect(JSON.stringify(requests[0])).toContain('"type":"image_url"');
  const message = recentMessages(db, thread.id, 10).find((row) => row.role === "user")!;
  expect(messageAttachments(db, message.id)).toHaveLength(2);
  const session = db.query<{ message_log: string }, []>("SELECT message_log FROM agent_sessions").get()!;
  expect(session.message_log).not.toContain("base64");
  expect((await run("What was in the file?")).stopReason).toBe("end");
  expect(JSON.stringify(requests[1])).toContain("launch code: lilac");
  const bounded = await withAttachmentContent(db, [{ role: "user", content: "x", attachmentIDs: Array(10).fill(text.id) }]);
  expect(bounded[0]!.content.length).toBeLessThan(25_000);
});

test("HTTP upload → WebSocket send → durable history retains attachment metadata", async () => {
  const { db, dbPath, token, router } = await setup();
  const config = loadConfig({ AGNI_DB_PATH: dbPath, AGNI_PLUGINS_PATH: join(directory, "empty-plugins.json") });
  config.port = 0;
  server = startServer(config, db, router);
  const base = `http://127.0.0.1:${server.port}`;
  const body = new FormData(); body.append("file", new File(["socket proof"], "proof.txt"));
  const result = await fetch(`${base}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });
  expect(result.status).toBe(201);
  const { attachment } = await result.json() as { attachment: AttachmentInfo };
  socket = await AgniSocket.connect(base.replace("http:", "ws:") + "/ws", token, "test");
  const conversation = await socket.conversationOpen("", "ea");
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("turn did not finish")), 5000);
    socket!.onFrame((frame) => { if (frame.type === "turn.end") { clearTimeout(timer); resolve(); } });
  });
  socket.send({ type: "msg.send", channelId: "main", text: "Read the file", files: [attachment.id] });
  await done;
  const history = await socket.conversationHistory(conversation.conversationID);
  expect(history.messages.find((message) => message.text === "Read the file")?.attachments?.[0]?.id).toBe(attachment.id);
});
