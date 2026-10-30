import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ClientFrame } from "@agni/protocol";
import { mintToken, revokeDevice } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase, openDatabaseForCLI } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { markMemoryUsed, putAgentMemory } from "../src/stores/agent-memories";
import { startServer, type RunningServer } from "../src/ws/server";

/** H22, H32, H36, M1, M35, M40: server reliability fixes. */

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "k", model: "m" };
const encoder = new TextEncoder();

function sse(body: unknown): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  }), { status: 200 });
}
const text = (content: string) => sse({ choices: [{ delta: { content } }] });
const toolCall = (name: string, args: unknown) =>
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });

type Frame = { type: string; seq: number; [key: string]: unknown };

class Client {
  frames: Frame[] = [];
  closed: { code: number } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data)) as Frame));
    ws.addEventListener("close", (event) => { this.closed = { code: event.code }; });
  }
  static async open(url: string, token: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const client = new Client(ws);
    client.send({ type: "hello", v: PROTOCOL_VERSION, token, device: "t" });
    await client.waitFor((frame) => frame.type === "hello.ok");
    return client;
  }
  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }
  async waitFor(match: (frame: Frame) => boolean, timeoutMs = 4000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(match);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error("timed out waiting for a frame");
  }
}

async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function config(dbPath: string): Config {
  return {
    host: "127.0.0.1", port: 0, dbPath, pidPath: "", logPath: "", providers: [provider],
    firstTokenTimeoutMs: 60_000, turnTimeoutMs: 60_000, helloTimeoutMs: 2000, frameLogCapacity: 100,
    jobPollMs: 1000, maxConcurrentTurns: 4, messageBatchMs: 50, pluginsPath: "",
  } as Config;
}

function serve(db: Database, fetchMock: typeof fetch, dbPath = ":memory:"): RunningServer {
  const server = startServer(config(dbPath), db, new Router([provider], new HealthTracker(), fetchMock));
  cleanups.push(() => server.stop());
  return server;
}

function memoryDB(): Database {
  const db = openDatabase(":memory:");
  db.run("UPDATE agents SET onboarded = 1 WHERE id = 'ea'");
  cleanups.push(() => db.close());
  return db;
}

const queuedCount = (db: Database) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM queued_messages").get()!.n;

describe("H22 durable owner messages", () => {
  test("a message queued behind a busy thread is on disk, and runs once", async () => {
    const db = memoryDB();
    const { token } = await mintToken(db, "t");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const server = serve(db, (async () => {
      calls += 1;
      if (calls === 1) await gate;
      return text("ok");
    }) as unknown as typeof fetch);
    const client = await Client.open(`ws://127.0.0.1:${server.port}/ws`, token);
    client.send({ type: "msg.send", channelId: "main", text: "first question" });
    await client.waitFor((frame) => frame.type === "turn.start");
    client.send({ type: "msg.send", channelId: "main", text: "follow up" });
    await client.waitFor((frame) => frame.type === "status.update" && String(frame.text).startsWith("Queued"));
    expect(db.query<{ text: string }, []>("SELECT text FROM queued_messages").all().map((row) => row.text)).toEqual(["follow up"]);
    release();
    await client.waitFor((frame) => frame.type === "msg.new" && frame.text === "follow up");
    await until(() => queuedCount(db) === 0);
  });

  test("a row left queued by a dead process is replayed at boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-h22-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "agni.db");
    let db = openDatabase(path);
    db.run("UPDATE agents SET onboarded = 1 WHERE id = 'ea'");
    const { device } = await mintToken(db, "t");
    db.run(
      "INSERT INTO queued_messages (id, frame, text, device_id, device_name, created_at) VALUES ('qmsg_1', ?, 'survive the restart', ?, 't', ?)",
      [JSON.stringify({ type: "msg.send", channelId: "main", text: "survive the restart" }), device.id, new Date().toISOString()],
    );
    db.close(); // the "crash"
    db = openDatabase(path);
    const reopened = db;
    cleanups.push(() => reopened.close());
    serve(db, (async () => text("back")) as unknown as typeof fetch, path);
    const stored = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM channel_messages WHERE text = 'survive the restart'").get()!.n;
    await until(() => stored() === 1 && queuedCount(db) === 0);
    await Bun.sleep(100);
    expect(stored()).toBe(1);
  });
});

