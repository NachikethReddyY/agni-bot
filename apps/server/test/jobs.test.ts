import { describe, expect, test } from "bun:test";
import type { ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import {
  claimDueJob,
  deleteJob,
  enqueueJob,
  finishJob,
  getJobByPrefix,
  listJobs,
  parseJobPayload,
  requeueJob,
  requeueStuckJobs,
  wakeJob,
} from "../src/stores/jobs";
import { recentMessages } from "../src/stores/threads";
import { nowISO } from "../src/util/ids";

function freshDb() {
  return openDatabase(":memory:");
}

const encoder = new TextEncoder();

function sseResponse(...deltas: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const testProvider: ProviderConfig = {
  id: "test",
  label: "Test",
  baseUrl: "https://test.local/v1",
  apiKey: "test-key",
  model: "mock-model",
};

function makeRouter(fetchFn: typeof fetch): Router {
  return new Router([testProvider], new HealthTracker(), fetchFn);
}

function collector(): { frames: ServerFrameBody[]; emit: (frame: ServerFrameBody) => void } {
  const frames: ServerFrameBody[] = [];
  return { frames, emit: (frame) => frames.push(frame) };
}

describe("job store", () => {
  test("claims due jobs oldest-first and counts attempts", () => {
    const db = freshDb();
    const later = enqueueJob(db, { kind: "turn", payload: { text: "later" }, runAt: "2999-01-01T00:00:00.000Z" });
    const first = enqueueJob(db, { kind: "turn", payload: { text: "first" } });
    const second = enqueueJob(db, { kind: "turn", payload: { text: "second" } });

    const claimedFirst = claimDueJob(db);
    expect(claimedFirst?.id).toBe(first.id);
    expect(claimedFirst?.state).toBe("running");
    expect(claimedFirst?.attempts).toBe(1);

    expect(claimDueJob(db)?.id).toBe(second.id);
    expect(claimDueJob(db)).toBeNull(); // `later` is not due, nothing else queued

    // A retry keeps its attempt count; a manual wake starts fresh.
    requeueJob(db, first.id, nowISO());
    expect(claimDueJob(db)?.attempts).toBe(2);
    wakeJob(db, first.id);
    expect(claimDueJob(db)?.attempts).toBe(1);

    expect(getJobByPrefix(db, later.id.slice(0, 12))?.id).toBe(later.id);
    db.close();
  });

  test("finished jobs are hidden unless asked for", () => {
    const db = freshDb();
    const done = enqueueJob(db, { kind: "turn", payload: { text: "done" } });
    finishJob(db, done.id, "done", "all good");
    expect(listJobs(db)).toEqual([]);
    expect(listJobs(db, { includeFinished: true }).map((job) => job.state)).toEqual(["done"]);
    db.close();
  });

  test("a running job cannot be deleted; a queued one can", () => {
    const db = freshDb();
    const job = enqueueJob(db, { kind: "turn", payload: { text: "x" } });
    claimDueJob(db);
    expect(deleteJob(db, job.id)).toBe(false);
    finishJob(db, job.id, "done");
    expect(deleteJob(db, job.id)).toBe(true);
    db.close();
  });

  test("boot hygiene requeues jobs a dead process left running", () => {
    const db = freshDb();
    enqueueJob(db, { kind: "turn", payload: { text: "x" } });
    claimDueJob(db);
    expect(requeueStuckJobs(db)).toBe(1);
    expect(claimDueJob(db)?.attempts).toBe(2);
    db.close();
  });

  test("payloads round-trip and junk payloads fail loudly", () => {
    const db = freshDb();
    const job = enqueueJob(db, { kind: "turn", payload: { text: "hi", everyMs: 1000 } });
    const claimed = claimDueJob(db);
    expect(claimed && parseJobPayload<{ text: string; everyMs: number }>(claimed)).toEqual({ text: "hi", everyMs: 1000 });

    db.run("UPDATE jobs SET payload = 'not json' WHERE id = ?", [job.id]);
    finishJob(db, job.id, "failed", "junk");
    wakeJob(db, job.id);
    const broken = claimDueJob(db);
    expect(broken).not.toBeNull();
    expect(() => parseJobPayload(broken!)).toThrow("unparseable payload");
    db.close();
  });
});

describe("job runner", () => {
  test("runs a registered kind and records the result", async () => {
    const db = freshDb();
    const seen: string[] = [];
    const { emit } = collector();
    const runner = new JobRunner(db, emit, { retryDelayMs: 1, maxAttempts: 3 });
    runner.register("echo", async (job) => {
      seen.push(job.id);
      return { result: "echoed" };
    });

    const job = enqueueJob(db, { kind: "echo", payload: {} });
    expect(await runner.tick()).toBe(1);
    expect(seen).toEqual([job.id]);
    expect(listJobs(db, { includeFinished: true })[0]?.state).toBe("done");
    db.close();
  });

  test("retries failures then parks the job as failed and notifies", async () => {
    const db = freshDb();
    const { frames, emit } = collector();
    const runner = new JobRunner(db, emit, { retryDelayMs: 0, maxAttempts: 3 });
    let calls = 0;
    runner.register("boom", async () => {
      calls += 1;
      throw new Error(`explosion ${calls}`);
    });

    enqueueJob(db, { kind: "boom", payload: {} });
    while ((await runner.tick()) > 0) {
      // drain retries
    }
    expect(calls).toBe(3);
    const job = listJobs(db, { includeFinished: true })[0];
    expect(job?.state).toBe("failed");
    expect(job?.result).toContain("explosion 3");
    const notify = frames.find((frame) => frame.type === "notify");
    expect(notify).toBeDefined();
    db.close();
  });

  test("an unregistered kind fails immediately with a notice", async () => {
    const db = freshDb();
    const { frames, emit } = collector();
    const runner = new JobRunner(db, emit, { maxAttempts: 3 });
    enqueueJob(db, { kind: "mystery", payload: {} });
    await runner.tick();
    expect(listJobs(db, { includeFinished: true })[0]?.state).toBe("failed");
    expect(frames.some((frame) => frame.type === "notify")).toBe(true);
    db.close();
  });

  test("recurring work is requeued after a successful run", async () => {
    const db = freshDb();
    const { emit } = collector();
    const runner = new JobRunner(db, emit, { maxAttempts: 3 });
    runner.register("heartbeat", async () => ({ result: "tick", nextRunAt: "2999-01-01T00:00:00.000Z" }));

    enqueueJob(db, { kind: "heartbeat", payload: {} });
    await runner.tick();
    const job = listJobs(db)[0];
    expect(job?.state).toBe("queued");
    expect(job?.run_at).toBe("2999-01-01T00:00:00.000Z");
    expect(job?.result).toContain("recurring");
    db.close();
  });

  test("a recurring job that succeeds five times and then fails is retried, not parked", async () => {
    const db = freshDb();
    const { emit } = collector();
    const runner = new JobRunner(db, emit, { maxAttempts: 3, retryDelayMs: 0, maxPerTick: 1 });
    let calls = 0;
    runner.register("heartbeat", async () => {
      calls++;
      if (calls === 6) throw new Error("one bad tick");
      return { nextRunAt: nowISO() };
    });

    enqueueJob(db, { kind: "heartbeat", payload: {} });
    for (let i = 0; i < 6; i++) await runner.tick();
    const job = listJobs(db, { includeFinished: true })[0];
    expect(calls).toBe(6);
    expect(job?.state).toBe("queued");
    expect(job?.attempts).toBe(1);
    db.close();
  });
});

describe("turn job", () => {
  const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

  test("runs a prompt in a fresh thread and chats back with the reply", async () => {
    const db = freshDb();
    const { frames, emit } = collector();
    const router = makeRouter((async () => sseResponse("good ", "morning")) as unknown as typeof fetch);
    const runner = new JobRunner(db, emit, { maxAttempts: 3 });
    registerTurnJob(runner, { db, router, settings, emit });

    enqueueJob(db, { kind: "turn", payload: { text: "write the brief" } });
    await runner.tick();

    const job = listJobs(db, { includeFinished: true })[0];
    expect(job?.state).toBe("done");
    expect(job?.result).toContain("good morning");

    const turnEnd = frames.find((frame) => frame.type === "turn.end");
    expect(turnEnd).toBeDefined();
    if (turnEnd?.type === "turn.end") {
      const messages = recentMessages(db, turnEnd.threadID, 10);
      expect(messages.map((message) => `${message.role}:${message.text}`)).toEqual([
        "user:write the brief",
        "assistant:good morning",
      ]);
    }

    const notify = frames.find((frame) => frame.type === "notify");
    expect(notify).toBeDefined();
    if (notify?.type === "notify") {
      expect(notify.body).toBe("good morning");
      expect(notify.title).toContain("write the brief");
    }
    db.close();
  });

  test("a failed turn is a failed job, not silent output", async () => {
    const db = freshDb();
    const { frames, emit } = collector();
    const router = makeRouter((async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const runner = new JobRunner(db, emit, { maxAttempts: 2, retryDelayMs: 0 });
    registerTurnJob(runner, { db, router, settings, emit });

    enqueueJob(db, { kind: "turn", payload: { text: "try again" } });
    while ((await runner.tick()) > 0) {
      // drain retries
    }
    expect(listJobs(db, { includeFinished: true })[0]?.state).toBe("failed");
    expect(frames.filter((frame) => frame.type === "notify").length).toBe(1);
    db.close();
  }, 30000);

  test("recurring turns schedule the next run and keep one thread", async () => {
    const db = freshDb();
    const { emit } = collector();
    const router = makeRouter((async () => sseResponse("done")) as unknown as typeof fetch);
    const runner = new JobRunner(db, emit, { maxAttempts: 3 });
    registerTurnJob(runner, { db, router, settings, emit });

    enqueueJob(db, { kind: "turn", payload: { text: "brief", everyMs: 60_000, notify: false } });
    await runner.tick();
    const job = listJobs(db)[0];
    expect(job?.state).toBe("queued");
    expect(Date.parse(job?.run_at ?? "")).toBeGreaterThan(Date.parse(nowISO()));

    const firstThread = job && parseJobPayload<{ threadID?: string }>(job).threadID;
    expect(firstThread).toBeTruthy();

    // Run it once more: the same thread, no duplicate.
    requeueJob(db, job!.id, nowISO());
    await runner.tick();
    const threadCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM threads").get()?.n;
    expect(threadCount).toBe(1);
    expect(listJobs(db)[0]?.state).toBe("queued");
    db.close();
  });
});
