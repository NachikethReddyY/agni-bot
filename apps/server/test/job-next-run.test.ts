import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerBriefJob } from "../src/jobs/brief";
import { registerTurnJob } from "../src/jobs/turn";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { enqueueJob, getJob, requeueJob } from "../src/stores/jobs";
import { nowISO } from "../src/util/ids";

const provider = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "k", model: "mock" };
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

test("M38: a recurring brief whose handler throws 3 times stays queued with a future run_at", async () => {
  db = openDatabase(":memory:");
  const runner = new JobRunner(db, () => undefined, { maxAttempts: 3, retryDelayMs: 0 });
  registerBriefJob(runner, { db, emit: () => undefined, timeZone: "UTC" });
  const job = db.query<{ id: string }, []>("SELECT id FROM jobs WHERE kind='brief'").get()!;
  db.run("DROP TABLE brief_runs"); // makes every attempt throw
  requeueJob(db, job.id, nowISO());
  while ((await runner.tick()) > 0) { /* drain the retries */ }

  const row = getJob(db, job.id)!;
  expect(row.state).toBe("queued");
  expect(row.enabled).toBe(1);
  expect(row.attempts).toBe(0);
  expect(row.result).toContain("run failed");
  expect(Date.parse(row.run_at)).toBeGreaterThan(Date.now());
}, 30000);

test("H20: a retried turn job after a provider error holds one copy of its input", async () => {
  db = openDatabase(":memory:");
  let calls = 0; // the provider's own 3 attempts all fail, so attempt 1 of the job fails; the retry succeeds
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "done" } }] })}\n\ndata: [DONE]\n\n`;
  const router = new Router([provider], new HealthTracker(), (async () =>
    ++calls <= 3 ? new Response("down", { status: 500 }) : new Response(body, { status: 200 })) as unknown as typeof fetch);
  const runner = new JobRunner(db, () => undefined, { maxAttempts: 3, retryDelayMs: 0 });
  registerTurnJob(runner, { db, router, settings, emit: () => undefined });

  const job = enqueueJob(db, { kind: "turn", payload: { text: "unique-input-xyz", notify: false } });
  while ((await runner.tick()) > 0) { /* drain */ }

  expect(getJob(db, job.id)!.state).toBe("done");
  expect(getJob(db, job.id)!.attempts).toBe(2);
  const copies = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE role='user' AND text='unique-input-xyz'").get()!.n;
  expect(copies).toBe(1);
}, 30000);
