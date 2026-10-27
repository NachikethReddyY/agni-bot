import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db";
import { requeueStuckJobs, enqueueJob, getJob } from "../src/stores/jobs";
import { insertRoutine, getRoutineByJobID, recordRun, listRuns } from "../src/stores/routines";
import { newID, nowISO } from "../src/util/ids";
import { createRoutineTools, deleteRoutineJob } from "../src/tools/routines-tool";
import { registerAllJobs } from "../src/jobs/registry";
import { registerRoutineJob } from "../src/jobs/routine";
import { JobRunner } from "../src/jobs/runner";
import { Router } from "../src/models/router";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import type { Routine, RoutineRun } from "../src/routines/types";
import { dispatch, type DispatchDeps, type Session } from "../src/ws/dispatch";
import { FrameLog } from "../src/ws/frame-log";
import type { ServerFrameBody, ServerFrame } from "@agni/protocol";

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };
const context = (peerInput = false) => ({ threadID: "thread", turnID: "turn", signal: AbortSignal.timeout(1000), peerInput, chain: { depth: 1, rootAgentID: "ea", currentAgentID: "ea", handoffSummary: null } });

function fixture(db: ReturnType<typeof openDatabase>, overrides: Partial<Routine> = {}) {
  const now = nowISO();
  const job = enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_test" }, runAt: "2999-01-01T00:00:00.000Z" });
  const routine: Routine = {
    id: "rtn_test", jobID: job.id, agentID: "ea", name: "Daily check", prompt: "Check status",
    cron: "0 9 * * *", timezone: "UTC", misfire: "run_once", preflight: { kind: "none" },
    maxTokens: 16000, maxExecutionMs: 120000, allowedDomains: [], threadID: null, lastStateHash: null,
    stateContext: null, successStreak: 0, failureStreak: 0, createdAt: now, updatedAt: now, ...overrides,
  };
  insertRoutine(db, routine);
  return { job, routine };
}

function callCreate(db: ReturnType<typeof openDatabase>, args: Record<string, unknown>, peerInput = false) {
  const tool = createRoutineTools(db).find((item) => item.name === "routine_create")!;
  return tool.handler(args, context(peerInput));
}

