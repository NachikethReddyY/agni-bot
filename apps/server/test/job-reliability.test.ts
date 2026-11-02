import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { MAX_WAKE_DEFERRALS, registerTurnJob } from "../src/jobs/turn";
import { runTaskTurn } from "../src/agent/task-loop";
import { defaultResolvedPersona } from "../src/agent/personas";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { enqueueJob, getJob, parseJobPayload, requeueJob } from "../src/stores/jobs";
import { createThread } from "../src/stores/threads";
import { newID, nowISO } from "../src/util/ids";

const provider = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "k", model: "mock" };
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

function sse(text: string): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200 });
}

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  delete process.env.AGNI_MAX_BG_TURNS_PER_DAY;
});

describe("job reliability", () => {
  test("H20: a turn job that ran mail_send and then failed is not retried", async () => {
    db = openDatabase(":memory:");
    const database = db;
    let modelCalls = 0;
    // The model "sends mail" (the tool call is recorded for this turn), then the provider fails.
    const router = new Router([provider], new HealthTracker(), (async () => {
      modelCalls += 1;
      const turn = database.query<{ id: string; thread_id: string }, []>("SELECT id, thread_id FROM turns ORDER BY started_at DESC, rowid DESC LIMIT 1").get();
      if (turn) {
        database.run(
          "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, created_at) VALUES (?, ?, ?, 'c1', 'mail_send', '{}', '{\"sent\":true}', 1, NULL, ?)",
          [newID("tcl"), turn.thread_id, turn.id, nowISO()],
        );
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch);
    const notes: string[] = [];
    const emit = (frame: { type: string; body?: string }) => { if (frame.type === "notify") notes.push(frame.body ?? ""); };
    const runner = new JobRunner(db, emit as never, { maxAttempts: 3, retryDelayMs: 0 });
    registerTurnJob(runner, { db, router, settings, emit: emit as never });

    const job = enqueueJob(db, { kind: "turn", payload: { text: "send the report" } });
    while ((await runner.tick()) > 0) { /* drain */ }

    const row = getJob(db, job.id)!;
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.result).toContain("mail_send");
    const turns = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM turns").get()!.n;
    expect(turns).toBe(1);
    expect(notes.length).toBe(1);
    expect(modelCalls).toBeGreaterThan(0);
  }, 30000);

  test("H23: delegate_task at depth 3 is refused; depth travels in the payload", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main" });
    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<{ jobID: string }>;
    };
    const chain = (depth: number) => ({ depth, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null });
    const signal = new AbortController().signal;

    await expect(delegate.handler({ toAgentID: "researcher", goal: "dig deeper" }, { threadID: "t", turnID: "u", signal, chain: chain(3) }))
      .rejects.toThrow("depth limit");

    const ok = await delegate.handler({ toAgentID: "researcher", goal: "first hop" }, { threadID: "t", turnID: "u", signal, chain: chain(2) });
    expect(parseJobPayload<{ depth?: number }>(getJob(db, ok.jobID)!).depth).toBe(3);
  });

  test("M38: a recurring job after 3 failures stays enabled with its next run in the future", async () => {
    db = openDatabase(":memory:");
    const router = new Router([provider], new HealthTracker(), (async () => new Response("down", { status: 500 })) as unknown as typeof fetch);
    const runner = new JobRunner(db, () => undefined, { maxAttempts: 3, retryDelayMs: 0 });
    registerTurnJob(runner, { db, router, settings, emit: () => undefined });

    const job = enqueueJob(db, { kind: "turn", payload: { text: "daily check", everyMs: 3_600_000, notify: false } });
    while ((await runner.tick()) > 0) { /* drain the retries */ }

    const row = getJob(db, job.id)!;
    expect(row.state).toBe("queued");
    expect(row.enabled).toBe(1);
    expect(row.attempts).toBe(0);
    expect(Date.parse(row.run_at)).toBeGreaterThan(Date.now() + 3_000_000);
  }, 30000);

  test("M38: retries back off exponentially with jitter, capped at an hour", () => {
    db = openDatabase(":memory:");
    const runner = new JobRunner(db, () => undefined, { retryDelayMs: 30_000 });
    for (let i = 0; i < 20; i++) {
      const first = runner.backoffMs(1);
      expect(first).toBeGreaterThanOrEqual(15_000);
      expect(first).toBeLessThanOrEqual(30_000);
      const third = runner.backoffMs(3);
      expect(third).toBeGreaterThanOrEqual(60_000);
      expect(third).toBeLessThanOrEqual(120_000);
      expect(runner.backoffMs(30)).toBeLessThanOrEqual(3_600_000);
    }
  });

  test("M36: a wake waiting on a busy parent reuses one row and gives up after the cap", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea", "parent");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hanging = new Router([provider], new HealthTracker(), (async () => { await gate; return sse("ok"); }) as unknown as typeof fetch);
    const busy = runTaskTurn(db, hanging, { firstTokenTimeoutMs: 60_000, turnTimeoutMs: 60_000 }, {
      threadID: parent.id, text: "long work", persona: defaultResolvedPersona(db), emit: () => undefined, signal: new AbortController().signal,
    });
    await Bun.sleep(20);

    const runner = new JobRunner(db, () => undefined, { maxAttempts: 3, retryDelayMs: 0 });
    registerTurnJob(runner, { db, router: hanging, settings, emit: () => undefined });
    const wake = enqueueJob(db, {
      kind: "turn",
      payload: { threadID: parent.id, wakeKey: `wake:${parent.id}`, inputRole: "system", notify: false, results: [{ taskID: "t1", agentID: "researcher", summary: "done", redacted: false }] },
    });
    for (let i = 0; i <= MAX_WAKE_DEFERRALS; i++) {
      requeueJob(db, wake.id, nowISO());
      await runner.tick();
    }

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs").get()!.n).toBe(1);
    const row = getJob(db, wake.id)!;
    expect(row.state).toBe("failed");
    expect(row.result).toContain("deferrals");
    release();
    await busy;
  }, 30000);

  test("daily cap: a bot over AGNI_MAX_BG_TURNS_PER_DAY fails without retry and notifies once", async () => {
    db = openDatabase(":memory:");
    process.env.AGNI_MAX_BG_TURNS_PER_DAY = "1";
    const router = new Router([provider], new HealthTracker(), (async () => sse("done")) as unknown as typeof fetch);
    const notes: string[] = [];
    const emit = (frame: { type: string; title?: string }) => { if (frame.type === "notify") notes.push(frame.title ?? ""); };
    const runner = new JobRunner(db, emit as never, { maxAttempts: 3, retryDelayMs: 0 });
    registerTurnJob(runner, { db, router, settings, emit: emit as never });

    const first = enqueueJob(db, { kind: "turn", payload: { text: "one", notify: false } });
    await runner.tick();
    expect(getJob(db, first.id)!.state).toBe("done");

    const second = enqueueJob(db, { kind: "turn", payload: { text: "two", notify: false } });
    const third = enqueueJob(db, { kind: "turn", payload: { text: "three", notify: false } });
    while ((await runner.tick()) > 0) { /* drain */ }
    for (const id of [second.id, third.id]) {
      const row = getJob(db, id)!;
      expect(row.state).toBe("failed");
      expect(row.attempts).toBe(1);
      expect(row.result).toContain("cap");
    }
    expect(notes.filter((title) => title.includes("paused")).length).toBe(1);
    expect(notes.length).toBe(1);
  }, 30000);
});
