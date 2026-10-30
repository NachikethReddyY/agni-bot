/**
 * Phase 1 memory: ranking (B1), reliable writes (B2/B6), stable keys and
 * ttl (B12), scope (B10), pins (B11), profile and ledger, embed on write,
 * and episodic recall.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import {
  embedOnWrite,
  getAgentMemory,
  listAgentMemories,
  putAgentMemory,
  searchAgentMemories,
} from "../src/stores/agent-memories";
import { asksAboutPast, ownerLedger, retrieveFacts } from "../src/agent/retrieval";
import { applyTaggerItems, parseTaggerOutput, ttlToValidTo, type TaggedItem } from "../src/agent/tagger";
import { JobRunner } from "../src/jobs/runner";
import { registerTaggerJob, scheduleTagger, TAGGER_MAX_ATTEMPTS } from "../src/jobs/tagger";
import type { Router } from "../src/models/router";
import { appendChannelMessage, createChannel } from "../src/stores/channels";
import { recallFact } from "../src/tools/facts";
import { buildDelegationPrefix } from "../src/agent/prompts";
import { createTask } from "../src/stores/tasks";
import { listConflicts } from "../src/stores/conflicts";
import type { ResolvedPersona } from "../src/agent/personas";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

function item(patch: Partial<TaggedItem> = {}): TaggedItem {
  return {
    kind: "fact", text: "The owner lives in NYC.", scope: "user", visibility: "shared", source: "user",
    salience: 0.6, confidence: 0.9, entities: [], ttl: null, source_turn_ids: [], ...patch,
  };
}

describe("B1 ranking", () => {
  test("a strong match outranks a fresher weak match, and the weak one is dropped", async () => {
    db = openDatabase(":memory:");
    const strong = putAgentMemory(db, { scope: "global_user", keySlug: "dentist", content: "The dentist appointment moved to Friday." });
    putAgentMemory(db, { scope: "global_user", keySlug: "standup", content: "Standup is on Tuesday." });
    db.run("UPDATE agent_memories SET updated_at = ? WHERE id = ?", [daysAgo(10), strong.id]);

    const hits = searchAgentMemories(db, { query: "dentist appointment tuesday", callerAgentID: "ea" });
    expect(hits.map((hit) => hit.row.content)).toEqual([
      "The dentist appointment moved to Friday.",
      "Standup is on Tuesday.",
    ]);
    expect(hits[0]!.relevance).toBeGreaterThan(hits[1]!.relevance);
    const retrieved = await retrieveFacts(db, { query: "dentist appointment tuesday", callerAgentID: "ea" });
    expect(retrieved.hits.map((hit) => hit.row.id)).toEqual([strong.id]);
  });

  test("a stopword-only overlap is not returned", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, { scope: "global_user", keySlug: "weather", content: "The weather is what it is." });
    expect(searchAgentMemories(db, { query: "what is the plan for it", callerAgentID: "ea" })).toEqual([]);
  });
});

describe("B2 tagger parsing and retry", () => {
  test("fenced JSON parses; prose is a failure, not an empty batch", () => {
    const fenced = parseTaggerOutput("```json\n" + JSON.stringify({ items: [item()] }) + "\n```");
    expect(fenced.failed).toBe(false);
    expect(fenced.output.items).toHaveLength(1);
    expect(parseTaggerOutput("sorry, no").failed).toBe(true);
  });

  test("an unreadable batch stays untagged, then is given up after the attempt cap", async () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "A", agentID: "ea" });
    appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "device-1", text: "I live in NYC." });
    const router = { route: async () => ({ text: "I could not do it" }) } as unknown as Router;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    const untagged = (): number =>
      db!.query<{ c: number }, []>("SELECT count(*) AS c FROM channel_messages WHERE tagged_at IS NULL").get()!.c;
    for (let attempt = 1; attempt < TAGGER_MAX_ATTEMPTS; attempt += 1) {
      scheduleTagger(db, { channelID: channel.id, turns: 5 });
      await runner.tick();
      expect(untagged()).toBe(1);
    }
    scheduleTagger(db, { channelID: channel.id, turns: 5 });
    await runner.tick();
    expect(untagged()).toBe(0);
  });

  test("the tagger is given the known keys, so an update supersedes", async () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, { scope: "global_user", keySlug: "home-city", content: "The owner lives in NYC." });
    const channel = createChannel(db, { type: "main", visibility: "public", name: "A", agentID: "ea" });
    const message = appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "device-1", text: "I moved to SF." });
    let prompt = "";
    const router = {
      route: async (req: { messages: Array<{ content: string }> }) => {
        prompt = req.messages[1]!.content;
        return { text: JSON.stringify({ items: [item({ key: "home-city", text: "The owner lives in SF.", source_turn_ids: [message.id] })] }) };
      },
    } as unknown as Router;
    scheduleTagger(db, { channelID: channel.id, turns: 5 });
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    await runner.tick();
    expect(prompt).toContain("home-city: The owner lives in NYC.");
    const live = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" });
    expect(live.map((row) => row.content)).toEqual(["The owner lives in SF."]);
    expect(listConflicts(db)).toHaveLength(1);
  });
});

describe("B12 ttl and episodes", () => {
  test("ttl strings become an end time", () => {
    const now = Date.parse("2026-10-30T00:00:00.000Z");
    expect(ttlToValidTo("3 days", now)).toBe("2026-11-02T00:00:00.000Z");
    expect(ttlToValidTo("P1W", now)).toBe("2026-11-06T00:00:00.000Z");
    expect(ttlToValidTo("PT2H", now)).toBe("2026-10-30T02:00:00.000Z");
    expect(ttlToValidTo("2026-12-01", now)).toBe("2026-12-01T00:00:00.000Z");
    expect(ttlToValidTo("until it rains", now)).toBeNull();
    expect(ttlToValidTo(null, now)).toBeNull();
  });

  test("a temporary fact is live until it expires, and its key can be reused after", () => {
    db = openDatabase(":memory:");
    applyTaggerItems(db, { items: [item({ key: "trip", text: "The owner is in Paris this week.", ttl: "7 days" })], agentID: "ea" });
    const live = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" });
    expect(live).toHaveLength(1);
    expect(live[0]!.valid_to).not.toBeNull();

    db.run("UPDATE agent_memories SET valid_to = ? WHERE id = ?", [daysAgo(1), live[0]!.id]);
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" })).toHaveLength(0);
    expect(searchAgentMemories(db, { query: "Paris", callerAgentID: "ea" })).toHaveLength(0);
    // The unique key index must not trip on the expired row.
    applyTaggerItems(db, { items: [item({ key: "trip", text: "The owner is in Rome." })], agentID: "ea" });
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" }).map((row) => row.content)).toEqual(["The owner is in Rome."]);
  });

  test("episode items are stored as episodes", () => {
    db = openDatabase(":memory:");
    const applied = applyTaggerItems(db, { items: [item({ kind: "episode", scope: "agent", text: "We decided to ship in August." })], agentID: "ea" });
    expect(applied.memories[0]!.type).toBe("episode");
  });

  test("a question about the past is detected", () => {
    expect(asksAboutPast("what did we decide in August?")).toBe(true);
    expect(asksAboutPast("remember when we moved the launch?")).toBe(true);
    expect(asksAboutPast("what time is it")).toBe(false);
  });
});

describe("B10 scope and B11 pins", () => {
  test("a named scope searches that scope only", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, { scope: "global_user", keySlug: "tea", content: "The owner likes green tea." });
    putAgentMemory(db, { scope: "agent", agentID: "ea", keySlug: "tea-note", content: "Tea came up twice.", source: "agent" });
    expect(searchAgentMemories(db, { query: "tea", scope: "global_user", callerAgentID: "ea" })).toHaveLength(1);
    expect(searchAgentMemories(db, { query: "tea", callerAgentID: "ea" })).toHaveLength(2);
  });

  test("pins go by salience then use, and a no-op rewrite does not reshuffle them", () => {
    db = openDatabase(":memory:");
    const pinned = putAgentMemory(db, { scope: "global_user", keySlug: "name", content: "The owner is Sam.", salience: 1 });
    putAgentMemory(db, { scope: "global_user", keySlug: "recent", content: "A recent edit.", salience: 0.3 });
    db.run("UPDATE agent_memories SET updated_at = ? WHERE id = ?", [daysAgo(30), pinned.id]);
    expect(recallFact(db, { callerAgentID: "ea" }).facts[0]!.id).toBe(pinned.id);

    const before = getAgentMemory(db, pinned.id)!.updated_at;
    putAgentMemory(db, { scope: "global_user", keySlug: "name", content: "The owner is Sam.", salience: 1 });
    expect(getAgentMemory(db, pinned.id)!.updated_at).toBe(before);
  });
});

describe("profile and ledger", () => {
  const persona = { id: "ea", systemPrompt: "PERSONA" } as unknown as ResolvedPersona;

  test("the ledger is the owner's open tasks, and the prefix keeps stable parts first", () => {
    db = openDatabase(":memory:");
    createTask(db, { title: "Renew passport", priority: "high" });
    const ledger = ownerLedger(db);
    expect(ledger).toEqual(["- Renew passport, high"]);
    const prefix = buildDelegationPrefix({
      persona,
      facts: ["The owner is Sam."],
      carrySummary: "SUMMARY",
      depth: 1,
      maxDepth: 5,
      toolHints: ["TOOL-HINT"],
      anchor: { topic: "ANCHOR", entities: [], lastQuestion: null },
      recall: ["RECALL"],
      ledger,
    });
    const order = ["PERSONA", "Owner profile", "The owner is Sam.", "TOOL-HINT", "Renew passport", "SUMMARY", "RECALL", "ANCHOR"]
      .map((marker) => prefix.indexOf(marker));
    for (const position of order) expect(position).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("embed on write", () => {
  test("a written row gets its vector right away", async () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, { scope: "global_user", keySlug: "x", content: "Some fact." });
    const fetchFn = (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))) as unknown as typeof fetch;
    await embedOnWrite(db, row.id, row.content, { baseURL: "http://127.0.0.1:1", model: "m", kind: "openai", timeoutMs: 1000 }, fetchFn);
    const stored = getAgentMemory(db, row.id)!;
    expect(stored.embedding_model).toBe("m");
    expect(stored.embedding_dim).toBe(3);
  });

  test("the embedder is called alongside FTS, and a good text hit does not wait for it", async () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, { scope: "global_user", keySlug: "deploy", content: "Deployments happen on Tuesday.", salience: 0.9 });
    let called = false;
    const fetchFn = (() => { called = true; return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
    const result = await retrieveFacts(db, {
      query: "deployments tuesday",
      callerAgentID: "ea",
      embedder: { baseURL: "http://127.0.0.1:1", model: "m", kind: "openai", timeoutMs: 1000 },
      fetchFn,
    });
    expect(called).toBe(true);
    expect(result.usedVectors).toBe(false);
    expect(result.hits).toHaveLength(1);
  });
});
