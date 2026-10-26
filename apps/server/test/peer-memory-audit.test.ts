import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { auditPeerMemory } from "../src/audit/peer-memory";
import { putAgentMemory } from "../src/stores/agent-memories";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("peer memory audit", () => {
  test("identifies candidates and does not modify database", async () => {
    const testDB = openDatabase(":memory:");
    db = testDB;

    // (a) memory citing a turn with a system brief row "Goal: …" => candidate
    testDB.run(
      `INSERT INTO conversations (id, agent_id, active_thread_id, summary, summary_json, summary_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["cnv1", "agent1", null, null, null, 0, new Date().toISOString(), new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO threads (id, conversation_id, agent_id, title, opened_carry, opened_tail, closed_at, closed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["thrA", "cnv1", "agent1", "testA", null, null, null, null, new Date().toISOString(), new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`,
      ["msgA", "thrA", "system", "Goal: do the thing", new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO turns (id, thread_id, agent_id, state, started_at) VALUES (?, ?, ?, ?, ?)`,
      ["turnA", "thrA", "agent1", "done", new Date().toISOString()],
    );
    putAgentMemory(testDB, {
      scope: "agent",
      agentID: "agent1",
      keySlug: "a",
      type: "fact",
      content: "a",
      source: "user",
      sourceTurnIDs: ["turnA"],
    });

    // (b) memory citing a turn whose only system row is "X messaged you: …" => candidate
    testDB.run(
      `INSERT INTO threads (id, conversation_id, agent_id, title, opened_carry, opened_tail, closed_at, closed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["thrB", "cnv1", "agent1", "testB", null, null, null, null, new Date().toISOString(), new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`,
      ["msgB", "thrB", "system", "Vision messaged you: hi", new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO turns (id, thread_id, agent_id, state, started_at) VALUES (?, ?, ?, ?, ?)`,
      ["turnB", "thrB", "agent1", "done", new Date().toISOString()],
    );
    putAgentMemory(testDB, {
      scope: "agent",
      agentID: "agent1",
      keySlug: "b",
      type: "fact",
      content: "b",
      source: "user",
      sourceTurnIDs: ["turnB"],
    });

    // (c) memory whose thread has only a system handoff notice in channel_messages, not in the turn => NOT candidate
    testDB.run(
      `INSERT INTO channels (id, name, agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ["ch1", "chan", "agent1", new Date().toISOString(), new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO channel_messages (id, channel_id, from_type, from_id, text, created_at, ui_hint) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["cm1", "ch1", "system", "system", "handoff notice", new Date().toISOString(), "handoff_notice"],
    );
    testDB.run(
      `INSERT INTO threads (id, conversation_id, agent_id, title, opened_carry, opened_tail, closed_at, closed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["thrC", "cnv1", "agent1", "testC", null, null, null, null, new Date().toISOString(), new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)`,
      ["msgC", "thrC", "user", "hello", new Date().toISOString()],
    );
    testDB.run(
      `INSERT INTO turns (id, thread_id, agent_id, state, started_at) VALUES (?, ?, ?, ?, ?)`,
      ["turnC", "thrC", "agent1", "done", new Date().toISOString()],
    );
    putAgentMemory(testDB, {
      scope: "agent",
      agentID: "agent1",
      keySlug: "c",
      type: "fact",
      content: "c",
      source: "user",
      sourceTurnIDs: ["turnC"],
    });

    // (d) compaction memory with no turn link => unlinkedCompaction
    putAgentMemory(testDB, {
      scope: "agent",
      agentID: "agent1",
      keySlug: "d",
      type: "fact",
      content: "d",
      source: "compaction",
      sourceTurnIDs: [],
    });

    const countBefore = testDB.query("SELECT COUNT(*) as c FROM agent_memories").get() as { c: number };
    const result = auditPeerMemory(testDB);
    const countAfter = testDB.query("SELECT COUNT(*) as c FROM agent_memories").get() as { c: number };

    expect(result.totalMemories).toBe(4);
    expect(result.candidateMemories).toBe(2);
    expect(result.unlinkedCompaction).toBe(1);
    expect(countBefore.c).toBe(countAfter.c);
  });
});