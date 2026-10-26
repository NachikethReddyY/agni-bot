/**
 * The `delegate_task` tool (DEL-001..DEL-004).
 *
 * `handoff` runs a specialist synchronously and folds the answer into the
 * current turn. `delegate_task` is the other shape: it writes a task row,
 * enqueues a background `turn` job, and returns immediately. The specialist
 * runs in its own background session with only the brief — never the EA's
 * transcript — and the result lands back on the task row plus a notification.
 */
import type { Database } from "bun:sqlite";
import { PEER_INTENTS, PeerIntentSchema, type PeerIntent, type ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import { teamRoster, resolvePersona } from "../agent/personas";
import { DEFAULT_VISIBILITY, redactStoredForCaller } from "../agent/visibility";
import {
  createDelegationTask,
  setDelegationJob,
  findActiveDelegation,
  getTask,
  cancelDelegation,
  type DelegationBrief,
  type TaskRow,
} from "../stores/tasks";
import { enqueueJob } from "../stores/jobs";
import { readFacts } from "./expand-tool";

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

export interface DelegateTaskToolDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
  currentAgentID: string;
  /** The channel the parent turn is in, for the status line. */
  channelID?: string;
  /** The parent turn, so the task can be traced back to what delegated it. */
  parentTurnID?: string;
  /** The parent thread, so the answer to a question can go back to it. */
  parentThreadID?: string;
}

