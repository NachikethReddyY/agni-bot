/**
 * The harness review: an offline, owner-approved improvement loop.
 *
 * Once a night it reads how tools were used over the last two weeks and
 * proposes harness edits: promote a deferred tool that turns keep needing
 * into the core set, demote a core tool nobody uses, flag a tool that keeps
 * failing, flag a lane that keeps timing out.
 *
 * It reads counts only — tool names, ok flags, stop reasons — never message
 * or tool-result text, so mail, web pages and peer agents cannot steer what
 * it proposes. Nothing it writes changes the live harness: a proposal waits
 * for the owner, and a rejected one is never re-raised.
 */
import type { Database } from "bun:sqlite";
import { log } from "../log";
import { newID, nowISO } from "../util/ids";
import { buildTaskToolRegistry, CORE_TOOLS } from "../tools/task-registry";
import { nextDailyRun } from "./schedule";
import type { JobRunner } from "./runner";

/** The window the review reads (TUNABLE). */
export const REVIEW_WINDOW_DAYS = 14;
/** Fewer turns than this is not evidence of anything. */
export const MIN_TURNS = 30;
/** A deferred tool used in this share of turns is worth its schema on every call. */
export const PROMOTE_SHARE = 0.15;
/** A tool failing this share of its calls (with at least MIN_CALLS) is flagged. */
export const FAIL_SHARE = 0.3;
export const MIN_CALLS = 10;
/** A lane timing out this share of its turns is flagged. */
export const TIMEOUT_SHARE = 0.1;

export interface ToolUsage {
  /** Turns that called the tool at least once. */
  turns: number;
  /** Of those, turns that unlocked it with load_tools first. */
  loaded: number;
  calls: number;
  failures: number;
}

export interface UsageReport {
  turns: number;
  timeouts: number;
  tools: Map<string, ToolUsage>;
}

export type ProposalKind = "promote_core" | "demote_core" | "tool_failing" | "turn_timeouts";

export interface Proposal {
  kind: ProposalKind;
  subject: string;
  evidence: Record<string, number>;
}

/** Tool usage since `since`, from the turn and tool-call logs. */
export function toolUsage(db: Database, since: string): UsageReport {
  const turnRow = db
    .query<{ turns: number; timeouts: number }, [string]>(
      `SELECT COUNT(*) AS turns, COALESCE(SUM(stop_reason = 'timeout'), 0) AS timeouts
       FROM turns WHERE started_at >= ? AND state = 'done'`,
    )
    .get(since) ?? { turns: 0, timeouts: 0 };
  const calls = db
    .query<{ turn_id: string; tool_name: string; ok: number; args: string }, [string]>(
      `SELECT tc.turn_id, tc.tool_name, tc.ok, tc.args
       FROM tool_calls tc JOIN turns t ON t.id = tc.turn_id
       WHERE t.started_at >= ?
       ORDER BY tc.created_at, tc.rowid`,
    )
    .all(since);

  const tools = new Map<string, ToolUsage>();
  const seen = new Set<string>();
  const loadedInTurn = new Set<string>();
  for (const call of calls) {
    if (call.tool_name === "load_tools") {
      for (const name of loadToolsNames(call.args)) loadedInTurn.add(`${call.turn_id}\u0000${name}`);
      continue;
    }
    const usage = tools.get(call.tool_name) ?? { turns: 0, loaded: 0, calls: 0, failures: 0 };
    usage.calls += 1;
    if (!call.ok) usage.failures += 1;
    const key = `${call.turn_id}\u0000${call.tool_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      usage.turns += 1;
      if (loadedInTurn.has(key)) usage.loaded += 1;
    }
    tools.set(call.tool_name, usage);
  }
  return { turns: turnRow.turns, timeouts: turnRow.timeouts, tools };
}

function loadToolsNames(args: string): string[] {
  try {
    const value = JSON.parse(args) as { names?: unknown };
    return Array.isArray(value.names) ? value.names.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The proposals a usage report supports. `known` is the set of real tool
 * names: a model can call a name that does not exist, and a made-up name
 * must never become a proposal.
 */
export function proposeFromUsage(report: UsageReport, known: Set<string>): Proposal[] {
  if (report.turns < MIN_TURNS) return [];
  const proposals: Proposal[] = [];
  for (const [tool, usage] of report.tools) {
    if (!known.has(tool) && usage.failures === usage.calls) continue;
    const share = usage.turns / report.turns;
    if (!CORE_TOOLS.has(tool) && share >= PROMOTE_SHARE) {
      proposals.push({ kind: "promote_core", subject: tool, evidence: { turns: report.turns, used: usage.turns, loaded: usage.loaded } });
    }
    if (usage.calls >= MIN_CALLS && usage.failures / usage.calls >= FAIL_SHARE) {
      proposals.push({ kind: "tool_failing", subject: tool, evidence: { calls: usage.calls, failures: usage.failures } });
    }
  }
  for (const tool of CORE_TOOLS) {
    if (!report.tools.has(tool)) proposals.push({ kind: "demote_core", subject: tool, evidence: { turns: report.turns, used: 0 } });
  }
  if (report.timeouts / report.turns >= TIMEOUT_SHARE) {
    proposals.push({ kind: "turn_timeouts", subject: "*", evidence: { turns: report.turns, timeouts: report.timeouts } });
  }
  return proposals;
}

/**
 * Store proposals for the owner. A pending one gets fresh evidence; one the
 * owner already approved or rejected is left alone.
 */
export function saveProposals(db: Database, proposals: Proposal[]): number {
  const now = nowISO();
  let written = 0;
  for (const proposal of proposals) {
    const result = db.run(
      `INSERT INTO harness_proposals (id, kind, subject, evidence, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(kind, subject) DO UPDATE SET evidence = excluded.evidence, updated_at = excluded.updated_at
       WHERE harness_proposals.status = 'pending'`,
      [newID("hp"), proposal.kind, proposal.subject, JSON.stringify(proposal.evidence), now, now],
    );
    written += result.changes;
  }
  return written;
}

/** One review: read the window, propose, store. */
export function reviewHarness(db: Database, options: { now?: Date } = {}): Proposal[] {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - REVIEW_WINDOW_DAYS * 86_400_000).toISOString();
  const known = new Set([...buildTaskToolRegistry(db).list().map((tool) => tool.name), ...CORE_TOOLS]);
  const proposals = proposeFromUsage(toolUsage(db, since), known);
  saveProposals(db, proposals);
  return proposals;
}

export function registerHarnessReviewJob(runner: JobRunner, deps: { db: Database }): void {
  runner.register("harness.review", async () => {
    const proposals = reviewHarness(deps.db);
    log.info(`harness: ${proposals.length} proposal(s) from the last ${REVIEW_WINDOW_DAYS} days`);
    return { result: `${proposals.length} proposal(s)`, nextRunAt: nextDailyRun("04:00", undefined).toISOString() };
  });
}
