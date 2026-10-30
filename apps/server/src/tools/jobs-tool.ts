/**
 * Scheduling tools — the agent's clock.
 *
 * The daemon already knows how to run background turns (the `turn` job kind:
 * a prompt in a thread, optionally recurring) and how to pause and resume
 * them. What was missing was a way for the *agent* to put work on that clock.
 * "Check my inbox every weekday at 9:05" had no tool at all, so the model
 * went looking for one in the app's own source and burned the turn.
 *
 * A scheduled job is a durable row: it survives restarts, it is visible in
 * `job_list`, and `job_cancel` stops it. Nothing here sends anything by
 * itself — a scheduled run is a normal turn, with the same tool rules.
 */
import type { Database } from "bun:sqlite";
import type { ToolContext, ToolDefinition } from "./registry";
import {
  deleteJob, enqueueJob, getJob, getJobByPrefix, listFinishedJobs, listJobs, setJobEnabled,
} from "../stores/jobs";
import { canonicalAgentID } from "../agent/personas";
import { describeSchedule, nextDailyRun, parseDay, parseWallClock } from "../jobs/schedule";

export interface JobScheduleArgs {
  /** The prompt the scheduled run executes. */
  text: string;
  /** One-off run at an ISO timestamp. */
  at?: string;
  /** Recurring run at a local wall-clock time, "09:05". */
  dailyAt?: string;
  /** Weekdays a `dailyAt` schedule fires on: "mon".."sun". */
  days?: string[];
  /** Recurring run every N minutes. */
  everyMinutes?: number;
  /** Which agent runs it. Defaults to the agent that scheduled it. */
  agentID?: string;
  /** Raise a notification when a run ends. Default true. */
  notify?: boolean;
}

export interface JobScheduleResult {
  id: string;
  /** When it next fires, ISO. */
  nextRun: string;
  /** Plain description of the schedule. */
  recurrence: string;
  agent: string;
  what: string;
}

export interface JobListResult {
  scheduled: ScheduledJobView[];
  recentlyFinished: ScheduledJobView[];
}

export interface ScheduledJobView {
  id: string;
  state: string;
  nextRun: string;
  recurrence: string;
  agent: string;
  what: string;
  lastResult: string | null;
}

const MIN_EVERY_MINUTES = 5;