export function registerDelegateTaskTool(registry: ToolRegistry, deps: DelegateTaskToolDeps): void {
  if (registry.get("delegate_task")) return;
  const team = teamRoster(deps.db, { exclude: deps.currentAgentID });

  registry.register({
    name: "delegate_task",
    description:
      "Start long-running work on another agent in the background and return immediately. " +
      "Use this instead of `handoff` when the job will take more than a few seconds (research, multi-step builds, inbox sweeps). " +
      "Give a focused brief; the specialist does not see this conversation. " +
      "The result is announced when it finishes — tell the user the work has started, do not wait for it.",
    kind: "static",
    // Large enough for mode=wait; async calls return immediately.
    timeoutMs: 310_000,
    schema: objectSchema({
      toAgentID: team.length > 0
        ? { type: "string", enum: team.map((member) => member.id), description: team.map((member) => `${member.id}: ${member.role}`).join("; ") }
        : stringProp,
      goal: { type: "string", minLength: 1, description: "What the specialist must accomplish, in one or two sentences." },
      intent: {
        type: "string",
        enum: [...PEER_INTENTS],
        description: "What this delegation is for: request (default), result, question, status or fyi.",
      },
      constraints: { type: "array", items: { type: "string" }, description: "Rules the result must respect." },
      deadline: { type: "string", description: "Optional ISO date/time by which the work is needed." },
      outputSchema: { type: "string", description: "Optional description of the shape of the result." },
      factIDs: { type: "array", items: { type: "string" }, description: "Ids of saved facts the child needs. Their text travels with the brief." },
      mode: {
        type: "string",
        enum: ["async", "wait"],
        description: "async (default) returns as soon as the work is queued; wait blocks until it finishes or the wait budget elapses. A wait timeout does not cancel the work.",
      },
      timeoutMs: { type: "number", description: "Wait budget in milliseconds for mode=wait (default 60000, max 300000)." },
    }, ["toAgentID", "goal"]),
    handler: async (args: Record<string, unknown>, ctx) => {
      const toAgentID = String(args.toAgentID ?? "").trim();
      if (!toAgentID) throw new Error("delegate_task requires a toAgentID");
      if (team.length > 0 && !team.some((member) => member.id === toAgentID)) {
        throw new Error(`unknown agent ${toAgentID}; the team is ${team.map((member) => member.id).join(", ")}`);
      }
      const goal = String(args.goal ?? "").trim();
      if (!goal) throw new Error("delegate_task requires a goal");

      const factIDs = Array.isArray(args.factIDs) ? args.factIDs.map(String).slice(0, 20) : undefined;
      const brief: DelegationBrief = {
        goal,
        intent: readIntent(args.intent),
        constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : undefined,
        deadline: args.deadline === undefined ? null : String(args.deadline),
        outputSchema: args.outputSchema === undefined ? null : String(args.outputSchema),
        ...(factIDs && factIDs.length > 0 ? { factIDs } : {}),
      };      // Idempotency: the same goal already in flight for the same specialist
      // from this caller is returned, not queued twice. A model retry must not
      // double the work; two different callers asking the same thing are two
      // pieces of work.
      const existing = findActiveDelegation(deps.db, toAgentID, goal, deps.currentAgentID);
      if (existing) {
        if (args.mode === "wait") {
          const waited = await waitForDelegation(deps.db, existing.id, waitBudget(args.timeoutMs), ctx.signal);
          return {
            ...taskView(waited.task, deps),
            jobID: existing.job_id,
            duplicate: true,
            waitTimedOut: waited.timedOut,
          };
        }
        return {
          taskID: existing.id,
          jobID: existing.job_id,
          agentID: toAgentID,
          state: existing.delegate_state,
          duplicate: true,
          message: `That work is already in flight with ${toAgentID}.`,
        };
      }
      const task = createDelegationTask(deps.db, {
        ownerAgentID: toAgentID,
        brief,
        origin: "ea_delegated",
        parentTurnID: deps.parentTurnID ?? null,
        parentThreadID: deps.parentThreadID ?? null,
        parentChannelID: deps.channelID ?? null,
        parentAgentID: deps.currentAgentID,
      });

      // The brief is the entire child context: goal, constraints, deadline and
      // result shape. The EA transcript is deliberately not forwarded.
      const job = enqueueJob(deps.db, {
        kind: "turn",
        payload: {
          lane: "task",
          agentID: toAgentID,
          text: formatBrief(brief),
          notify: true,
          delegationTaskID: task.id,
        },
      });
      setDelegationJob(deps.db, task.id, job.id);

      deps.emit({
        type: "status.update",
        channelId: deps.channelID ?? "main",
        agentId: deps.currentAgentID,
        text: `Started ${toAgentID} on: ${goal.slice(0, 80)}`,
        transient: true,
      });

      if (args.mode === "wait") {
        const waited = await waitForDelegation(deps.db, task.id, waitBudget(args.timeoutMs), ctx.signal);
        return {
          ...taskView(waited.task, deps),
          jobID: job.id,
          waitTimedOut: waited.timedOut,
          message: waited.timedOut
            ? `${toAgentID} is still working. The wait budget elapsed; the task was not cancelled.`
            : `${toAgentID} finished.`,
        };
      }

      return {
        taskID: task.id,
        jobID: job.id,
        agentID: toAgentID,
        state: "queued",
        message: `Work started with ${toAgentID}. I'll let you know when it finishes.`,
      };
    },
  });

  registerTaskStatusTool(registry, deps);
  registerDelegateWaitTool(registry, deps);
  registerTaskCancelTool(registry, deps);
}

/** A delegated task as the model sees it. */
function taskView(task: TaskRow, deps: DelegateTaskToolDeps): Record<string, unknown> {
  // The result of a private agent is a receipt, not text — the same rule the
  // synchronous handoff applies, so the async path cannot be the weak one.
  const owner = task.owner_agent_id ?? "";
  const visibility = owner ? resolvePersona(deps.db, owner)?.visibility ?? DEFAULT_VISIBILITY : DEFAULT_VISIBILITY;
  const result = redactStoredForCaller(task.result, owner, deps.currentAgentID, visibility);
  return {
    taskID: task.id,
    agentID: task.owner_agent_id,
    goal: task.title,
    state: task.delegate_state,
    result: result.value,
    resultRedacted: result.redacted,
    visibility,
    // DEL-004: the full result lives in an artifact. The reference is only
    // useful to a caller that may read it.
    artifactRef: result.redacted ? null : task.artifact_id,
    question: task.pending_question,
    questionID: task.pending_question_id,
    terminal: task.delegate_state === "done" || task.delegate_state === "failed",
    jobID: task.job_id,
    updatedAt: task.updated_at,
  };
}

/** Read the optional intent; absent means "request", invalid is an error. */
function readIntent(raw: unknown): PeerIntent {
  if (raw === undefined || raw === null || raw === "") return "request";
  const parsed = PeerIntentSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`intent must be one of ${PEER_INTENTS.join(", ")}`);
  return parsed.data;
}

