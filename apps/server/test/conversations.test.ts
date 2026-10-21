import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { HealthTracker } from "../src/models/health";
import { openDatabase } from "../src/db";
import { appendMessage, getThread, listThreadsWithPreview } from "../src/stores/threads";
import {
  activeSession,
  backgroundSession,
  conversationTranscript,
  ensureConversation,
  openSession,
  sessionCharLoad,
  updateSummary,
} from "../src/stores/conversations";
import { rolloverIfNeeded, rotateById, rotate, SESSION_ROLLOVER_CHARS } from "../src/agent/rollover";
import { JobRunner } from "../src/jobs/runner";
import { registerRolloverJob } from "../src/jobs/rollover";
import { runTaskTurn } from "../src/agent/task-loop";
import { defaultResolvedPersona } from "../src/agent/personas";

/**
 * The conversation model: one conversation per agent, blocks opening with
 * the carried summary, closing into it again. Background blocks stay
 * sidecars. Rollover carries summary text across the boundary.
 */

const provider: ProviderConfig = {
  id: "test",
  label: "Test",
  baseUrl: "https://test.local/v1",
  apiKey: "test-key",
  model: "mock-model",
};

const encoder = new TextEncoder();

/** A reply of `count` a's, streamed — big enough to drive pressure tests. */
function sseReply(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function makeRouter(responses: string[] | string): Router {
  const list = Array.isArray(responses) ? responses : [responses];
  let index = 0;
  const fetchStub = async (): Promise<Response> => sseReply(list[Math.min(index++, list.length - 1)] ?? (list[0] as string));
  return new Router([provider], new HealthTracker(), fetchStub as unknown as typeof fetch);
}

const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

let db: Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

const noopEmit = (): void => {};
const noopSignal = new AbortController().signal;

describe("conversation store", () => {
  test("ensureConversation creates one conversation per agent", () => {
    db = openDatabase(":memory:");
    const first = ensureConversation(db!, "agni");
    const second = ensureConversation(db!, "agni");
    expect(second.id).toBe(first.id);
    const scout = ensureConversation(db!, "scout");
    expect(scout.id).not.toBe(first.id);
  });

  test("openSession closes the old block, opens a new active one with the carry", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    let block = openSession(db!, conversation, "manual", "Did some things earlier");
    expect(activeSession(db!, conversation)?.id).toBe(block.id);

    appendMessage(db!, { threadID: block.id, role: "user", text: "hello" });
    appendMessage(db!, { threadID: block.id, role: "assistant", text: "hi" });

    const next = await rotateById({ db: db!, router: makeRouter("folded summary text"), firstTokenTimeoutMs: 1000 }, conversation.id, "manual");
    expect(next.rolledOver).toBe(true);
    expect(next.reason).toBe("manual");
    expect(next.carry).toBe("folded summary text");
    block = next.threadID ? getThread(db!, next.threadID)! : block;

    // The old block is closed and stays attached to the conversation.
    const closed = listThreadsWithPreview(db!, 10).find((row) => row.conversation_id === conversation.id && row.closed_at !== null);
    expect(closed).toBeDefined();
    const active = activeSession(db!, conversation);
    expect(active?.id).toBe(block.id);
    expect(active?.opened_carry).toBe("folded summary text");
  });

  test("background blocks are born closed and never become the active chat", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const chat = openSession(db!, conversation, "manual", null);
    const brief = backgroundSession(db!, conversation, "Morning brief · 2026-10-17");
    expect(brief.closed_by).toBe("background");
    expect(activeSession(db!, conversation)?.id).toBe(chat.id);
    // One conversation, two entries in the transcript.
    expect(conversationTranscript(db!, conversation.id, 50).length).toBe(0);
    appendMessage(db!, { threadID: chat.id, role: "user", text: "hello" });
    appendMessage(db!, { threadID: brief.id, role: "assistant", text: "Morning brief" });
    const transcript = conversationTranscript(db!, conversation.id, 50);
    expect(transcript.map((message) => message.sessionID).join(",")).toBe(`${chat.id},${brief.id}`);
  });

  test("transcript reads across blocks oldest-first with sessionIDs", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const first = openSession(db!, conversation, "manual", null);
    appendMessage(db!, { threadID: first.id, role: "user", text: "block one message" });
    const second = openSession(db!, conversation, "manual", "carry");
    appendMessage(db!, { threadID: second.id, role: "user", text: "block two message" });

    const transcript = conversationTranscript(db!, conversation.id, 50);
    expect(transcript.map((message) => message.text)).toEqual(["block one message", "block two message"]);
    expect(transcript[0]?.sessionID).toBe(first.id);
    expect(transcript[1]?.sessionID).toBe(second.id);
  });

  test("sessionCharLoad counts block pressure", () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const block = openSession(db!, conversation, "manual", null);
    expect(sessionCharLoad(db!, block.id)).toBe(0);
    appendMessage(db!, { threadID: block.id, role: "user", text: "12345" });
    expect(sessionCharLoad(db!, block.id)).toBe(5);
    updateSummary(db!, conversation.id, "remembered something");
    expect(ensureConversation(db!, "agni").summary).toBe("remembered something");
  });
});

