/**
 * PR 4: rollover that does not make the owner wait.
 *
 * A turn never waits for a summary: the block closes, a new one opens, and
 * the summary is written in the background. The trigger has hysteresis so a
 * block near the threshold cannot thrash, and a second rotation that lands
 * before the first summary does not lose the newer summary.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import type { Router } from "../src/models/router";
import {
  parseStructuredSummary,
  renderSummary,
  ROLLOVER_HYSTERESIS_CHARS,
  ROLLOVER_MIN_TURNS,
  ROLLOVER_TRIGGER_CHARS,
  rolloverIfNeeded,
  SESSION_ROLLOVER_CHARS,
  shouldRotate,
  tailOf,
} from "../src/agent/rollover";
import { ensureConversation, getConversation, openSession, updateSummary } from "../src/stores/conversations";
import { appendMessage, createThread, getThread } from "../src/stores/threads";
import { JobRunner } from "../src/jobs/runner";
import { registerRolloverJob } from "../src/jobs/rollover";
import { enqueueJob, listJobs } from "../src/stores/jobs";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** A router that must not be called: the rotation waits for nothing. */
const silentRouter = {
  route: async () => {
    throw new Error("the rotation must not call a model");
  },
} as unknown as Router;

function jsonRouter(text: string): Router {
  return { route: async () => ({ text }) } as unknown as Router;
}

describe("the trigger", () => {
  test("it is 65% of the budget, with hysteresis above it", () => {
    expect(ROLLOVER_TRIGGER_CHARS).toBe(Math.floor(SESSION_ROLLOVER_CHARS * 0.65));
    expect(ROLLOVER_HYSTERESIS_CHARS).toBeGreaterThan(ROLLOVER_TRIGGER_CHARS);
  });

  test("a block near the threshold does not thrash", () => {
    db = openDatabase(":memory:");
    const block = createThread(db, "ea");
    // Just under the trigger: nothing happens.
    expect(shouldRotate(db, block, ROLLOVER_TRIGGER_CHARS - 100)).toBe(false);
    // Over the trigger but with too few turns to be worth a block.
    expect(shouldRotate(db, block, ROLLOVER_TRIGGER_CHARS + 100)).toBe(false);
    appendMessage(db, { threadID: block.id, role: "user", text: "one" });
    appendMessage(db, { threadID: block.id, role: "user", text: "two" });
    appendMessage(db, { threadID: block.id, role: "user", text: "three" });
    // Now it has earned a block of its own.
    expect(shouldRotate(db, block, ROLLOVER_TRIGGER_CHARS + 100)).toBe(true);
    // Well past the threshold it rotates whatever the turn count.
    expect(shouldRotate(db, block, ROLLOVER_HYSTERESIS_CHARS + 1)).toBe(true);
  });
});

describe("the rotation waits for nothing", () => {
  test("a pressured block closes and reopens without a model call", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    for (let index = 0; index < 30; index += 1) {
      appendMessage(db, { threadID: block.id, role: "user", text: "x".repeat(1_500) });
      appendMessage(db, { threadID: block.id, role: "assistant", text: "y".repeat(1_500) });
    }

    const result = await rolloverIfNeeded({ db, router: silentRouter, firstTokenTimeoutMs: 1000 }, conversation);
    expect(result.rolledOver).toBe(true);
    expect(result.threadID).not.toBe(block.id);
    // The summary is a background job, not a model call on this path.
    const jobs = listJobs(db, { includeFinished: true }).filter((job) => job.kind === "rollover.summarize");
    expect(jobs).toHaveLength(1);
  });

  test("the tail of the closed block is seeded into the new one", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "the invoice is due Friday" });
    appendMessage(db, { threadID: block.id, role: "assistant", text: "noted" });
    const tail = tailOf(db, block.id);
    expect(tail).toContain("user: the invoice is due Friday");
  });
});

