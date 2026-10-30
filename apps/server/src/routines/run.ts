import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import { runTaskTurn, type TaskTurnSettings } from "../agent/task-loop";
import { resolvePersona } from "../agent/personas";
import { rootGuardrail } from "../agent/guardrails";
import { backgroundSession, ensureConversation, getConversation } from "../stores/conversations";
import { getThread } from "../stores/threads";
import { getJob, setJobEnabled } from "../stores/jobs";
import { newID, nowISO } from "../util/ids";
import { runPreflight } from "./preflight";
import { buildRoutinePrompt, parseRoutineState } from "./prompt";
import { getRoutine, recordRun, updateRoutineState } from "../stores/routines";
import { ROUTINE_LIMITS, type Routine, type RoutineRun } from "./types";

// No read_file/grep/glob/mail_search: an unattended run must not read files or
// search the mailbox for something to exfiltrate (bug.md C1, M16).
export const ROUTINE_TOOL_ALLOWLIST = [
  "memory_search", "transcript_search", "links_search", "tasks_list",
  "web_search", "web_fetch", "mail_read", "recall_fact",
  "skills_list", "skills_load", "skills_resource",
];

export interface RoutineRunDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
}

function startRun(routineID: string): RoutineRun {
  return {
    id: newID("run"), routineID, startedAt: nowISO(), finishedAt: null,
    outcome: "failed", tokens: 0, summary: null, toolTrace: null, error: null,
  };
}

function record(deps: RoutineRunDeps, run: RoutineRun): RoutineRun {
  run.finishedAt = nowISO();
  recordRun(deps.db, run);
  return run;
}

function updateStreak(deps: RoutineRunDeps, routine: Routine, succeeded: boolean): number {
  // Re-read: pause, resume or run-now may have changed the streak mid-run.
  const current = getRoutine(deps.db, routine.id);
  if (!current) return 0;
  const successStreak = succeeded ? current.successStreak + 1 : 0;
  const failureStreak = succeeded ? 0 : current.failureStreak + 1;
  updateRoutineState(deps.db, routine.id, { successStreak, failureStreak });
  return failureStreak;
}

function maybePause(deps: RoutineRunDeps, routine: Routine, failureStreak: number): void {
  if (failureStreak < ROUTINE_LIMITS.autoPauseAfterFailures) return;
  // Notify only on the enabled -> paused transition, not on every failure while paused.
  const wasEnabled = getJob(deps.db, routine.jobID)?.enabled === 1;
  setJobEnabled(deps.db, routine.jobID, false);
  if (!wasEnabled) return;
  deps.emit({ type: "notify", title: `Routine ${routine.name} paused`, body: `Routine ${routine.name} paused after ${ROUTINE_LIMITS.autoPauseAfterFailures} failures`, sound: false, ...(routine.threadID ? { threadID: routine.threadID } : {}) });
}

/** Execute one scheduled routine, keeping its report in the bot's conversation. */
export async function executeRoutine(deps: RoutineRunDeps, routine: Routine): Promise<RoutineRun> {
  const run = startRun(routine.id);
  let preflight: { changed: boolean; hash: string };
  try {
    preflight = await runPreflight(routine.preflight, deps.db, routine.lastStateHash);
  } catch (error) {
    run.error = error instanceof Error ? error.message : String(error);
    maybePause(deps, routine, updateStreak(deps, routine, false));
    return record(deps, run);
  }
  if (!preflight.changed) {
    run.outcome = "skipped_no_delta";
    run.tokens = 0;
    return record(deps, run);
  }

  const persona = resolvePersona(deps.db, routine.agentID);
  if (!persona) {
    run.error = `routine agent not found: ${routine.agentID}`;
    maybePause(deps, routine, updateStreak(deps, routine, false));
    return record(deps, run);
  }
  let threadID = routine.threadID;
  let conversation = threadID ? (() => {
    const thread = getThread(deps.db, threadID!);
    return thread?.conversation_id ? getConversation(deps.db, thread.conversation_id) : undefined;
  })() : undefined;
  if (threadID && !getThread(deps.db, threadID)) threadID = null;
  if (!threadID) {
    conversation = ensureConversation(deps.db, persona.id);
    threadID = backgroundSession(deps.db, conversation, routine.name).id;
    updateRoutineState(deps.db, routine.id, { threadID });
  }

  const signal = AbortSignal.timeout(routine.maxExecutionMs);
  try {
    const result = await runTaskTurn(deps.db, deps.router, deps.settings, {
      threadID,
      text: buildRoutinePrompt(routine),
      persona,
      emit: deps.emit,
      signal,
      conversationID: conversation?.id,
      carrySummary: conversation?.summary ?? null,
      guardrail: rootGuardrail(persona.id),
      toolAllowlist: ROUTINE_TOOL_ALLOWLIST,
      maxTokens: routine.maxTokens,
      allowedDomains: routine.allowedDomains,
    });
    run.summary = result.text.slice(0, 200);
    const usage = deps.db.query<{ tokens: number }, [string]>("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens FROM usage_ledger WHERE turn_id = ?").get(result.turnID);
    run.tokens = usage?.tokens ?? 0;
    const toolRows = deps.db.query("SELECT tool_name, args FROM tool_calls WHERE turn_id = ? ORDER BY created_at").all(result.turnID) as Array<{ tool_name: string; args: string }>;
    run.toolTrace = JSON.stringify(toolRows.map((row) => ({ name: row.tool_name, args: safeJson(row.args) })));
    if (signal.aborted || result.stopReason === "timeout" || result.stopReason === "cancelled") {
      run.outcome = "timed_out";
      run.error = "routine execution timed out";
      const failureStreak = updateStreak(deps, routine, false);
      maybePause(deps, routine, failureStreak);
    } else if (result.stopReason !== "end") {
      run.outcome = result.stopReason === "budget" ? "budget_exceeded" : "failed";
      run.error = `task turn ended with ${result.stopReason}`;
      const failureStreak = updateStreak(deps, routine, false);
      maybePause(deps, routine, failureStreak);
    } else {
      const parsed = parseRoutineState(result.text);
      run.outcome = "ran";
      if (!parsed.found) run.error = "Warning: reply did not include a valid stateContext JSON block; previous state was kept.";
      else updateRoutineState(deps.db, routine.id, { stateContext: parsed.value });
      updateRoutineState(deps.db, routine.id, { lastStateHash: preflight.hash });
      updateStreak(deps, routine, true);
    }
    deps.emit({ type: "notify", title: `${persona.name} · ${routine.name}`, body: run.summary ?? "Routine completed", sound: false, threadID });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    run.outcome = signal.aborted ? "timed_out" : /budget/i.test(message) ? "budget_exceeded" : "failed";
    run.error = message;
    maybePause(deps, routine, updateStreak(deps, routine, false));
  }
  return record(deps, run);
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}