describe("H36 + H32 reconnect", () => {
  test("a reconnecting client is re-sent the pending approval", async () => {
    const db = memoryDB();
    const { token } = await mintToken(db, "t");
    let calls = 0;
    const server = serve(db, (async () => {
      calls += 1;
      return calls === 1 ? toolCall("bash", { command: "rm -rf /tmp/agni-test-nothing" }) : text("done");
    }) as unknown as typeof fetch);
    const url = `ws://127.0.0.1:${server.port}/ws`;
    const first = await Client.open(url, token);
    first.send({ type: "msg.send", channelId: "main", text: "clean up please" });
    const approval = await first.waitFor((frame) => frame.type === "approval.request");
    first.ws.close();

    const second = await Client.open(url, token);
    second.send({ type: "resync", lastSeq: approval.seq });
    const again = await second.waitFor((frame) => frame.type === "approval.request");
    expect(again.requestID).toBe(approval.requestID);
  });

  test("live broadcasts wait for the resync replay: seq strictly increases", async () => {
    const db = memoryDB();
    const { token } = await mintToken(db, "t");
    const server = serve(db, (async () => text("x")) as unknown as typeof fetch);
    server.emit({ type: "status.update", channelId: "main", text: "old 1", transient: true });
    server.emit({ type: "status.update", channelId: "main", text: "old 2", transient: true });
    const client = await Client.open(`ws://127.0.0.1:${server.port}/ws`, token);
    server.emit({ type: "status.update", channelId: "main", text: "live", transient: true });
    await Bun.sleep(50);
    client.send({ type: "resync", lastSeq: 0 });
    await client.waitFor((frame) => frame.text === "live");
    await Bun.sleep(50);
    const seqs = client.frames.filter((frame) => frame.type !== "error" && frame.type !== "hello.ok").map((frame) => frame.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(client.frames.some((frame) => frame.text === "old 1")).toBe(true);
  });
});

describe("M1 revocation", () => {
  test("revoking a device closes its socket and drops its rights", async () => {
    const db = memoryDB();
    const { token, device } = await mintToken(db, "t");
    const server = serve(db, (async () => text("x")) as unknown as typeof fetch);
    const idle = await Client.open(`ws://127.0.0.1:${server.port}/ws`, token);
    const active = await Client.open(`ws://127.0.0.1:${server.port}/ws`, token);
    revokeDevice(db, device.id);
    // A frame after revocation is refused at once.
    active.send({ type: "thread.list" } as ClientFrame);
    await active.waitFor((frame) => frame.type === "error" && frame.code === "unauthorized");
    await until(() => active.closed !== null);
    // An idle socket is closed by the sweep.
    await until(() => idle.closed !== null, 4000);
    expect(idle.closed?.code).toBe(4003);
  });
});

describe("M35 database access", () => {
  test("the daemon's handle waits on a busy database", () => {
    const db = memoryDB();
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  });

  test("a CLI open refuses a database behind this build and does not migrate it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agni-m35-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "agni.db");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
    for (const migration of MIGRATIONS.filter((m) => m.id <= 41)) {
      old.exec(migration.sql);
      old.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, 'test')", [migration.id, migration.name]);
    }
    old.close();
    expect(() => openDatabaseForCLI(path)).toThrow(/schema 41/);
    const check = new Database(path, { readonly: true });
    expect(check.query<{ id: number }, []>("SELECT max(id) AS id FROM schema_migrations").get()?.id).toBe(41);
    check.close();
    expect(() => openDatabaseForCLI(join(dir, "missing.db"))).toThrow(/no database/);

    openDatabase(path).close();
    const cli = openDatabaseForCLI(path);
    expect(cli.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    cli.close();
  });
});

describe("M40 FTS triggers", () => {
  test("markMemoryUsed does not rewrite the FTS row", () => {
    const db = memoryDB();
    const memory = putAgentMemory(db, { scope: "global_user", agentID: null, keySlug: "zebra", type: "fact", content: "the owner likes zebras" });
    const rowid = db.query<{ rowid: number }, [string]>("SELECT rowid FROM agent_memories WHERE id = ?").get(memory.id)!.rowid;
    const hits = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_memories_fts WHERE agent_memories_fts MATCH 'zebras'").get()!.n;
    expect(hits()).toBe(1);
    // Pull the row out of the index by hand: a trigger that fires would put it back.
    const row = db.query<{ content: string; tags: string | null; key_slug: string }, [number]>("SELECT content, tags, key_slug FROM agent_memories WHERE rowid = ?").get(rowid)!;
    db.run("INSERT INTO agent_memories_fts(agent_memories_fts, rowid, content, tags, key_slug) VALUES ('delete', ?, ?, ?, ?)", [rowid, row.content, row.tags, row.key_slug]);
    expect(hits()).toBe(0);
    markMemoryUsed(db, [memory.id]);
    expect(hits()).toBe(0);
    const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'agent_memories_fts_au'").get()!.sql;
    expect(sql).toContain("AFTER UPDATE OF content, tags, key_slug");
  });
});