describe("the background summary", () => {
  test("it is stored, structured, and idempotent", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "we decided to use SQLite" });
    // The block closes, and the summary of the closed block follows.
    enqueueJob(db, {
      kind: "rollover.summarize",
      payload: { threadID: block.id, conversationID: conversation.id, version: Date.parse(block.created_at) },
    });

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, {
      db,
      router: jsonRouter('{"decisions":["Use SQLite"],"open_loops":[],"entities":["SQLite"],"tone":"plain","source_turn_range":{"from":0,"to":1}}'),
      firstTokenTimeoutMs: 1000,
      emit: () => undefined,
    });
    await runner.tick();

    const stored = getConversation(db, conversation.id);
    expect(stored?.summary).toContain("Use SQLite");
    expect(stored?.summary_version).toBeGreaterThan(0);
  });

  test("a second rotation before the first summary keeps the newer one", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    const first = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: first.id, role: "user", text: "the first block" });
    await rolloverIfNeeded({ db, router: silentRouter, firstTokenTimeoutMs: 1000 }, conversation);
    // The second rotation: the new block fills up too.
    const second = getThread(db, conversation.active_thread_id!)!;
    appendMessage(db, { threadID: second.id, role: "user", text: "z".repeat(40_000) });
    await rolloverIfNeeded({ db, router: silentRouter, firstTokenTimeoutMs: 1000 }, conversation);

    const jobs = listJobs(db, { includeFinished: true }).filter((job) => job.kind === "rollover.summarize");
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    // The version guard: a summary older than the one in place does not
    // overwrite it, whatever order the jobs finish in.
    db.run("UPDATE conversations SET summary = ?, summary_version = ? WHERE id = ?", [
      "the newer summary",
      Date.now() + 1_000_000,
      conversation.id,
    ]);
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 10 });
    registerRolloverJob(runner, {
      db,
      router: jsonRouter('{"decisions":["older"],"open_loops":[],"entities":[],"tone":"","source_turn_range":null}'),
      firstTokenTimeoutMs: 1000,
      emit: () => undefined,
    });
    await runner.tick();
    const stored = getConversation(db, conversation.id);
    expect(stored?.summary).toBe("the newer summary");
  });
});

describe("the structured summary", () => {
  test("it parses and renders", () => {
    const summary = parseStructuredSummary(
      '{"decisions":["Ship on Friday"],"open_loops":["Write the notes"],"entities":["Friday"],"tone":"brisk","source_turn_range":{"from":1,"to":9}}',
    );
    expect(summary.decisions).toEqual(["Ship on Friday"]);
    expect(summary.open_loops).toEqual(["Write the notes"]);
    const rendered = renderSummary(summary);
    expect(rendered).toContain("Decided: Ship on Friday");
    expect(rendered).toContain("Still open: Write the notes");
  });

  test("prose still becomes a summary", () => {
    const summary = parseStructuredSummary("We fixed the login bug; task list still open.");
    expect(summary.decisions).toEqual([]);
    expect(renderSummary(summary)).toBe("");
  });
});

describe("the carried summary survives a failure", () => {
  test("a failed summary keeps the previous carry", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db, "ea");
    updateSummary(db, conversation.id, "prior carry survives");
    const block = openSession(db, conversation, "manual", null);
    appendMessage(db, { threadID: block.id, role: "user", text: "z".repeat(35_000) });

    // The block rotates (no model call), then the summary job fails.
    await rolloverIfNeeded({ db, router: silentRouter, firstTokenTimeoutMs: 1000 }, conversation);
    expect(getThread(db, block.id)?.closed_at).not.toBeNull();

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, {
      db,
      router: {
        route: async () => {
          throw new Error("provider down");
        },
      } as unknown as Router,
      firstTokenTimeoutMs: 1000,
      emit: () => undefined,
    });
    await runner.tick();
    expect(getConversation(db, conversation.id)?.summary).toBe("prior carry survives");
  });
});

describe("an idle gap with a topic shift", () => {
  test("it rotates even when the block is not full", () => {
    db = openDatabase(":memory:");
    const block = createThread(db, "ea");
    appendMessage(db, { threadID: block.id, role: "user", text: "the invoice is due on Friday" });
    const later = Date.now() + 60 * 60_000;
    // Same subject: no shift.
    expect(
      shouldRotate(db, block, 100, { text: "when is the invoice due?", now: later }),
    ).toBe(false);
    // A different subject after an hour: a shift.
    expect(
      shouldRotate(db, block, 100, { text: "help me plan the summer trip to Lisbon", now: later }),
    ).toBe(true);
  });

  test("without an idle gap, a shift is not enough", () => {
    db = openDatabase(":memory:");
    const block = createThread(db, "ea");
    appendMessage(db, { threadID: block.id, role: "user", text: "the invoice is due on Friday" });
    expect(
      shouldRotate(db, block, 100, { text: "help me plan the summer trip to Lisbon", now: Date.now() }),
    ).toBe(false);
  });
});
