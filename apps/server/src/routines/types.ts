// Shared contract for Routines. Owned by the orchestrator; workers do not edit
// this file. Plan: docs/routines-plan.md section 2.
//
// The job row is the single source of truth for `enabled` and `next run`
// (jobs.enabled, jobs.run_at). Routine rows store neither.

export type MisfirePolicy = "skip" | "run_once";

export type Preflight =
  | { kind: "http"; url: string } // compares ETag, else status + body hash
  | { kind: "sql"; query: string } // read-only SELECT on the Agni DB
  | { kind: "none" }; // always counts as changed

export type RunOutcome =
  | "ran"
  | "skipped_no_delta"
  | "failed"
  | "timed_out"
  | "budget_exceeded";

export interface Routine {
  id: string;
  jobID: string;
  agentID: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  misfire: MisfirePolicy; // default "run_once"
  preflight: Preflight;
  maxTokens: number;
  maxExecutionMs: number;
  allowedDomains: string[];
  threadID: string | null; // session block reports land in; created on first run
  lastStateHash: string | null;
  stateContext: unknown; // JSON text on disk
  successStreak: number;
  failureStreak: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRun {
  id: string;
  routineID: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome;
  tokens: number;
  summary: string | null;
  toolTrace: string | null;
  error: string | null;
}

// Defaults and limits. Validated at the tool boundary.
export const ROUTINE_DEFAULTS = {
  maxTokens: 16_000, // routine-specific cap; ordinary chat turns have no token ceiling
  maxExecutionMs: 120_000,
  allowedDomains: [] as string[], // empty = web tools refuse everything
  misfire: "run_once" as MisfirePolicy,
} as const;

export const ROUTINE_LIMITS = {
  minCronPeriodMs: 5 * 60_000, // 5-minute minimum period
  runsKept: 50, // stores prune to the newest N runs per routine
  recentRunsInFrame: 5,
  autoPauseAfterFailures: 5,
} as const;
