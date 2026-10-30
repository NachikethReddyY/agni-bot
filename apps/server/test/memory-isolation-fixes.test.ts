import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import type { Router } from "../src/models/router";
import { HealthTracker } from "../src/models/health";
import { Router as RealRouter } from "../src/models/router";
import { JobRunner } from "../src/jobs/runner";
import { registerTaggerJob, scheduleTagger } from "../src/jobs/tagger";
import { registerRolloverJob } from "../src/jobs/rollover";
import { applyTaggerItems, type TaggedItem } from "../src/agent/tagger";
import { compactChannelHistory } from "../src/agent/compactor";
import { rolloverIfNeeded } from "../src/agent/rollover";
import { isThreadActive, runTaskTurn } from "../src/agent/task-loop";
import { appendChannelMessage, createChannel } from "../src/stores/channels";
import { listAgentMemories, putAgentMemory, searchMemoriesByVector, setMemoryEmbedding } from "../src/stores/agent-memories";
import { ensureConversation, openSession } from "../src/stores/conversations";
import { appendMessage, createThread } from "../src/stores/threads";
import { listJobs } from "../src/stores/jobs";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function item(patch: Partial<TaggedItem> = {}): TaggedItem {
  return {
    kind: "fact", text: "The owner prefers dark mode.", scope: "user", visibility: "shared", source: "user",
    salience: 0.6, confidence: 0.9, entities: [], ttl: null, source_turn_ids: [], ...patch,
  };
}

describe("H24 tagger channel isolation", () => {
  test("only the payload channel is tagged, with that channel's bot", async () => {
    db = openDatabase(":memory:");
    const a = createChannel(db, { type: "main", visibility: "public", name: "A", agentID: "ea" });
    const b = createChannel(db, { type: "main", visibility: "public", name: "B", agentID: "researcher" });
    appendChannelMessage(db, { channelID: a.id, fromType: "user", fromID: "device-1", text: "I like tea." });
    appendChannelMessage(db, { channelID: b.id, fromType: "user", fromID: "device-1", text: "My secret plan." });
    let prompt = "";
    const router = {
      route: async (req: { messages: Array<{ content: string }> }) => {
        prompt = req.messages[1]!.content;
        return { text: JSON.stringify({ items: [item({ scope: "agent", text: "Likes tea." })], ephemeral: false }) };
      },
    } as unknown as Router;
    scheduleTagger(db, { channelID: b.id, turns: 5 });
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    await runner.tick();
    expect(prompt).toContain("My secret plan.");
    expect(prompt).not.toContain("I like tea.");
    expect(listAgentMemories(db, { scope: "agent", agentID: "researcher", limit: 10 })).toHaveLength(1);
    expect(listAgentMemories(db, { scope: "agent", agentID: "device-1", limit: 10 })).toHaveLength(0);
    expect(listAgentMemories(db, { scope: "agent", agentID: "ea", limit: 10 })).toHaveLength(0);
    const untaggedA = db.query<{ c: number }, [string]>("SELECT count(*) AS c FROM channel_messages WHERE channel_id = ? AND tagged_at IS NULL").get(a.id)?.c;
    expect(untaggedA).toBe(1);
  });
});

describe("H25 source comes from the stored row", () => {
  test("a model-claimed user source over a bot row makes no global fact", () => {
    db = openDatabase(":memory:");
    const ch = createChannel(db, { type: "main", visibility: "public", name: "A", agentID: "ea" });
    const row = appendChannelMessage(db, { channelID: ch.id, fromType: "agent", fromID: "ea", text: "Quoted email: user likes X" });
    const applied = applyTaggerItems(db, { items: [item({ source: "user", source_turn_ids: [row.id] })], agentID: "ea", sourceTurnIDs: [row.id] });
    expect(applied.refused).toBe(1);
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea", limit: 10 })).toHaveLength(0);
  });
});

describe("H26 compactor visibility", () => {
  test("another bot's private owner fact is not in the prompt", async () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, { scope: "global_user", agentID: "ea", keySlug: "secret", content: "PRIVATE-OWNER-FACT", visibility: "private" });
    for (let i = 0; i < 37; i++) appendChannelMessage(db, { channelID: "main", fromType: i % 2 ? "agent" : "user", fromID: "x", text: "m" + i });
    let prompt = "";
    let signal: AbortSignal | undefined;
    const router = {
      route: async (req: { messages: Array<{ content: string }>; signal: AbortSignal }) => {
        prompt = req.messages[0]!.content; signal = req.signal;
        return { text: JSON.stringify({ updated_summary: "s" }) };
      },
    } as unknown as Router;
    await compactChannelHistory(db, router, "main", "researcher");
    expect(prompt).not.toContain("PRIVATE-OWNER-FACT");
    // H15: a stalled stream must eventually release its router slot.
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
  });
});

describe("H27/M39 vector search", () => {
  test("finds the best match among 60 embedded rows", () => {
    db = openDatabase(":memory:");
    for (let i = 0; i < 60; i++) {
      const row = putAgentMemory(db, { scope: "global_user", keySlug: `k${i}`, content: `fact ${i}` });
      setMemoryEmbedding(db, row.id, Float32Array.from(i === 59 ? [1, 0, 0] : [0, 1, i / 100]), "m");
    }
    const hits = searchMemoriesByVector(db, { vector: Float32Array.from([1, 0, 0]), callerAgentID: "ea", limit: 3 });
    expect(hits[0]!.row.key_slug).toBe("k59");
  });

  test("archived memories are not retrieved", () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, { scope: "global_user", keySlug: "old", content: "old" });
    setMemoryEmbedding(db, row.id, Float32Array.from([1, 0, 0]), "m");
    db.run("UPDATE agent_memories SET archived_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
    expect(searchMemoriesByVector(db, { vector: Float32Array.from([1, 0, 0]), callerAgentID: "ea" })).toHaveLength(0);
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" })).toHaveLength(0);
  });
});

describe("H19 turn lock", () => {
  test("the thread is claimed before the first await and released after", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    const fetchMock = (async () => new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\ndata: [DONE]\n\n", { status: 200 })) as unknown as typeof fetch;
    const router = new RealRouter([{ id: "t", label: "T", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" }], new HealthTracker(), fetchMock);
    const persona = { id: "ea", name: "A", color: "#fff", role: "r", systemPromptTemplate: "x", systemPrompt: "x", tools: [] } as never;
    const pending = runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(isThreadActive(thread.id)).toBe(true);
    await pending;
    expect(isThreadActive(thread.id)).toBe(false);
  });
});

describe("H28 rollover failure", () => {
  test("a failed summary fails the job so the runner retries", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "z".repeat(35_000) });
    await rolloverIfNeeded({ db, router: { route: async () => ({ text: "{}" }) } as unknown as Router, firstTokenTimeoutMs: 1000 }, conversation);
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, {
      db, firstTokenTimeoutMs: 1000, emit: () => undefined,
      router: { route: async () => { throw new Error("429"); } } as unknown as Router,
    });
    await runner.tick();
    const job = listJobs(db, { limit: 10 }).find((j) => j.kind === "rollover.summarize");
    expect(job).toBeDefined();
    expect(job!.attempts).toBeGreaterThan(0);
    expect(job!.state).not.toBe("done");
  });
});