/** Clamp the wait budget so a model cannot pin a turn open indefinitely. */
function waitBudget(raw: unknown): number {
  const value = Number(raw ?? 60_000);
  if (!Number.isFinite(value)) return 60_000;
  return Math.min(Math.max(Math.trunc(value), 1_000), 300_000);
}

async function waitForDelegation(
  db: Database,
  taskID: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ task: TaskRow; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = getTask(db, taskID);
    if (!task) throw new Error(`no task ${taskID}`);
    if (task.delegate_state === "done" || task.delegate_state === "failed") return { task, timedOut: false };
    if (Date.now() >= deadline) return { task, timedOut: true };
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())), signal);
  }
}

/** Sleep that rejects when the parent turn is cancelled. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function registerTaskStatusTool(registry: ToolRegistry, deps: DelegateTaskToolDeps): void {
  if (registry.get("task_status")) return;
  registry.register({
    name: "task_status",
    description:
      "Read the state and result of a task you delegated. Use it when the result is needed mid-turn, " +
      "or after `delegate_wait` timed out. It does not wait and does not cancel the work.",
    kind: "static",
    timeoutMs: 5_000,
    schema: objectSchema({ taskID: stringProp }, ["taskID"]),
    handler: async (args: Record<string, unknown>) => {
      const taskID = String(args.taskID ?? "").trim();
      const task = getTask(deps.db, taskID);
      if (!task) throw new Error(`no task ${taskID}`);
      return taskView(task, deps);
    },
  });
}

function registerDelegateWaitTool(registry: ToolRegistry, deps: DelegateTaskToolDeps): void {
  if (registry.get("delegate_wait")) return;
  registry.register({
    name: "delegate_wait",
    description:
      "Wait for a task you delegated to finish and return its result. " +
      "The timeout is only your wait budget: when it elapses the call returns waitTimedOut=true and the specialist keeps working. " +
      "Use task_status later to read the result.",
    kind: "static",
    timeoutMs: 310_000,
    schema: objectSchema({
      taskID: stringProp,
      timeoutMs: { type: "number", description: "Wait budget in milliseconds (default 60000, max 300000)." },
    }, ["taskID"]),
    handler: async (args: Record<string, unknown>, ctx) => {
      const taskID = String(args.taskID ?? "").trim();
      const waited = await waitForDelegation(deps.db, taskID, waitBudget(args.timeoutMs), ctx.signal);
      return { ...taskView(waited.task, deps), waitTimedOut: waited.timedOut };
    },
  });
}

function registerTaskCancelTool(registry: ToolRegistry, deps: DelegateTaskToolDeps): void {
  if (registry.get("task_cancel")) return;
  registry.register({
    name: "task_cancel",
    description:
      "Cancel a task you delegated. A queued job is removed; a running turn is stopped as soon as it checks in. " +
      "The task closes as failed with result 'cancelled by user'.",
    kind: "static",
    timeoutMs: 5_000,
    schema: objectSchema({ taskID: stringProp }, ["taskID"]),
    handler: async (args: Record<string, unknown>) => {
      const taskID = String(args.taskID ?? "").trim();
      const task = cancelDelegation(deps.db, taskID);
      if (!task) throw new Error(`no task ${taskID}`);
      return { ...taskView(task, deps), cancelled: task.delegate_state === "failed" };
    },
  });
}

/** Render the TaskPacket as the child's prompt. */
export function formatBrief(brief: DelegationBrief, facts: Array<{ id: string; text: string }> = []): string {
  const lines = [`Goal: ${brief.goal}`];
  if (brief.constraints?.length) lines.push(`Constraints:\n${brief.constraints.map((item) => `- ${item}`).join("\n")}`);
  if (facts.length > 0) {
    lines.push(`Facts you may need:\n${facts.map((fact) => `- [${fact.id}] ${fact.text}`).join("\n")}`);
  }
  if (brief.deadline) lines.push(`Deadline: ${brief.deadline}`);
  if (brief.outputSchema) lines.push(`Return format: ${brief.outputSchema}`);
  return lines.join("\n");
}
