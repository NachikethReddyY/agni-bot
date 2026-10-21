import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mintToken, revokeDevice, verifyToken } from "../src/auth/tokens";
import { openDatabase, readMeta, migrate, writeMeta } from "../src/db";
import { MIGRATIONS } from "../src/db/migrations";
import {
  appendMessage,
  createThread,
  createTurn,
  finishTurn,
  getThread,
  recentMessages,
} from "../src/stores/threads";

function freshDb() {
  return openDatabase(":memory:");
}

describe("migrations", () => {
  test("create the full schema, FTS5 included", () => {
    const db = freshDb();
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((row) => row.name);
    for (const table of [
      "devices",
      "threads",
      "turns",
      "messages",
      "usage_ledger",
      "approvals",
      "tasks",
      "links",
      "memories",
      "jobs",
      "memories_fts",
      "links_fts",
      "conversations",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  test("migration 7 backfills one conversation per agent from pre-existing threads", () => {
    // Reproduce a pre-conversation database: apply migrations 1..6, insert
    // threads the old-fashioned way, then let the pending migration run.
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);");
    for (const migration of MIGRATIONS.filter((entry) => entry.id <= 6)) {
      db.transaction(() => db.exec(migration.sql))();
      db.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", [
        migration.id,
        migration.name,
        "test",
      ]);
    }
    const insert = (id: string, agentID: string): void => {
      db.run("INSERT INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)", [id, agentID, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"]);
    };
    insert("thr_first", "agni");
    insert("thr_second", "agni");
    insert("thr_scout", "scout");

    const ran = migrate(db);
    expect(ran).toEqual(MIGRATIONS.filter((entry) => entry.id > 6).map((entry) => entry.id));

    // One conversation per agent; every pre-existing thread assigned; the
    // newest agni block is the conversation's active one.
    const conversations = db
      .query<{ agent_id: string; active_thread_id: string | null }, []>("SELECT agent_id, active_thread_id FROM conversations ORDER BY agent_id")
      .all();
    expect(conversations.map((row) => row.agent_id)).toEqual(["agni", "scout"]);
    const agniConversation = conversations.find((row) => row.agent_id === "agni")!;
    expect(agniConversation.active_thread_id).not.toBeNull();

    const rows = db
      .query<{ id: string; conversation_id: string | null }, []>("SELECT id, conversation_id FROM threads ORDER BY id")
      .all();
    expect(rows.find((row) => row.id === "thr_first")?.conversation_id).not.toBeNull();
    expect(rows.find((row) => row.id === "thr_second")?.conversation_id).toBe(
      rows.find((row) => row.id === "thr_first")?.conversation_id,
    );
    expect(rows.find((row) => row.id === "thr_scout")?.conversation_id).not.toBe(
      rows.find((row) => row.id === "thr_first")?.conversation_id,
    );
    db.close();
  });

  test("write-time indexes are searchable (S2/S4)", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO memories (id, text, summary, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["mem_1", "my passport expires in March 2029", "passport expiry Mar 2029", "travel", "now", "now"],
    );
    db.run("INSERT INTO memories_fts (id, text, summary) VALUES (?, ?, ?)", [
      "mem_1",
      "my passport expires in March 2029",
      "passport expiry Mar 2029",
    ]);
    const rows = db
      .query<{ id: string }, [string]>("SELECT id FROM memories_fts WHERE memories_fts MATCH ?")
      .all("passport");
    expect(rows.map((row) => row.id)).toEqual(["mem_1"]);
    db.close();
  });

  test("meta round trip", () => {
    const db = freshDb();
    expect(readMeta(db, "seq")).toBeNull();
    writeMeta(db, "seq", "42");
    writeMeta(db, "seq", "43");
    expect(readMeta(db, "seq")).toBe("43");
    db.close();
  });
});

describe("device tokens", () => {
  test("mint → verify → revoke", async () => {
    const db = freshDb();
    const { device, token } = await mintToken(db, "cli-test");
    expect(token.startsWith("agni_")).toBe(true);

    const verified = await verifyToken(db, token);
    expect(verified?.id).toBe(device.id);

    const bogus = await verifyToken(db, "agni_not-a-real-token");
    expect(bogus).toBeNull();

    const revoked = revokeDevice(db, device.id.slice(0, 12)); // prefix match
    expect(revoked?.id).toBe(device.id);
    expect(await verifyToken(db, token)).toBeNull();
    db.close();
  });
});

describe("thread store", () => {
  test("message order survives same-millisecond writes", () => {
    const db = freshDb();
    const thread = createThread(db, "agni", " ");
    expect(getThread(db, thread.id)?.id).toBe(thread.id);

    appendMessage(db, { threadID: thread.id, role: "user", text: "one" });
    appendMessage(db, { threadID: thread.id, role: "assistant", text: "two" });
    appendMessage(db, { threadID: thread.id, role: "user", text: "three" });

    const recent = recentMessages(db, thread.id, 2);
    expect(recent.map((message) => message.text)).toEqual(["two", "three"]);
    db.close();
  });

  test("turn lifecycle persists stop reason and usage", () => {
    const db = freshDb();
    const thread = createThread(db, "agni");
    const turnID = "trn_test";
    createTurn(db, { id: turnID, threadID: thread.id, agentID: "agni" });
    finishTurn(db, { id: turnID, stopReason: "end", provider: "groq", model: "fast-small", latencyMs: 412 });

    const row = db
      .query<{ state: string; stop_reason: string; provider: string }, [string]>(
        "SELECT state, stop_reason, provider FROM turns WHERE id = ?",
      )
      .get(turnID);
    expect(row).toMatchObject({ state: "done", stop_reason: "end", provider: "groq" });
    db.close();
  });
});
