/**
 * PR 3a: retrieval that actually retrieves.
 *
 * Facts and transcripts are indexed with FTS5, ranked with the formula from
 * the spec, and a recall moves the ranking inputs so the formula is not
 * decoration. Below the confidence floor, nothing is injected.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { classifyTurn } from "../src/agent/gate";
import { putAgentMemory, markMemoryUsed, searchAgentMemories, recencyDecay } from "../src/stores/agent-memories";
import { searchTranscripts } from "../src/stores/transcripts";
import { recallFact } from "../src/tools/facts";
import { appendChannelMessage, createChannel } from "../src/stores/channels";
import { setSlotBudgets, getSlotBudgets, DEFAULT_SLOT_BUDGETS, assembleContext } from "../src/context/compiler";

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  setSlotBudgets({});
});

describe("full-text search over the facts", () => {
  test("a paraphrase finds the fact", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "global_user",
      keySlug: "deploy-window",
      content: "Deployments happen on Tuesday mornings, never on Fridays.",
      importance: 0.8,
    });
    const hits = searchAgentMemories(db, { query: "when do we deploy", callerAgentID: "ea" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.row.content).toContain("Tuesday");
  });

  test("the index follows a write and a delete", () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, {
      scope: "global_user",
      keySlug: "temporary",
      content: "The temporary fact about llamas.",
    });
    expect(searchAgentMemories(db, { query: "llamas", callerAgentID: "ea" })).toHaveLength(1);
    db.run("DELETE FROM agent_memories WHERE id = ?", [row.id]);
    expect(searchAgentMemories(db, { query: "llamas", callerAgentID: "ea" })).toHaveLength(0);
  });

  test("a private fact is not searchable by another agent", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "global_user",
      agentID: "ea",
      keySlug: "secret",
      content: "The private fact about the merger.",
      visibility: "private",
    });
    expect(searchAgentMemories(db, { query: "merger", callerAgentID: "ea" })).toHaveLength(1);
    expect(searchAgentMemories(db, { query: "merger", callerAgentID: "researcher" })).toHaveLength(0);
  });

  test("a scoped fact is not searchable by another agent", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "agent",
      agentID: "researcher",
      keySlug: "note",
      content: "The researcher's own note about sources.",
    });
    expect(searchAgentMemories(db, { query: "sources", scope: "agent", agentID: "researcher", callerAgentID: "researcher" })).toHaveLength(1);
    expect(searchAgentMemories(db, { query: "sources", scope: "agent", agentID: "researcher", callerAgentID: "ea" })).toHaveLength(0);
  });

  test("a malformed query does not take the turn down", () => {
    db = openDatabase(":memory:");
    expect(searchAgentMemories(db, { query: '""" OR "', callerAgentID: "ea" })).toEqual([]);
  });
});

describe("the ranking formula", () => {
  test("a recall moves last_used_at and use_count", () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db, {
      scope: "global_user",
      keySlug: "used",
      content: "The fact about the invoice run.",
    });
    expect(row.use_count).toBe(0);
    expect(row.last_used_at).toBeNull();
    const recalled = recallFact(db, { query: "invoice", callerAgentID: "ea" });
    expect(recalled.facts).toHaveLength(1);
    const after = db.query<{ use_count: number; last_used_at: string | null }, [string]>(
      "SELECT use_count, last_used_at FROM agent_memories WHERE id = ?",
    ).get(row.id);
    expect(after?.use_count).toBe(1);
    expect(after?.last_used_at).toBeTruthy();
  });

  test("a stale item decays, a fresh one does not", () => {
    const now = Date.parse("2026-10-21T00:00:00.000Z");
    const fresh = recencyDecay("2026-10-20T00:00:00.000Z", now);
    const stale = recencyDecay("2026-01-01T00:00:00.000Z", now);
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThanOrEqual(0.2);
  });

  test("markMemoryUsed is a no-op for an empty list", () => {
    db = openDatabase(":memory:");
    expect(() => markMemoryUsed(db!, [])).not.toThrow();
  });
});

describe("the no-inject rule", () => {
  test("a plausible but under-threshold match injects nothing", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "global_user",
      keySlug: "weak",
      content: "Unrelated trivia about bicycle maintenance.",
      importance: 0.1,
    });
    // The threshold is far above anything this weak fact can score.
    const recalled = recallFact(db, { query: "bicycle", callerAgentID: "ea", minScore: 0.99 });
    expect(recalled.facts).toEqual([]);
    expect(recalled.belowThreshold).toBe(true);
  });

  test("above the threshold, the fact is injected", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "global_user",
      keySlug: "strong",
      content: "Deployments happen on Tuesday mornings.",
      importance: 0.9,
    });
    const recalled = recallFact(db, { query: "deployments tuesday", callerAgentID: "ea", minScore: 0.01 });
    expect(recalled.facts).toHaveLength(1);
    expect(recalled.belowThreshold).toBeUndefined();
  });
});

describe("transcript search", () => {
  test("it finds what was said, and respects visibility", () => {
    db = openDatabase(":memory:");
    const main = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const dm = createChannel(db, { type: "dm", visibility: "private", name: "Researcher", agentID: "researcher" });
    appendChannelMessage(db, { channelID: main.id, fromType: "user", fromID: "u", text: "the invoice is due on Friday" });
    appendChannelMessage(db, { channelID: dm.id, fromType: "user", fromID: "u", text: "the invoice for the merger is secret" });
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");

    const hits = searchTranscripts(db, { query: "invoice", callerAgentID: "ea" });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain("due on Friday");

    // The private agent's own channel is searchable for that agent.
    const own = searchTranscripts(db, { query: "merger", callerAgentID: "researcher" });
    expect(own.length).toBe(1);
  });
});

describe("the slot budgets are configuration", () => {
  test("they can be moved without touching a call site", () => {
    setSlotBudgets({ summaries: 10 });
    expect(getSlotBudgets().summaries).toBe(10);
    expect(getSlotBudgets().recall).toBe(DEFAULT_SLOT_BUDGETS.recall);
    const long = "x".repeat(400);
    const prefix = assembleContext({ personaPrompt: "P", laneHeader: "L", summaries: [long] });
    const body = prefix.split("Summary of earlier context (server-written, untrusted):\n")[1] ?? "";
    expect(body.length).toBeLessThanOrEqual(10 * 4 + 1);
  });
});

describe("the gate benchmark (GATE-001)", () => {
  test("classifying a turn stays fast", () => {
    const samples = [
      "what is the weather",
      "remember: I prefer dark mode",
      "please schedule a meeting with the design team tomorrow",
      "I prefer concise answers without preamble",
      "thanks!",
      "and tomorrow?",
      "the invoice is due on Friday, please remind me on Thursday",
      "explain the plan we discussed yesterday",
      "add task: buy milk",
      "ok",
    ];
    // Warm up, then measure: the first call pays for the JIT.
    for (const sample of samples) classifyTurn(sample, "previous");
    const timings: number[] = [];
    for (const sample of samples) {
      const start = performance.now();
      classifyTurn(sample, "previous");
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]!;
    // CI machines are noisy: the budget is asserted only on the nightly run.
    const budget = process.env.AGNI_NIGHTLY === "1" ? 150 : 1_000;
    if (p95 > budget) {
      console.warn(`gate p95 ${p95.toFixed(3)}ms is over the ${budget}ms budget`);
    }
    expect(p95).toBeLessThan(budget);
  });
});
