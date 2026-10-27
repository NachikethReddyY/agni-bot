import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../src/db/migrations";
import type { Routine, RoutineRun } from "../src/routines/types";
import { ROUTINE_LIMITS } from "../src/routines/types";
import {
  deleteRoutineByJobID,
  getRoutine,
  getRoutineByJobID,
  insertRoutine,
  listRoutines,
  listRuns,
  recordRun,
  updateRoutineState,
} from "../src/stores/routines";
import { newID } from "../src/util/ids";

/**
 * Only migration 41 is needed here, so the store is tested against exactly the
 * schema the routines tables were added with, without the other 40 migrations.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const migration = MIGRATIONS.find((m) => m.id === 41);
  if (!migration) throw new Error("migration 41 (routines) is missing");
  db.exec(migration.sql);
  return db;
}

function makeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: newID("rtn"),
    jobID: newID("job"),
    agentID: "ea",
    name: "Inbox watch",
    prompt: "Summarise new urgent mail and say what changed.",
    cron: "0 9 * * *",
    timezone: "America/New_York",
    misfire: "run_once",
    preflight: { kind: "none" },
    maxTokens: 16_000,
    maxExecutionMs: 120_000,
    allowedDomains: ["news.example.com"],
    threadID: null,
    lastStateHash: null,
    stateContext: null,
    successStreak: 0,
    failureStreak: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let runSeq = 0;

function makeRun(routineID: string, startedAt: string, overrides: Partial<RoutineRun> = {}): RoutineRun {
  runSeq += 1;
  return {
    id: newID("run"),
    routineID,
    startedAt,
    finishedAt: startedAt,
    outcome: "ran",
    tokens: 100,
    summary: `run ${runSeq}`,
    toolTrace: '["mail_search"]',
    error: null,
    ...overrides,
  };
}

describe("routine store", () => {
  test("insert and get round-trip, preflight and stateContext included", () => {
    const db = freshDb();
    const routine = makeRoutine({
      preflight: { kind: "http", url: "https://news.example.com/feed" },
      lastStateHash: "abc123",
      stateContext: { seen: ["a", "b"], lastTitle: "Hello" },
      successStreak: 3,
      failureStreak: 0,
    });

    insertRoutine(db, routine);

    const found = getRoutine(db, routine.id);
    expect(found).toEqual(routine);
    expect(found?.preflight).toEqual({ kind: "http", url: "https://news.example.com/feed" });
    expect(found?.stateContext).toEqual({ seen: ["a", "b"], lastTitle: "Hello" });
    expect(found?.allowedDomains).toEqual(["news.example.com"]);

    // The JSON columns are TEXT on disk, and a missing state is NULL.
    const raw = db
      .query<{ preflight: string; allowed_domains: string; state_context: string | null }, [string]>(
        "SELECT preflight, allowed_domains, state_context FROM routines WHERE id = ?",
      )
      .get(routine.id);
    expect(typeof raw?.preflight).toBe("string");
    expect(JSON.parse(raw?.preflight ?? "null")).toEqual(routine.preflight);
    expect(JSON.parse(raw?.allowed_domains ?? "null")).toEqual(["news.example.com"]);
    expect(raw?.state_context).not.toBeNull();

    expect(getRoutine(db, "rtn_missing")).toBeNull();
    db.close();
  });

  test("stateContext of null is stored as SQL NULL", () => {
    const db = freshDb();
    const routine = makeRoutine();
    insertRoutine(db, routine);
    const raw = db
      .query<{ state_context: string | null; thread_id: string | null; last_state_hash: string | null }, [string]>(
        "SELECT state_context, thread_id, last_state_hash FROM routines WHERE id = ?",
      )
      .get(routine.id);
    expect(raw?.state_context).toBeNull();
    expect(raw?.thread_id).toBeNull();
    expect(raw?.last_state_hash).toBeNull();
    expect(getRoutine(db, routine.id)?.stateContext).toBeNull();
    db.close();
  });

  test("getRoutineByJobID and listRoutines", () => {
    const db = freshDb();
    const first = makeRoutine({ createdAt: "2026-01-01T00:00:00.000Z" });
    const second = makeRoutine({
      createdAt: "2026-01-02T00:00:00.000Z",
      preflight: { kind: "sql", query: "SELECT count(*) AS n FROM tasks" },
      allowedDomains: [],
    });
    insertRoutine(db, first);
    insertRoutine(db, second);

    expect(getRoutineByJobID(db, first.jobID)).toEqual(first);
    expect(getRoutineByJobID(db, second.jobID)?.preflight).toEqual({
      kind: "sql",
      query: "SELECT count(*) AS n FROM tasks",
    });
    expect(getRoutineByJobID(db, "job_missing")).toBeNull();

    expect(listRoutines(db).map((r) => r.id)).toEqual([first.id, second.id]);
    db.close();
  });

  test("updateRoutineState patches state, streaks and thread, and bumps updatedAt", () => {
    const db = freshDb();
    const routine = makeRoutine();
    insertRoutine(db, routine);

    const threadID = newID("thr");
    updateRoutineState(db, routine.id, {
      threadID,
      lastStateHash: "hash-2",
      stateContext: { step: 2 },
      successStreak: 4,
      failureStreak: 0,
    });

    const updated = getRoutine(db, routine.id);
    expect(updated?.threadID).toBe(threadID);
    expect(updated?.lastStateHash).toBe("hash-2");
    expect(updated?.stateContext).toEqual({ step: 2 });
    expect(updated?.successStreak).toBe(4);
    expect(updated?.failureStreak).toBe(0);
    expect((updated?.updatedAt ?? "") >= routine.updatedAt).toBe(true);
    expect(updated?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");

    // Fields outside the patch are untouched.
    expect(updated?.name).toBe(routine.name);
    expect(updated?.prompt).toBe(routine.prompt);
    expect(updated?.preflight).toEqual(routine.preflight);

    updateRoutineState(db, routine.id, { stateContext: null, successStreak: 0, failureStreak: 5 });
    const failed = getRoutine(db, routine.id);
    expect(failed?.stateContext).toBeNull();
    expect(failed?.successStreak).toBe(0);
    expect(failed?.failureStreak).toBe(5);
    expect(failed?.threadID).toBe(threadID);
    db.close();
  });

  test("recordRun prunes to the newest 50 runs", () => {
    const db = freshDb();
    const routine = makeRoutine();
    insertRoutine(db, routine);

    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const runs: RoutineRun[] = [];
    for (let i = 0; i < 52; i += 1) {
      const run = makeRun(routine.id, new Date(base + i * 60_000).toISOString());
      runs.push(run);
      recordRun(db, run);
    }

    const kept = listRuns(db, routine.id, 100);
    expect(kept).toHaveLength(ROUTINE_LIMITS.runsKept);
    expect(kept).toHaveLength(50);
    expect(kept[0]?.id).toBe(runs[51]?.id);
    expect(kept.at(-1)?.id).toBe(runs[2]?.id);

    const keptIDs = new Set(kept.map((r) => r.id));
    expect(keptIDs.has(runs[0]?.id ?? "")).toBe(false);
    expect(keptIDs.has(runs[1]?.id ?? "")).toBe(false);

    const count = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM routine_runs WHERE routine_id = ?")
      .get(routine.id);
    expect(count?.n).toBe(50);
    db.close();
  });

  test("recordRun prunes by started_at, not insertion order", () => {
    const db = freshDb();
    const routine = makeRoutine();
    insertRoutine(db, routine);

    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const old = makeRun(routine.id, new Date(base).toISOString());
    recordRun(db, old);
    for (let i = 1; i <= 49; i += 1) {
      recordRun(db, makeRun(routine.id, new Date(base + i * 60_000).toISOString()));
    }
    // Pruning follows started_at: the early run goes even though it was
    // written before the others, and the late write (still after it) stays.
    const late = makeRun(routine.id, new Date(base + 30_000).toISOString());
    recordRun(db, late);

    const kept = listRuns(db, routine.id, 100);
    expect(kept).toHaveLength(50);
    const keptIDs = new Set(kept.map((r) => r.id));
    expect(keptIDs.has(old.id)).toBe(false);
    expect(keptIDs.has(late.id)).toBe(true);
    expect(kept.at(-1)?.id).toBe(late.id);
    db.close();
  });

  test("listRuns returns newest first and honours the limit", () => {
    const db = freshDb();
    const routine = makeRoutine();
    insertRoutine(db, routine);

    const base = Date.parse("2026-04-01T00:00:00.000Z");
    const runs: RoutineRun[] = [];
    for (let i = 0; i < 6; i += 1) {
      const run = makeRun(routine.id, new Date(base + i * 60_000).toISOString(), {
        outcome: i % 2 === 0 ? "skipped_no_delta" : "ran",
        tokens: i === 3 ? 0 : 50,
        summary: `summary ${i}`,
        finishedAt: i === 5 ? null : new Date(base + i * 60_000 + 5_000).toISOString(),
        error: i === 4 ? "boom" : null,
      });
      runs.push(run);
      recordRun(db, run);
    }

    const newestThree = listRuns(db, routine.id, 3);
    expect(newestThree.map((r) => r.id)).toEqual(
      runs
        .slice(3)
        .reverse()
        .map((r) => r.id),
    );
    expect(newestThree[0]?.finishedAt).toBeNull();
    expect(newestThree[1]?.error).toBe("boom");
    expect(newestThree[2]?.outcome).toBe("ran");
    expect(newestThree[2]?.tokens).toBe(0);

    expect(listRuns(db, routine.id, 10)).toHaveLength(6);
    expect(listRuns(db, "rtn_other", 10)).toEqual([]);
    db.close();
  });

  test("deleteRoutineByJobID removes the routine and its runs", () => {
    const db = freshDb();
    const gone = makeRoutine();
    const stays = makeRoutine();
    insertRoutine(db, gone);
    insertRoutine(db, stays);

    const base = Date.parse("2026-05-01T00:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      recordRun(db, makeRun(gone.id, new Date(base + i * 60_000).toISOString()));
      recordRun(db, makeRun(stays.id, new Date(base + i * 60_000).toISOString()));
    }

    deleteRoutineByJobID(db, gone.jobID);

    expect(getRoutine(db, gone.id)).toBeNull();
    expect(getRoutineByJobID(db, gone.jobID)).toBeNull();
    expect(listRuns(db, gone.id, 10)).toEqual([]);
    const orphans = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM routine_runs WHERE routine_id = ?")
      .get(gone.id);
    expect(orphans?.n).toBe(0);

    // The other routine is untouched.
    expect(getRoutine(db, stays.id)?.id).toBe(stays.id);
    expect(listRuns(db, stays.id, 10)).toHaveLength(3);

    // Deleting an unknown job is a no-op.
    deleteRoutineByJobID(db, "job_missing");
    expect(listRoutines(db).map((r) => r.id)).toEqual([stays.id]);
    db.close();
  });

  test("deleteRoutineByJobID leaves no runs even without foreign keys enabled", () => {
    const db = new Database(":memory:");
    const migration = MIGRATIONS.find((m) => m.id === 41);
    if (!migration) throw new Error("migration 41 (routines) is missing");
    db.exec(migration.sql); // no PRAGMA foreign_keys = ON
    const routine = makeRoutine();
    insertRoutine(db, routine);
    recordRun(db, makeRun(routine.id, "2026-06-01T00:00:00.000Z"));

    deleteRoutineByJobID(db, routine.jobID);
    const orphans = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM routine_runs WHERE routine_id = ?")
      .get(routine.id);
    expect(orphans?.n).toBe(0);
    db.close();
  });
});
