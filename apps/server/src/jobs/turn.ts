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
import { runTaskTurn, isThreadActive } from "../agent/task-loop";
import { defaultResolvedPersona, getPersona, resolvePersona, type ResolvedPersona } from "../agent/personas";
import { DEFAULT_VISIBILITY, redactForCaller } from "../agent/visibility";
import { rootGuardrail } from "../agent/guardrails";
import type { Router } from "../models/router";
import { getThread } from "../stores/threads";
import { backgroundSession, ensureConversation, getConversation, type ConversationRow } from "../stores/conversations";
import { appendJobResult, enqueueJob, findQueuedJobByPayloadKey, parseJobPayload, type JobRow } from "../stores/jobs";
import {
  claimResultDelivery,
  getTask,
  isDelegationCancelled,
  setDelegationArtifact,
  setDelegationState,
  setDelegationThread,
  taskInfo,
} from "../stores/tasks";
import { saveArtifact } from "../stores/artifacts";
import { scheduleTagger } from "./tagger";
import { nextDailyRun } from "./schedule";
import { peerEnvelope } from "../agent/peer-message";
import type { PeerIntent } from "@agni/protocol";
import type { JobRunner } from "./runner";

/** How long a wake waits when the parent's thread is busy. */
const WAKE_RETRY_MS = 1_500;

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
  /**
   * DEL-006: this job is a wake — a parent agent being told that a
   * delegated task finished. `wakeKey` coalesces several completions for
   * the same parent thread into one wake turn.
   */
  wake?: {
    taskID: string;
    agentID: string;
    threadID: string;
    channelID: string | null;
    summary: string;
    redacted: boolean;
  };
  wakeKey?: string;
  /** The completions a coalesced wake carries. */
  results?: Array<{
    taskID: string;
    agentID: string;
    summary: string;
    redacted: boolean;
  }>;
  /** The channel the turn's result belongs to. */
  channelID?: string;
  /** How the request is written to the durable log. */
  inputRole?: "user" | "system";
  peer?: { from: string; intent: PeerIntent; task?: string };
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

    // DEL-006: a wake turn tells the parent agent that a delegated task
    // finished. If the parent's thread is busy, the wake waits for it rather
    // than racing it — the parent is mid-thought, not gone.
    if (payload.wakeKey && payload.results?.length) {
      const parentThreadID = payload.threadID?.trim();
      if (parentThreadID && isThreadActive(parentThreadID)) {
        enqueueJob(deps.db, {
          kind: "turn",
          payload: { ...payload },
          runAt: new Date(Date.now() + WAKE_RETRY_MS).toISOString(),
        });
        return { result: "deferred: the parent thread is busy" };
      }
      payload.text = buildWakeText(payload.results);
    }

    const text = payload.text?.trim();
    if (!text) throw new Error("turn job payload has no text");
    const delegationTaskID = payload.delegationTaskID?.trim() || null;
    if (delegationTaskID) {
      // A cancelled task must not run, even if its job was already claimed.
      if (isDelegationCancelled(deps.db, delegationTaskID)) return { result: "cancelled" };
      setDelegationState(deps.db, delegationTaskID, "running");
      announceTask(deps, delegationTaskID);
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
    // The specialist's own thread: the answer, and any later resume, belong
    // to the same conversation.
    if (delegationTaskID) setDelegationThread(deps.db, delegationTaskID, threadID);

    const result = await runTurn(deps, payload, persona, threadID, conversation, text);

    if (result.stopReason === "needs_input") {
      // DEL-006: the task asked the owner a question and is waiting. This is
      // not a failure and not a completion: the answer resumes it.
      return { result: "waiting for the owner" };
    }

    if (result.stopReason !== "end") {
      // runInstantTurn already reported the failure as frames; a non-end stop
      // is a failed job so the runner retries it honestly.
      if (delegationTaskID) setDelegationState(deps.db, delegationTaskID, "failed", `turn ended with ${result.stopReason}`);
      throw new Error(`turn ended with ${result.stopReason}${result.text ? " (partial output kept)" : ""}`);
    }

    // TAG-001: a background turn is also material worth tagging.
    scheduleTagger(deps.db, { agentID: persona.id, ...(payload.channelID ? { channelID: payload.channelID } : {}) });

    const reply = firstLine(result.text);
    if (delegationTaskID && !isDelegationCancelled(deps.db, delegationTaskID)) {
      // DEL-004: the full result is an artifact in the specialist's
      // workspace; the task row keeps a short summary, and only the summary
      // enters the caller's context.
      const full = result.text.trim();
      const summary = summarizeResult(full);
      try {
        const artifact = saveArtifact(deps.db, {
          taskID: delegationTaskID,
          agentID: persona.id,
          kind: "result",
          content: full,
        });
        setDelegationArtifact(deps.db, delegationTaskID, artifact.id);
      } catch {
        // A result too large to store is still a summary.
      }
      setDelegationState(deps.db, delegationTaskID, "done", summary);
      announceTask(deps, delegationTaskID);
      wakeParent(deps, delegationTaskID, summary);
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

/**
 * The short summary that belongs in the caller's context. The full result
 * lives in an artifact (DEL-004); the summary is what wakes the parent.
 */
export function summarizeResult(text: string, maxChars = 400): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "(no output)";
  return truncate(cleaned, maxChars);
}

/** The note the parent agent reads when a delegated task finishes. */
export function buildWakeText(results: Array<{ taskID: string; agentID: string; summary: string; redacted: boolean }>): string {
  const lines = results.map((result) => {
    if (result.redacted) {
      return `- Task ${result.taskID} (${result.agentID}) finished. Its result is private to that agent; open its chat to read it.`;
    }
    return `- Task ${result.taskID} (${result.agentID}) finished: ${peerEnvelope({ from: result.agentID, intent: "result", task: result.taskID }, result.summary)}`;
  });
  return [
    "A delegated task finished. Tell the owner what came of it, in one or two sentences.",
    "If the work is not finished, keep going in the background instead of waiting.",
    "",
    ...lines,
  ].join("\n");
}

function buildWakeLogText(results: Array<{ taskID: string; agentID: string; summary: string; redacted: boolean }>): string {
  const lines = results.map((result) => result.redacted
    ? `- Task ${result.taskID} (${result.agentID}) finished. Its result is private to that agent; open its chat to read it.`
    : `- Task ${result.taskID} (${result.agentID}) finished: ${result.summary}`);
  return [
    "A delegated task finished. Tell the owner what came of it, in one or two sentences.",
    "If the work is not finished, keep going in the background instead of waiting.",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Wake the parent agent, once (DEL-006).
 *
 * The claim and the enqueue happen in one transaction, so a crash cannot
 * leave a task claimed but never woken. Several completions for the same
 * parent thread are coalesced into one wake turn.
 */
function wakeParent(deps: TurnJobDeps, taskID: string, summary: string): void {
  const task = getTask(deps.db, taskID);
  if (!task) return;
  const parentThreadID = task.parent_thread_id;
  const parentAgentID = task.parent_agent_id;
  if (!parentThreadID || !parentAgentID) return; // nobody to wake
  const owner = task.owner_agent_id ?? "";
  const visibility = owner ? resolvePersona(deps.db, owner)?.visibility ?? DEFAULT_VISIBILITY : DEFAULT_VISIBILITY;
  const visible = redactForCaller(summary, owner, parentAgentID, visibility);
  const wakeKey = `wake:${parentThreadID}`;
  const item = {
    taskID: task.id,
    agentID: owner,
    summary: visible.text ?? "",
    redacted: visible.redacted,
  };
  claimResultDelivery(deps.db, task.id, () => {
    const existing = findQueuedJobByPayloadKey(deps.db, "turn", wakeKey);
    if (existing) {
      appendJobResult(deps.db, existing.id, item);
      return;
    }
    enqueueJob(deps.db, {
      kind: "turn",
      payload: {
        lane: "task",
        agentID: parentAgentID,
        threadID: parentThreadID,
        channelID: task.parent_channel_id,
        notify: false,
        inputRole: "system",
        wakeKey,
        results: [item],
      },
    });
  });
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** DEL-006: tell the clients the task moved. */
function announceTask(deps: TurnJobDeps, taskID: string): void {
  const task = getTask(deps.db, taskID);
  if (!task) return;
  deps.emit({ type: "task.updated", task: taskInfo(task) });
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
    const delegationTaskID = payload.delegationTaskID?.trim() || null;
    const task = delegationTaskID ? getTask(deps.db, delegationTaskID) : null;
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
      ...(payload.channelID ? { channelID: payload.channelID } : {}),
      ...(payload.inputRole ? { inputRole: payload.inputRole } : {}),
      ...(payload.peer ? { peer: payload.peer } : {}),
      ...(payload.wakeKey && payload.results ? { inputText: buildWakeLogText(payload.results) } : {}),
      ...(delegationTaskID && task
        ? {
            delegation: {
              taskID: delegationTaskID,
              ownerAgentID: persona.id,
              parentAgentID: task.parent_agent_id,
              parentChannelID: task.parent_channel_id,
            },
          }
        : {}),
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
