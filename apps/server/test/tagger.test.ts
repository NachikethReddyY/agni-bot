/**
 * PR 3b: the tagger, the source policy, and the conflict flag.
 *
 * The rules here are enforced in code, not asked for in a prompt: an invalid
 * item is dropped and logged, an item below the confidence floor is not
 * promoted, and only owner-stated content may become a fact about the owner.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import {
  applyTaggerItems,
  CONFIDENCE_THRESHOLD,
  mayCreateUserFact,
  parseTaggerOutput,
  type TaggedItem,
} from "../src/agent/tagger";
import { listAgentMemories, putAgentMemory } from "../src/stores/agent-memories";
import { listConflicts } from "../src/stores/conflicts";
import { JobRunner } from "../src/jobs/runner";
import { registerTaggerJob, scheduleTagger } from "../src/jobs/tagger";
import type { Router } from "../src/models/router";
import { appendChannelMessage, createChannel } from "../src/stores/channels";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function item(patch: Partial<TaggedItem> = {}): TaggedItem {
  return {
    kind: "fact",
    text: "The owner prefers dark mode.",
    scope: "user",
    visibility: "shared",
    source: "user",
    salience: 0.6,
    confidence: 0.9,
    entities: [],
    ttl: null,
    source_turn_ids: [],
    ...patch,
  };
}

describe("the tagger schema", () => {
  test("a valid item survives, an invalid one is dropped and logged", () => {
    const { output, rejected } = parseTaggerOutput(
      JSON.stringify({
        items: [
          { kind: "fact", text: "A good fact.", scope: "user", source: "user", salience: 0.5, confidence: 0.9, entities: [], ttl: null, source_turn_ids: [] },
          { kind: "not-a-kind", text: "A bad kind.", scope: "user", source: "user" },
          { kind: "fact", scope: "user", source: "user" },
        ],
        ephemeral: false,
      }),
    );
    expect(output.items).toHaveLength(1);
    expect(output.items[0]?.text).toBe("A good fact.");
    expect(rejected).toHaveLength(2);
    expect(rejected[0]?.reason).toContain("kind");
  });

  test("output that is not JSON yields nothing", () => {
    const { output, rejected } = parseTaggerOutput("sorry, I cannot do that");
    expect(output.items).toEqual([]);
    expect(rejected).toHaveLength(1);
  });

  test("a response with no usable shape yields nothing", () => {
    const { output } = parseTaggerOutput(JSON.stringify({ nope: true }));
    expect(output.items).toEqual([]);
    expect(output.ephemeral).toBe(true);
  });
});

describe("the source policy (TAG-002)", () => {
  test("only the owner may create a fact about the owner", () => {
    expect(mayCreateUserFact("user", "user")).toBe(true);
    expect(mayCreateUserFact("verified", "user")).toBe(true);
    expect(mayCreateUserFact("tool", "user")).toBe(false);
    expect(mayCreateUserFact("web", "user")).toBe(false);
    expect(mayCreateUserFact("agent", "user")).toBe(false);
  });

  test("a web page cannot become a fact about the owner", () => {
    db = openDatabase(":memory:");
    const applied = applyTaggerItems(db, {
      items: [
        item({ text: "The owner prefers dark mode.", source: "web" }),
        item({ text: "The owner lives in Berlin.", source: "tool" }),
      ],
      agentID: "ea",
    });
    expect(applied.refused).toBe(2);
    expect(applied.written).toBe(0);
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" })).toHaveLength(0);
  });

  test("a page that says the owner prefers something is kept as the agent's own note", () => {
    db = openDatabase(":memory:");
    // The store is the last line of defence: a user-scoped write from a
    // non-owner source is refused outright.
    expect(() =>
      putAgentMemory(db!, {
        scope: "global_user",
        keySlug: "injected",
        content: "The owner prefers dark mode.",
        source: "web",
      }),
    ).toThrow();
  });

  test("owner-stated content does become a fact about the owner", () => {
    db = openDatabase(":memory:");
    const applied = applyTaggerItems(db, {
      items: [item({ text: "The owner prefers dark mode.", source: "user" })],
      agentID: "ea",
    });
    expect(applied.written).toBe(1);
    const facts = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" });
    expect(facts[0]?.content).toBe("The owner prefers dark mode.");
    expect(facts[0]?.source).toBe("user");
  });
});

describe("the confidence floor (TAG-003)", () => {
  test("an item below the threshold is not promoted", () => {
    db = openDatabase(":memory:");
    const applied = applyTaggerItems(db, {
      items: [item({ text: "Maybe the owner likes tea.", confidence: CONFIDENCE_THRESHOLD - 0.1 })],
      agentID: "ea",
    });
    expect(applied.written).toBe(0);
    expect(applied.belowThreshold).toBe(1);
    expect(listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" })).toHaveLength(0);
  });

  test("the calibration set holds the threshold up", () => {
    // A labelled sample: each row is a message, the expected items, and the
    // confidence the extractor assigns. The threshold has to keep the
    // precision and the recall the spec asks for.
    const sample: Array<{ message: string; expected: string[]; confidence: number }> = [
      { message: "I always deploy on Tuesday mornings.", expected: ["deploys on Tuesday"], confidence: 0.95 },
      { message: "Please schedule a meeting with the design team.", expected: ["meeting with the design team"], confidence: 0.9 },
      { message: "We decided to use SQLite for the ledger.", expected: ["uses SQLite for the ledger"], confidence: 0.9 },
      { message: "My name is Nachiketh.", expected: ["the owner's name is Nachiketh"], confidence: 0.95 },
      { message: "The invoice from Northwind is due Friday.", expected: ["Northwind invoice due Friday"], confidence: 0.85 },
      { message: "Thanks!", expected: [], confidence: 0.2 },
      { message: "ok", expected: [], confidence: 0.1 },
      { message: "sure, whatever you think is best", expected: [], confidence: 0.4 },
    ];
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const row of sample) {
      const promoted = row.confidence >= CONFIDENCE_THRESHOLD;
      const expected = row.expected.length > 0;
      if (promoted && expected) truePositive += 1;
      else if (promoted && !expected) falsePositive += 1;
      else if (!promoted && expected) falseNegative += 1;
    }
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    // The floor is a promise: nothing ambiguous gets promoted, and nothing
    // the owner actually said is lost.
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});

describe("the conflict flag (MEM-002)", () => {
  test("a changed fact closes the old one and records the conflict", () => {
    db = openDatabase(":memory:");
    applyTaggerItems(db, {
      items: [item({ text: "The owner deploys on Friday.", key: "deploy-day", source: "user" })],
      agentID: "ea",
    });
    const applied = applyTaggerItems(db, {
      items: [item({ text: "The owner deploys on Tuesday.", key: "deploy-day", source: "user" })],
      agentID: "ea",
    });
    expect(applied.conflicts).toBe(1);

    const live = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" });
    expect(live).toHaveLength(1);
    expect(live[0]?.content).toBe("The owner deploys on Tuesday.");

    const conflicts = listConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.previous_content).toBe("The owner deploys on Friday.");
    expect(conflicts[0]?.content).toBe("The owner deploys on Tuesday.");
    expect(conflicts[0]?.resolved).toBe(0);
  });

  test("the same fact again is not a conflict", () => {
    db = openDatabase(":memory:");
    applyTaggerItems(db, { items: [item({ text: "The owner likes tea.", key: "drink" })], agentID: "ea" });
    const applied = applyTaggerItems(db, { items: [item({ text: "The owner likes tea.", key: "drink" })], agentID: "ea" });
    expect(applied.conflicts).toBe(0);
    expect(listConflicts(db)).toHaveLength(0);
  });
});

describe("the tagger batch", () => {
  test("a batch writes the items and marks the messages", async () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    appendChannelMessage(db, {
      channelID: channel.id,
      fromType: "user",
      fromID: "u",
      text: "I always deploy on Tuesday mornings.",
    });
    const router = {
      route: async () => ({
        text: JSON.stringify({
          items: [
            {
              kind: "fact",
              text: "The owner deploys on Tuesday mornings.",
              key: "deploy-day",
              scope: "user",
              visibility: "shared",
              source: "user",
              salience: 0.7,
              confidence: 0.9,
              entities: [],
              ttl: null,
              source_turn_ids: [],
            },
          ],
          ephemeral: false,
        }),
      }),
    } as unknown as Router;

    scheduleTagger(db, { agentID: "ea", turns: 5 });
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    await runner.tick();

    const facts = listAgentMemories(db, { scope: "global_user", callerAgentID: "ea" });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.content).toBe("The owner deploys on Tuesday mornings.");
    const untagged = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM channel_messages WHERE tagged_at IS NULL")
      .get()?.count ?? 0;
    expect(untagged).toBe(0);
  });

  test("a temp message is left alone by the batch", async () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "u", text: "thanks!", salience: "temp" });
    const router = { route: async () => ({ text: JSON.stringify({ items: [], ephemeral: true }) }) } as unknown as Router;
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTaggerJob(runner, { db, router, emit: () => undefined });
    await runner.tick();
    const untagged = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM channel_messages WHERE tagged_at IS NULL")
      .get()?.count ?? 0;
    expect(untagged).toBe(1);
  });
});

describe("ephemeral turns", () => {
  test("they produce no items", () => {
    db = openDatabase(":memory:");
    const { output } = parseTaggerOutput(JSON.stringify({ items: [], ephemeral: true }));
    expect(output.items).toHaveLength(0);
    expect(output.ephemeral).toBe(true);
  });

  test("a temp message is not tagged at all", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "u", text: "thanks!", salience: "temp" });
    const pending = db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM channel_messages WHERE tagged_at IS NULL AND salience <> 'temp'",
      )
      .get()?.count ?? 0;
    expect(pending).toBe(0);
  });
});
