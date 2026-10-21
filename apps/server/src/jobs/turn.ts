/**
 * The `turn` job kind: run one prompt in a thread as background work. This is
 * how the daemon does things unprompted — reminders, the precomputed 07:55
 * brief, link resurfacing — and how it chats back: the turn streams to any
 * connected client through the normal frames, and completion raises a
 * `notify` frame.
 *
 * Payload: { threadID?, text, agentID?, notify?, maxReplyChars?, everyMs? }
 *   - threadID: reuse a thread; otherwise the job creates one.
 *   - everyMs:  recurring — schedule the next run after this one succeeds.
 *   - dailyAt: recurring on a wall clock ("09:05"); `days` limits it to
 *     certain weekdays, so "weekdays at 9:05" does not fire on a Saturday.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { runInstantTurn, type TurnSettings } from "../agent/loop";
import { runTaskTurn } from "../agent/task-loop";
import { defaultResolvedPersona, getPersona, resolvePersona, type ResolvedPersona } from "../agent/personas";
import { rootGuardrail } from "../agent/guardrails";
import type { Router } from "../models/router";
import { getThread } from "../stores/threads";
import { backgroundSession, ensureConversation, getConversation, type ConversationRow } from "../stores/conversations";
import { parseJobPayload, type JobRow } from "../stores/jobs";
import { setDelegationState, isDelegationCancelled } from "../stores/tasks";
import { nextDailyRun } from "./schedule";
import type { JobRunner } from "./runner";

export interface TurnJobPayload {
  threadID?: string;
  text: string;
  agentID?: string;
  /** Raise a notify frame when the turn ends. Default true. */
  notify?: boolean;
  everyMs?: number;
  /**
   * Recurring on a local wall clock, "09:05". With `days` it fires only on
   * those weekdays (0 = Sunday … 6 = Saturday).
   */
  dailyAt?: string;
  days?: number[];
  /**
   * Which lane the job runs in. `instant` (default) is one call, no tools,
   * bounded prompt (S1/S3) — the fast path for routine chat. `task` runs the
   * Plan → Act → Observe loop with tools, so a job can delegate to another
   * agent via the `handoff` tool. Background work that needs delegation must
   * opt into the task lane; it cannot be the default because the instant lane
   * is what keeps quick questions fast.
   */
  lane?: "instant" | "task";
  /** When true (default), bounded durable facts ride in the prompt prefix. */
  facts?: boolean;
  /** The delegation task row this job fulfils (DEL-001). */
  delegationTaskID?: string;
}

export interface TurnJobDeps {
  db: Database;
  router: Router;
  settings: TurnSettings;
  emit: (frame: ServerFrameBody) => void;
}

export function registerTurnJob(runner: JobRunner, deps: TurnJobDeps): void {
  runner.register("turn", async (job: JobRow) => {
    const payload = parseJobPayload<TurnJobPayload>(job);
    const text = payload.text?.trim();
    if (!text) throw new Error("turn job payload has no text");
    const delegationTaskID = payload.delegationTaskID?.trim() || null;
    if (delegationTaskID) {
      // A cancelled task must not run, even if its job was already claimed.
      if (isDelegationCancelled(deps.db, delegationTaskID)) return { result: "cancelled" };
      setDelegationState(deps.db, delegationTaskID, "running");
    }

    const persona = (payload.agentID ? resolvePersona(deps.db, payload.agentID) : undefined) ?? defaultResolvedPersona(deps.db);

    let threadID = payload.threadID?.trim();
    let conversation: ConversationRow | undefined;
    if (threadID) {
      const existing = getThread(deps.db, threadID);
      if (!existing) throw new Error(`thread ${threadID} no longer exists`);
      // A recurring job keeps the block it created: one routine is one
      // conversation with the agent (blueprint §process lifecycle).
      conversation = existing.conversation_id ? (getConversation(deps.db, existing.conversation_id) ?? undefined) : undefined;
    } else {
      // Background results need a home, and the home is the conversation:
      // a new session block inside it, so the user sees the result where
      // they already chat with the agent. It never takes over the active
      // chat block, and recurring runs keep landing in the same one.
      const cnv = ensureConversation(deps.db, persona.id);
      threadID = backgroundSession(deps.db, cnv, payload.text.trim().replace(/\s+/g, " ").slice(0, 60)).id;
      conversation = getConversation(deps.db, cnv.id) ?? undefined;
      deps.db.run("UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?", [
        JSON.stringify({ ...payload, threadID }),
        new Date().toISOString(),
        job.id,
      ]);
    }

    const result = await runTurn(deps, payload, persona, threadID, conversation, text);

    if (result.stopReason !== "end") {
      // runInstantTurn already reported the failure as frames; a non-end stop
      // is a failed job so the runner retries it honestly.
      if (delegationTaskID) setDelegationState(deps.db, delegationTaskID, "failed", `turn ended with ${result.stopReason}`);
      throw new Error(`turn ended with ${result.stopReason}${result.text ? " (partial output kept)" : ""}`);
    }

    const reply = firstLine(result.text);
    if (delegationTaskID && !isDelegationCancelled(deps.db, delegationTaskID)) {
      setDelegationState(deps.db, delegationTaskID, "done", reply);
    }
    if (payload.notify !== false) {
      deps.emit({ type: "notify", title: `${persona.name} · ${truncate(text, 60)}`, body: reply, sound: false });
    }

    const outcome: { result: string; nextRunAt?: string } = { result: `thread ${threadID}: ${reply}` };
    if (payload.dailyAt) {
      // A clock, not an interval: the next run is the next wall-clock moment
      // the schedule names, on the days it names.
      outcome.nextRunAt = nextDailyRun(payload.dailyAt, payload.days).toISOString();
    } else if (payload.everyMs && payload.everyMs > 0) {
      outcome.nextRunAt = new Date(Date.now() + payload.everyMs).toISOString();
    }
    return outcome;
  });
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return truncate(line, 180) || "(no output)";
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * Run the job's prompt in the requested lane. The instant lane is the fast
 * path (one call, no tools, bounded prompt — S1/S3); the task lane runs the
 * Plan → Act → Observe loop with tools, which is what lets a background job
 * delegate to another agent via the `handoff` tool. The task lane is opt-in
 * because it is slower and stateful; routine chat stays on the instant lane.
 */
async function runTurn(
  deps: TurnJobDeps,
  payload: TurnJobPayload,
  persona: ResolvedPersona,
  threadID: string,
  conversation: ConversationRow | undefined,
  text: string,
): Promise<{ turnID: string; text: string; stopReason: string }> {
  const lane = payload.lane ?? "instant";
  const signal = new AbortController().signal;
  if (lane === "task") {
    const result = await runTaskTurn(deps.db, deps.router, deps.settings, {
      threadID,
      text,
      persona,
      emit: deps.emit,
      signal,
      conversationID: conversation?.id,
      carrySummary: conversation?.summary ?? null,
      guardrail: rootGuardrail(persona.id),
      facts: payload.facts,
    });
    return { turnID: result.turnID, text: result.text, stopReason: result.stopReason };
  }
  const result = await runInstantTurn(deps.db, deps.router, deps.settings, {
    threadID,
    text,
    persona,
    conversationID: conversation?.id,
    carrySummary: conversation?.summary ?? null,
    emit: deps.emit,
    signal,
    facts: payload.facts,
  });
  return { turnID: result.turnID, text: result.text, stopReason: result.stopReason };
}
