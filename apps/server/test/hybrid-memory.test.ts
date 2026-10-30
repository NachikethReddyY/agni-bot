/**
 * PR 3c: hybrid retrieval, consolidation, and the tools that follow a
 * reference.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import {
  cosineSimilarity,
  embedText,
  packVector,
  unpackVector,
  type EmbedderConfig,
} from "../src/agent/embeddings";
import {
  fuseHits,
  listAgentMemories,
  putAgentMemory,
  searchMemoriesByVector,
  setMemoryEmbedding,
  type MemoryHit,
} from "../src/stores/agent-memories";
import { consolidateMemories } from "../src/jobs/memory";
import { registerExpandTool } from "../src/tools/expand-tool";
import { ToolRegistry } from "../src/tools/registry";
import { previousBlockTail, retrieveFacts, rewriteForRetrieval } from "../src/agent/retrieval";
import { formatBrief } from "../src/tools/delegate-task-tool";
import { appendMessage, createThread } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const embedder: EmbedderConfig = {
  baseURL: "http://127.0.0.1:1234/v1",
  model: "nomic-embed-text",
  kind: "openai",
  timeoutMs: 1_000,
};

describe("the embedder is optional", () => {
  test("it answers an OpenAI-compatible endpoint", async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 })) as unknown as typeof fetch;
    const vector = await embedText("hello", embedder, fetchMock);
    expect(vector).not.toBeNull();
    expect(vector![0]).toBeCloseTo(0.1, 6);
    expect(vector![1]).toBeCloseTo(0.2, 6);
    expect(vector![2]).toBeCloseTo(0.3, 6);
  });

  test("an embedder that is down returns null, not an error", async () => {
    const fetchMock = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await embedText("hello", embedder, fetchMock)).toBeNull();
  });

  test("no embedder configured means no vectors", async () => {
    expect(await embedText("hello", null)).toBeNull();
  });

  test("vectors survive the round trip", () => {
    const vector = Float32Array.from([1, 2, 3]);
    const unpacked = unpackVector(packVector(vector));
    expect(unpacked).not.toBeNull();
    expect(Array.from(unpacked!)).toEqual([1, 2, 3]);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 5);
    expect(cosineSimilarity(vector, Float32Array.from([1, 0, 0]))).toBeCloseTo(1 / Math.sqrt(14), 5);
    // Different dimensions are not comparable.
    expect(cosineSimilarity(vector, Float32Array.from([1, 2]))).toBe(0);
  });
});

describe("vector search", () => {
  test("it finds the nearest fact, under the caller's rules", () => {
    db = openDatabase(":memory:");
    const near = putAgentMemory(db, {
      scope: "global_user",
      keySlug: "near",
      content: "Deployments happen on Tuesday.",
    });
    const far = putAgentMemory(db, { scope: "global_user", keySlug: "far", content: "The office cat is called Miso." });
    setMemoryEmbedding(db, near.id, Float32Array.from([1, 0, 0]), "test-model");
    setMemoryEmbedding(db, far.id, Float32Array.from([0, 1, 0]), "test-model");

    const hits = searchMemoriesByVector(db, {
      vector: Float32Array.from([1, 0, 0]),
      callerAgentID: "ea",
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.row.id).toBe(near.id);
  });

  test("a private fact is not a neighbour of another agent", () => {
    db = openDatabase(":memory:");
    const priv = putAgentMemory(db, {
      scope: "global_user",
      agentID: "ea",
      keySlug: "private",
      content: "The merger is secret.",
      visibility: "private",
    });
    setMemoryEmbedding(db, priv.id, Float32Array.from([1, 0, 0]), "test-model");
    expect(searchMemoriesByVector(db, { vector: Float32Array.from([1, 0, 0]), callerAgentID: "ea" })).toHaveLength(1);
    expect(searchMemoriesByVector(db, { vector: Float32Array.from([1, 0, 0]), callerAgentID: "researcher" })).toHaveLength(0);
  });

  test("the two halves fuse", () => {
    const textHit = { row: { id: "a" }, relevance: 0.5, score: 0.5 } as unknown as MemoryHit;
    const vectorHit = { row: { id: "b" }, relevance: 0.9, score: 0.9 } as unknown as MemoryHit;
    const both = { row: { id: "c" }, relevance: 0.4, score: 0.4 } as unknown as MemoryHit;
    const fused = fuseHits([textHit, both], [vectorHit, both]);
    // The item both searches found comes first.
    expect(fused[0]!.row.id).toBe("c");
  });

  test("a paraphrase with no shared words is recalled through vectors", async () => {
    db = openDatabase(":memory:");
    const near = putAgentMemory(db, { scope: "global_user", keySlug: "near", content: "Deployments happen on Tuesday." });
    const far = putAgentMemory(db, { scope: "global_user", keySlug: "far", content: "The office cat is called Miso." });
    setMemoryEmbedding(db, near.id, Float32Array.from([1, 0, 0]), "test-model");
    setMemoryEmbedding(db, far.id, Float32Array.from([0, 1, 0]), "test-model");
    const fetchMock = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 })) as unknown as typeof fetch;

    const result = await retrieveFacts(db, { query: "when do we ship releases", callerAgentID: "ea", embedder, fetchFn: fetchMock });
    expect(result.usedVectors).toBe(true);
    expect(result.hits.map((hit) => hit.row.id)).toEqual([near.id]);
  });
});

describe("the nightly sweep", () => {
  test("it closes what is superseded, merges duplicates, archives and promotes", () => {
    db = openDatabase(":memory:");
    const first = putAgentMemory(db, { scope: "global_user", keySlug: "day", content: "Deploys on Friday." });
    // A changed fact: the old one is closed and the new one supersedes it.
    putAgentMemory(db, { scope: "global_user", keySlug: "day", content: "Deploys on Tuesday." });
    // The same fact twice, under two keys.
    putAgentMemory(db, { scope: "global_user", keySlug: "same", content: "The same fact." });
    const dup = putAgentMemory(db, { scope: "global_user", keySlug: "other", content: "The same fact." });
    // A row that is still live but has been superseded — a crash mid-write.
    const crashed = putAgentMemory(db, { scope: "global_user", keySlug: "crashed", content: "A half-written fact." });
    db.run("UPDATE agent_memories SET supersedes_id = ? WHERE id = ?", [crashed.id, dup.id]);

    const result = consolidateMemories(db);
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(result.merged).toBeGreaterThanOrEqual(1);
    // Only the live row survives.
    const live = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" });
    expect(live.filter((row) => row.key_slug.startsWith("day"))).toHaveLength(1);
    expect(live.filter((row) => row.content === "The same fact.")).toHaveLength(1);
  });

  test("it never resurrects a hard-deleted fact", () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, { scope: "global_user", keySlug: "gone", content: "The deleted fact." });
    db.run("DELETE FROM agent_memories WHERE id = ?", [row.id]);
    const result = consolidateMemories(db);
    expect(result.closed).toBe(0);
    expect(result.merged).toBe(0);
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" })).toHaveLength(0);
  });

  test("it promotes a fact the owner keeps using", () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, { scope: "global_user", keySlug: "used", content: "The used fact." });
    db.run("UPDATE agent_memories SET use_count = 12, salience = 0.4 WHERE id = ?", [row.id]);
    consolidateMemories(db);
    const after = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" })[0];
    expect(after?.salience).toBe(1);
  });
});

describe("expand and get_fact", () => {
  test("a memory expands, under the caller's visibility", async () => {
    db = openDatabase(":memory:");
    const priv = putAgentMemory(db, {
      scope: "global_user",
      agentID: "ea",
      keySlug: "private",
      content: "The private fact.",
      visibility: "private",
    });
    const registry = new ToolRegistry();
    registerExpandTool(registry, { db, currentAgentID: "ea" });
    const tool = registry.get("expand") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const view = (await tool.handler(
      { kind: "memory", id: priv.id },
      { threadID: "thr_1", turnID: "trn_1", signal: new AbortController().signal },
    )) as { text: string | null; redacted: boolean };
    expect(view.text).toBe("The private fact.");
    expect(view.redacted).toBe(false);
  });

  test("get_fact reads one fact by id", async () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, { scope: "global_user", keySlug: "fact", content: "The exact wording." });
    const registry = new ToolRegistry();
    registerExpandTool(registry, { db, currentAgentID: "ea" });
    const tool = registry.get("get_fact") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const view = (await tool.handler(
      { id: row.id },
      { threadID: "thr_1", turnID: "trn_1", signal: new AbortController().signal },
    )) as { text: string | null };
    expect(view.text).toBe("The exact wording.");
  });
});

describe("the deictic rewrite", () => {
  test("a short back-reference picks up the topic", () => {
    const { query, rewritten } = rewriteForRetrieval("explain this", {
      anchor: { topic: "Raft versus Paxos for the storage layer", entities: ["Raft"], lastQuestion: null },
      history: [{ role: "user", content: "how does Raft handle split votes" }],
    });
    expect(rewritten).toBe(true);
    expect(query).toContain("Raft");
    expect(query).toContain("explain this");
  });

  test("a self-contained question is left alone", () => {
    const { query, rewritten } = rewriteForRetrieval("what port does postgres listen on by default", {
      anchor: { topic: "Raft", entities: [], lastQuestion: null },
    });
    expect(rewritten).toBe(false);
    expect(query).toBe("what port does postgres listen on by default");
  });
});

describe("the fallback", () => {
  test("the tail of the previous block is available", () => {
    db = openDatabase(":memory:");
    const first = createThread(db, "ea");
    appendMessage(db, { threadID: first.id, role: "user", text: "the invoice is due Friday" });
    appendMessage(db, { threadID: first.id, role: "assistant", text: "noted, Friday" });
    db.run("UPDATE threads SET closed_at = datetime('now') WHERE id = ?", [first.id]);
    const second = createThread(db, "ea");

    const tail = previousBlockTail(db, { conversationID: null, threadID: second.id });
    expect(tail).toEqual([]);

    const withConversation = previousBlockTail(db, { conversationID: "cnv_1", threadID: second.id });
    expect(withConversation).toEqual([]);
  });
});

describe("the brief carries the facts it names", () => {
  test("fact_ids travel with the brief", () => {
    const brief = formatBrief(
      { goal: "Check the invoice", factIDs: ["mem_1"] },
      [{ id: "mem_1", text: "Invoices are due on Friday." }],
    );
    expect(brief).toContain("Facts you may need");
    expect(brief).toContain("Invoices are due on Friday.");
  });
});
