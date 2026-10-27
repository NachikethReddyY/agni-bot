/**
 * Routine store. A routine is a recurring background job owned by a bot: the
 * `routines` row holds its config and cross-run state, the `routine_runs` rows
 * hold a short history of what each tick did. The job row stays the source of
 * truth for `enabled` and `next run` (see routines/types.ts).
 *
 * JSON columns (`preflight`, `allowed_domains`, `state_context`) are TEXT on
 * disk and objects in memory. Runs are pruned to the newest
 * ROUTINE_LIMITS.runsKept per routine so the history cannot grow forever.
 */
import type { Database } from "bun:sqlite";
import type { Preflight, Routine, RoutineRun, RunOutcome } from "../routines/types";
import { ROUTINE_LIMITS } from "../routines/types";
import { nowISO } from "../util/ids";

interface RoutineRow {
  id: string;
  job_id: string;
  agent_id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  misfire: string;
  preflight: string;
  max_tokens: number;
  max_execution_ms: number;
  allowed_domains: string;
  thread_id: string | null;
  last_state_hash: string | null;
  state_context: string | null;
  success_streak: number;
  failure_streak: number;
  created_at: string;
  updated_at: string;
}

interface RoutineRunRow {
  id: string;
  routine_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  tokens: number;
  summary: string | null;
  tool_trace: string | null;
  error: string | null;
}

const COLUMNS =
  "id, job_id, agent_id, name, prompt, cron, timezone, misfire, preflight, max_tokens, max_execution_ms, allowed_domains, thread_id, last_state_hash, state_context, success_streak, failure_streak, created_at, updated_at";

const RUN_COLUMNS =
  "id, routine_id, started_at, finished_at, outcome, tokens, summary, tool_trace, error";

function parseJSON<T>(text: string, what: string, id: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`routine ${id} has an unparseable ${what}`);
  }
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    jobID: row.job_id,
    agentID: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    misfire: row.misfire as Routine["misfire"],
    preflight: parseJSON<Preflight>(row.preflight, "preflight", row.id),
    maxTokens: row.max_tokens,
    maxExecutionMs: row.max_execution_ms,
    allowedDomains: parseJSON<string[]>(row.allowed_domains, "allowed_domains", row.id),
    threadID: row.thread_id,
    lastStateHash: row.last_state_hash,
    stateContext: row.state_context === null ? null : parseJSON<unknown>(row.state_context, "state_context", row.id),
    successStreak: row.success_streak,
    failureStreak: row.failure_streak,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RoutineRunRow): RoutineRun {
  return {
    id: row.id,
    routineID: row.routine_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as RunOutcome,
    tokens: row.tokens,
    summary: row.summary,
    toolTrace: row.tool_trace,
    error: row.error,
  };
}

/** Store the caller's IDs as given; the store never generates them. */
export function insertRoutine(db: Database, r: Routine): void {
  db.run(
    `INSERT INTO routines (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      r.id,
      r.jobID,
      r.agentID,
      r.name,
      r.prompt,
      r.cron,
      r.timezone,
      r.misfire,
      JSON.stringify(r.preflight),
      r.maxTokens,
      r.maxExecutionMs,
      JSON.stringify(r.allowedDomains ?? []),
      r.threadID ?? null,
      r.lastStateHash ?? null,
      r.stateContext === null || r.stateContext === undefined ? null : JSON.stringify(r.stateContext),
      r.successStreak,
      r.failureStreak,
      r.createdAt,
      r.updatedAt,
    ],
  );
}

export function getRoutine(db: Database, id: string): Routine | null {
  const row = db.query<RoutineRow, [string]>(`SELECT ${COLUMNS} FROM routines WHERE id = ?`).get(id);
  return row ? toRoutine(row) : null;
}

export function getRoutineByJobID(db: Database, jobID: string): Routine | null {
  const row = db.query<RoutineRow, [string]>(`SELECT ${COLUMNS} FROM routines WHERE job_id = ?`).get(jobID);
  return row ? toRoutine(row) : null;
}

export function listRoutines(db: Database): Routine[] {
  return db
    .query<RoutineRow, []>(`SELECT ${COLUMNS} FROM routines ORDER BY created_at ASC, rowid ASC`)
    .all()
    .map(toRoutine);
}

/**
 * Patch the cross-run fields only: config changes go through re-creation, and
 * `enabled` / `next run` belong to the job row. Always bumps `updatedAt`.
 */
export function updateRoutineState(
  db: Database,
  id: string,
  patch: Partial<Pick<Routine, "threadID" | "lastStateHash" | "stateContext" | "successStreak" | "failureStreak">>,
): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if ("threadID" in patch) {
    sets.push("thread_id = ?");
    values.push(patch.threadID ?? null);
  }
  if ("lastStateHash" in patch) {
    sets.push("last_state_hash = ?");
    values.push(patch.lastStateHash ?? null);
  }
  if ("stateContext" in patch) {
    sets.push("state_context = ?");
    values.push(
      patch.stateContext === null || patch.stateContext === undefined ? null : JSON.stringify(patch.stateContext),
    );
  }
  if ("successStreak" in patch) {
    sets.push("success_streak = ?");
    values.push(patch.successStreak ?? 0);
  }
  if ("failureStreak" in patch) {
    sets.push("failure_streak = ?");
    values.push(patch.failureStreak ?? 0);
  }
  sets.push("updated_at = ?");
  values.push(nowISO());
  values.push(id);
  db.run(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`, values);
}

/**
 * Delete a routine and its runs. The runs are removed explicitly as well as
 * relying on ON DELETE CASCADE: a connection opened without
 * `PRAGMA foreign_keys = ON` would otherwise leave orphan rows behind.
 */
export function deleteRoutineByJobID(db: Database, jobID: string): void {
  db.transaction(() => {
    const row = db.query<{ id: string }, [string]>("SELECT id FROM routines WHERE job_id = ?").get(jobID);
    if (!row) return;
    db.run("DELETE FROM routine_runs WHERE routine_id = ?", [row.id]);
    db.run("DELETE FROM routines WHERE id = ?", [row.id]);
  })();
}

/** Insert a run, then keep only the newest ROUTINE_LIMITS.runsKept for it. */
export function recordRun(db: Database, run: RoutineRun): void {
  db.transaction(() => {
    db.run(`INSERT INTO routine_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      run.id,
      run.routineID,
      run.startedAt,
      run.finishedAt ?? null,
      run.outcome,
      run.tokens,
      run.summary ?? null,
      run.toolTrace ?? null,
      run.error ?? null,
    ]);
    db.run(
      `DELETE FROM routine_runs
       WHERE routine_id = ?
         AND id NOT IN (
           SELECT id FROM routine_runs
           WHERE routine_id = ?
           ORDER BY started_at DESC, rowid DESC
           LIMIT ?
         )`,
      [run.routineID, run.routineID, ROUTINE_LIMITS.runsKept],
    );
  })();
}

export function listRuns(db: Database, routineID: string, limit: number): RoutineRun[] {
  return db
    .query<RoutineRunRow, [string, number]>(
      `SELECT ${RUN_COLUMNS} FROM routine_runs
       WHERE routine_id = ?
       ORDER BY started_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(routineID, limit)
    .map(toRun);
}