describe("routine integration", () => {
  test("routine job deletion removes routine and run rows", () => {
    const db = openDatabase(":memory:");
    const { job, routine } = fixture(db);
    const run: RoutineRun = { id: newID("run"), routineID: routine.id, startedAt: nowISO(), finishedAt: nowISO(), outcome: "ran", tokens: 2, summary: null, toolTrace: null, error: null };
    recordRun(db, run);
    expect(deleteRoutineJob(db, job.id)).toBe(true);
    expect(getRoutineByJobID(db, job.id)).toBeNull();
    expect(listRuns(db, routine.id, 5)).toEqual([]);
    db.close();
  });

  test("routine creation validates cron, timezone and SQL; domains stay empty", async () => {
    const db = openDatabase(":memory:");
    const base = { name: "Check", prompt: "Review it", timezone: "UTC", preflight: { kind: "none" } };
    for (const cron of ["0 1 2 3 4 5", "*/2 * * * *", "0,2 * * * *"]) {
      await expect(callCreate(db, { ...base, cron })).rejects.toThrow();
    }
    await expect(callCreate(db, { ...base, cron: "*/5 * * * *", timezone: "Mars/Olympus" })).rejects.toThrow("invalid timezone");
    await expect(callCreate(db, { ...base, cron: "*/5 * * * *", preflight: { kind: "sql", query: "DELETE FROM agents" } })).rejects.toThrow("single read-only SELECT");
    const created = await callCreate(db, { ...base, cron: "*/5 * * * *" }) as Routine;
    expect(created.allowedDomains).toEqual([]);
    expect(created.maxTokens).toBe(16000);
    expect(created.maxExecutionMs).toBe(120000);
    expect(getJob(db, created.jobID)?.kind).toBe("routine");
    db.close();
  });

  test("a routine job more than one period late is skipped and advanced", async () => {
    const db = openDatabase(":memory:");
    const { job, routine } = fixture(db, { misfire: "skip" });
    db.run("UPDATE jobs SET run_at = ? WHERE id = ?", [new Date(Date.now() - 3 * 86_400_000).toISOString(), job.id]);
    const runner = new JobRunner(db, () => undefined);
    registerRoutineJob(runner, { db, router: {} as Router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    expect(await runner.tick()).toBe(1);
    expect(listRuns(db, routine.id, 5)).toEqual([]);
    expect(getJob(db, job.id)?.state).toBe("queued");
    expect(new Date(getJob(db, job.id)!.run_at).getTime()).toBeGreaterThan(Date.now());
    db.close();
  });

  test("routine_create refuses peer-originated turns", async () => {
    const db = openDatabase(":memory:");
    const result = await callCreate(db, { name: "Check", prompt: "Review", cron: "*/5 * * * *", timezone: "UTC" }, true) as { error: string };
    expect(result.error).toContain("started from another agent");
    db.close();
  });

  test("boot requeues a routine job left running", () => {
    const db = openDatabase(":memory:");
    const job = enqueueJob(db, { kind: "routine", payload: { routineID: "rtn_dead" } });
    db.run("UPDATE jobs SET state = 'running' WHERE id = ?", [job.id]);
    expect(requeueStuckJobs(db)).toBe(1);
    expect(getJob(db, job.id)?.state).toBe("queued");
    db.close();
  });

  test("all jobs registers the routine kind", () => {
    const db = openDatabase(":memory:");
    const runner = new JobRunner(db, () => undefined);
    registerAllJobs(runner, {
      db,
      router: new Router([provider], new HealthTracker(), (async () => { throw new Error("not called"); }) as unknown as typeof fetch),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, firstTokenTimeoutMs: 1000, emit: () => undefined,
    });
    expect(runner.kinds()).toContain("routine");
    db.close();
  });

  test("job list adds routine details and leaves non-routine shape unchanged", async () => {
    const db = openDatabase(":memory:");
    const { job, routine } = fixture(db);
    for (let index = 0; index < 7; index++) {
      recordRun(db, { id: newID("run"), routineID: routine.id, startedAt: new Date(Date.now() + index).toISOString(), finishedAt: nowISO(), outcome: "ran", tokens: index, summary: `run ${index}`, toolTrace: null, error: null });
    }
    const ordinary = enqueueJob(db, { kind: "turn", payload: { text: "hello" }, runAt: "2999-01-01T00:00:00.000Z" });
    const replies: unknown[] = [];
    const frameLog = new FrameLog(10);
    const deps = {
      db, router: {} as Router, frameLog,
      config: {} as never,
      emit: (body: ServerFrameBody): ServerFrame => frameLog.next(body),
      reply: (body: ServerFrameBody): ServerFrame => { const frame = frameLog.next(body, { replay: false }); replies.push(frame); return frame; },
      send: () => undefined, close: () => undefined,
    } as DispatchDeps;
    const session = { id: "conn", authed: true, agentID: "ea", aborts: new Map() } as Session;
    await dispatch(deps, session, JSON.stringify({ type: "job.list" }));
    const response = replies[0] as { jobs: Array<Record<string, unknown>> };
    const routineInfo = response.jobs.find((item) => item.id === job.id)!;
    expect(routineInfo.title).toBe("Daily check");
    expect((routineInfo.routine as { recentRuns: unknown[] }).recentRuns).toHaveLength(5);
    const ordinaryInfo = response.jobs.find((item) => item.id === ordinary.id)!;
    expect(ordinaryInfo).toEqual({ id: ordinary.id, kind: "turn", state: "queued", runAt: ordinary.run_at, enabled: true, attempts: 0, title: "hello" });
    db.close();
  });

  test("job.delete removes routine and its recorded runs", async () => {
    const db = openDatabase(":memory:");
    const { job, routine } = fixture(db);
    recordRun(db, { id: newID("run"), routineID: routine.id, startedAt: nowISO(), finishedAt: nowISO(), outcome: "ran", tokens: 1, summary: null, toolTrace: null, error: null });
    const replies: unknown[] = [];
    const frameLog = new FrameLog(10);
    const deps = {
      db, router: {} as Router, frameLog, config: {} as never,
      emit: (body: ServerFrameBody): ServerFrame => frameLog.next(body),
      reply: (body: ServerFrameBody): ServerFrame => { const frame = frameLog.next(body, { replay: false }); replies.push(frame); return frame; },
      send: () => undefined, close: () => undefined,
    } as DispatchDeps;
    const session = { id: "conn", authed: true, agentID: "ea", aborts: new Map() } as Session;
    await dispatch(deps, session, JSON.stringify({ type: "job.delete", jobID: job.id }));
    expect(getRoutineByJobID(db, job.id)).toBeNull();
    expect(listRuns(db, routine.id, 5)).toEqual([]);
    db.close();
  });
});