describe("rollover", () => {
  test("an unpressured block keeps its id and ride-along carry", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const block = openSession(db!, conversation, "manual", "existing carry");
    updateSummary(db!, conversation.id, "existing carry");
    const result = await rolloverIfNeeded({ db: db!, router: makeRouter("hijack"), firstTokenTimeoutMs: 1000 }, conversation);
    expect(result.rolledOver).toBe(false);
    expect(result.threadID).toBe(block.id);
    expect(result.carry).toBe("existing carry");
  });

  test("a pressured block rotates at once, and the summary follows in the background", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const block = openSession(db!, conversation, "manual", null);
    for (let i = 0; i < 40; i += 1) {
      appendMessage(db!, { threadID: block.id, role: "user", text: "x".repeat(1_400) });
      appendMessage(db!, { threadID: block.id, role: "assistant", text: "y".repeat(1_400) });
    }
    expect(sessionCharLoad(db!, block.id)).toBeGreaterThan(SESSION_ROLLOVER_CHARS);

    // ROL-002: the rotation does not wait for a model. The block is closed,
    // a new one opens, and the summary is a background job.
    const result = await rolloverIfNeeded({ db: db!, router: makeRouter("We fixed the login bug; task list still open."), firstTokenTimeoutMs: 1000 }, conversation);
    expect(result.rolledOver).toBe(true);
    expect(result.reason).toBe("context");
    const closed = getThread(db!, block.id);
    expect(closed?.closed_at).not.toBeNull();
    expect(closed?.closed_by).toBe("context");
    // The new block is open and the old block's summary is still to come.
    expect(activeSession(db!, conversation)?.id).toBe(result.threadID);
    expect(ensureConversation(db!, "agni").summary).toBeNull();

    // The background job writes it.
    const runner = new JobRunner(db!, () => undefined, { maxPerTick: 5 });
    registerRolloverJob(runner, {
      db: db!,
      router: makeRouter('{"decisions":["We fixed the login bug"],"open_loops":["task list still open"],"entities":[],"tone":"plain","source_turn_range":{"from":0,"to":3}}'),
      firstTokenTimeoutMs: 1000,
      emit: () => undefined,
    });
    await runner.tick();
    expect(ensureConversation(db!, "agni").summary).toContain("We fixed the login bug");
  });

  test("the new block opens with the tail of the old one", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const block = openSession(db!, conversation, "manual", null);
    appendMessage(db!, { threadID: block.id, role: "user", text: "the invoice is due Friday" });
    appendMessage(db!, { threadID: block.id, role: "assistant", text: "noted, Friday" });
    const result = await rotate({ db: db!, router: makeRouter("summary"), firstTokenTimeoutMs: 1000 }, conversation, "manual");
    const opened = getThread(db!, result.threadID);
    expect(opened?.opened_tail).toContain("the invoice is due Friday");
  });

  test("a failed summary falls back to the previous carry and never blocks", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const block = openSession(db!, conversation, "manual", null);
    appendMessage(db!, { threadID: block.id, role: "user", text: "z".repeat(35_000) });
    updateSummary(db!, conversation.id, "prior carry survives");
    const router = makeRouter("ignored");
    router.route = async () => Promise.reject(new Error("provider down"));
    const result = await rotate({ db: db!, router, firstTokenTimeoutMs: 1000 }, conversation, "manual");
    expect(result.carry).toBe("prior carry survives");
    expect(activeSession(db!, conversation)?.id).toBe(result.threadID);
  });
});

describe("task lane on the conversation model", () => {
  test("a turn carries the conversation bind and rides the active block", async () => {
    db = openDatabase(":memory:");
    const conversation = ensureConversation(db!, "agni");
    const block = openSession(db!, conversation, "manual", "carry text");
    const highlighted: string[] = [];
    const result = await runTaskTurn(db!, makeRouter("done text"), settings, {
      threadID: block.id,
      text: "do the thing",
      persona: defaultResolvedPersona(db!),
      conversationID: conversation.id,
      carrySummary: "carry text",
      emit: (frame) => {
        highlighted.push(JSON.stringify(frame));
        noopEmit();
      },
      signal: noopSignal,
    });
    expect(result.stopReason).toBe("end");
    const turnStart = highlighted.find((line) => line.includes("turn.start"));
    expect(turnStart).toContain(`"conversationID":"${conversation.id}"`);
    // The turn landed in the still-active block.
    expect(activeSession(db!, conversation)?.id).toBe(block.id);
  });
});
