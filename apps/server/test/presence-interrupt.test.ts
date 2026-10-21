/**
 * PR 6: presence, interrupts, and the activity the owner can see.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn, splitForChannel } from "../src/agent/task-loop";
import { createThread } from "../src/stores/threads";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

function sseReply(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** A router whose first call never answers, until the turn is aborted. */
function hangingRouter(): Router {
  const fetchStub = (async (_url: string, init?: RequestInit) => {
    await new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  return new Router([provider], new HealthTracker(), fetchStub);
}

function answeringRouter(text: string): Router {
  return new Router([provider], new HealthTracker(), (async () => sseReply(text)) as unknown as typeof fetch);
}

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5_000 };

describe("presence", () => {
  test("a turn says it is working, then that it is idle", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    const frames: Array<{ type: string; state?: string }> = [];
    await runTaskTurn(db, answeringRouter("done"), settings, {
      threadID: thread.id,
      text: "hello",
      persona: (await import("../src/agent/personas")).defaultResolvedPersona(db),
      emit: (frame) => frames.push(frame as { type: string; state?: string }),
      signal: new AbortController().signal,
    });
    const presence = frames.filter((frame) => frame.type === "agent.presence");
    expect(presence.length).toBe(2);
    expect(presence[0]?.state).toBe("working");
    expect(presence[1]?.state).toBe("idle");
  });
});

describe("the owner interrupts", () => {
  test("a new message takes over from a running turn", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    const persona = (await import("../src/agent/personas")).defaultResolvedPersona(db);
    const emitted: Array<{ type: string }> = [];
    const first = runTaskTurn(db, hangingRouter(), settings, {
      threadID: thread.id,
      text: "the first thing",
      persona,
      emit: (frame) => emitted.push(frame as { type: string }),
      signal: new AbortController().signal,
    });
    // Let the first turn get going.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const second = await runTaskTurn(db, answeringRouter("the second answer"), settings, {
      threadID: thread.id,
      text: "actually, do this instead",
      persona,
      emit: (frame) => emitted.push(frame as { type: string }),
      signal: new AbortController().signal,
    });
    expect(second.text).toBe("the second answer");

    const firstResult = await first;
    expect(firstResult.stopReason).toBe("cancelled");
  });
});

describe("a long answer", () => {
  test("is split at a paragraph boundary for the channel", () => {
    const text = `${"First paragraph. ".repeat(40)}\n\nSecond paragraph with the answer.`;
    const parts = splitForChannel(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.hint).toBe("progress");
    expect(parts[1]?.hint).toBe("normal");
    expect(parts[1]?.text).toContain("Second paragraph");
  });

  test("a short answer is left alone", () => {
    expect(splitForChannel("One line.")).toEqual([{ text: "One line.", hint: "normal" }]);
  });

  test("an answer without a paragraph break is left alone", () => {
    const text = "x".repeat(2_000);
    expect(splitForChannel(text)).toEqual([{ text, hint: "normal" }]);
  });
});