export function scheduleJob(db: Database, args: JobScheduleArgs, callerAgentID: string): JobScheduleResult {
  const requested = args.agentID?.trim();
  if (requested && canonicalAgentID(requested) !== canonicalAgentID(callerAgentID)) {
    throw new Error("an agent may only schedule jobs for itself");
  }
  const text = args.text.trim();
  if (!text) throw new Error("a scheduled job needs something to do");
  const choices = [args.at, args.dailyAt, args.everyMinutes].filter((value) => value !== undefined && value !== null);
  if (choices.length === 0) throw new Error("say when it should run: `at` (one-off), `dailyAt` (a clock time), or `everyMinutes`");
  if (choices.length > 1) throw new Error("pick one: `at`, `dailyAt` or `everyMinutes`");

  const payload: Record<string, unknown> = {
    text,
    agentID: callerAgentID,
    // C4: scheduled text is model-authored, so it runs as non-owner input.
    inputRole: "system",
    notify: args.notify !== false,
  };

  let runAt: string;
  let recurrence: string;
  if (args.at) {
    const when = new Date(args.at);
    if (Number.isNaN(when.getTime())) throw new Error(`"${args.at}" is not a date`);
    runAt = when.toISOString();
    recurrence = "once";
  } else if (args.dailyAt) {
    const clock = parseWallClock(args.dailyAt);
    const days = args.days?.map((day) => parseDay(day));
    const at = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    runAt = nextDailyRun(at, days).toISOString();
    recurrence = describeSchedule(at, days);
    payload.dailyAt = at;
    if (days && days.length > 0) payload.days = days;
  } else {
    const minutes = Number(args.everyMinutes);
    if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES || minutes > 10_080) {
      throw new Error(`everyMinutes must be between ${MIN_EVERY_MINUTES} and 10080 (a week)`);
    }
    const everyMs = Math.round(minutes * 60_000);
    runAt = new Date(Date.now() + everyMs).toISOString();
    recurrence = `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    payload.everyMs = everyMs;
  }

  const row = enqueueJob(db, { kind: "turn", payload, runAt });
  return {
    id: row.id,
    nextRun: runAt,
    recurrence,
    agent: String(payload.agentID),
    what: text.slice(0, 200),
  };
}

export function listScheduledJobs(db: Database, callerAgentID: string, limit = 20): JobListResult {
  const view = (row: NonNullable<ReturnType<typeof getJob>>): ScheduledJobView => {
    const payload = parsePayload(row.payload);
    const dailyAt = typeof payload.dailyAt === "string" ? payload.dailyAt : null;
    const days = Array.isArray(payload.days) ? (payload.days as unknown[]).map(Number) : undefined;
    return {
      id: row.id,
      state: row.enabled === 0 ? "paused" : row.state,
      nextRun: row.run_at,
      recurrence: dailyAt
        ? describeSchedule(dailyAt, days)
        : payload.everyMs
          ? `every ${Math.round(Number(payload.everyMs) / 60_000)} minute(s)`
          : "once",
      agent: String(payload.agentID ?? "ea"),
      what: String(payload.text ?? "").slice(0, 200),
      lastResult: row.result,
    };
  };
  const mine = (row: NonNullable<ReturnType<typeof getJob>>) => ownsJob(row, callerAgentID);
  return {
    scheduled: listJobs(db, { limit: 500 }).filter(mine).slice(0, limit).map(view),
    recentlyFinished: listFinishedJobs(db, 100).filter(mine).slice(0, 5).map(view),
  };
}

function ownsJob(row: NonNullable<ReturnType<typeof getJob>>, callerAgentID: string): boolean {
  return row.kind === "turn" && canonicalAgentID(String(parsePayload(row.payload).agentID ?? "ea")) === canonicalAgentID(callerAgentID);
}

export function cancelScheduledJob(db: Database, id: string, callerAgentID: string): { id: string; state: string; note: string } {
  const found = getJob(db, id) ?? getJobByPrefix(db, id);
  // Someone else's job looks the same as a missing one.
  const row = found && ownsJob(found, callerAgentID) ? found : undefined;
  if (!row) throw new Error(`no scheduled job with id "${id}"`);
  if (row.state === "running") {
    setJobEnabled(db, row.id, false);
    return { id: row.id, state: "paused", note: "it is running right now; it will not run again" };
  }
  deleteJob(db, row.id);
  return { id: row.id, state: "cancelled", note: "it will not run again" };
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

function callerOf(ctx: ToolContext): string {
  const id = ctx.chain?.currentAgentID;
  if (!id) throw new Error("unknown calling agent");
  return id;
}

/** The scheduling tools, as the task lane sees them. */
export function createJobTools(db: Database): ToolDefinition<unknown, unknown>[] {
  return [
    {
      name: "job_schedule",
      description:
        "Schedule work for later. Use it when the owner asks for something on a clock (\"every weekday at 9:05\", \"tomorrow morning\", \"every 30 minutes\"). " +
        "The job runs the given text as a turn — say exactly what it should do, in the imperative, and let it use tools. " +
        "Give a `dailyAt` (local wall-clock time like \"09:05\") with `days` ([\"mon\",\"tue\",\"wed\",\"thu\",\"fri\"]) for a recurring clock, " +
        "`at` (ISO timestamp) for a one-off, or `everyMinutes` for a fixed interval.",
      kind: "static",
      schema: objectSchema({
        text: { type: "string", minLength: 1, maxLength: 4_000 },
        at: { type: "string", description: "ISO timestamp for a one-off run" },
        dailyAt: { type: "string", description: "Local wall-clock time for a recurring run, e.g. \"09:05\"" },
        days: { type: "array", maxItems: 7, items: { type: "string" }, description: "Weekdays for a dailyAt schedule" },
        everyMinutes: { type: "integer", minimum: MIN_EVERY_MINUTES, maximum: 10_080 },
        agent_id: stringProp,
        notify: { type: "boolean" },
      }, ["text"]),
      timeoutMs: 3_000,
      handler: async (args, ctx) => {
        if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
        const input = (args ?? {}) as Record<string, unknown>;
        return scheduleJob(db, {
          text: String(input.text ?? ""),
          ...(input.at === undefined ? {} : { at: String(input.at) }),
          ...(input.dailyAt === undefined ? {} : { dailyAt: String(input.dailyAt) }),
          ...(input.days === undefined ? {} : { days: (input.days as unknown[]).map((day) => String(day)) }),
          ...(input.everyMinutes === undefined ? {} : { everyMinutes: Number(input.everyMinutes) }),
          ...(input.agent_id === undefined ? {} : { agentID: String(input.agent_id) }),
          ...(input.notify === undefined ? {} : { notify: Boolean(input.notify) }),
        }, callerOf(ctx));
      },
    } as ToolDefinition<unknown, unknown>,
    {
      name: "job_list",
      description: "List scheduled work: what is queued, when it next runs, and what ran recently.",
      kind: "static",
      schema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 50 } }, []),
      timeoutMs: 2_000,
      handler: async (args, ctx) => {
        const input = (args ?? {}) as Record<string, unknown>;
        const limit = typeof input.limit === "number" ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 20;
        return listScheduledJobs(db, callerOf(ctx), limit);
      },
    } as ToolDefinition<unknown, unknown>,
    {
      name: "job_cancel",
      description: "Cancel a scheduled job by id (or a unique prefix). It will not run again.",
      kind: "static",
      schema: objectSchema({ id: stringProp }, ["id"]),
      timeoutMs: 2_000,
      handler: async (args, ctx) => {
        if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
        const input = (args ?? {}) as Record<string, unknown>;
        return cancelScheduledJob(db, String(input.id ?? ""), callerOf(ctx));
      },
    } as ToolDefinition<unknown, unknown>,
  ];
}
