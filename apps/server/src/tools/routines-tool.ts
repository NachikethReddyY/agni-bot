import type { Database } from "bun:sqlite";
import type { ToolDefinition } from "./registry";
import { deleteJob, enqueueJob, getJob, setJobEnabled } from "../stores/jobs";
import { deleteRoutineByJobID, getRoutine, insertRoutine, listRoutines, listRuns } from "../stores/routines";
import { assertReadOnlySelect } from "../routines/preflight";
import { nextRun, validateCron } from "../routines/cron";
import { ROUTINE_DEFAULTS } from "../routines/types";
import type { Preflight, Routine } from "../routines/types";
import { newID, nowISO } from "../util/ids";

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

function timezoneValid(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); return true; } catch { return false; }
}

/** Delete the job and its routine rows together, so a crash cannot leave orphans. */
export function deleteRoutineJob(db: Database, jobID: string): boolean {
  return db.transaction(() => {
    if (!deleteJob(db, jobID)) return false;
    deleteRoutineByJobID(db, jobID);
    return true;
  })();
}

function callerRoutine(db: Database, id: string, agentID: string): Routine {
  const routine = getRoutine(db, id);
  if (!routine || routine.agentID !== agentID) throw new Error(`no routine with id "${id}"`);
  return routine;
}

function createRoutine(db: Database, args: Record<string, unknown>, agentID: string): Routine {
  const name = String(args.name ?? "").trim();
  const prompt = String(args.prompt ?? "").trim();
  const cron = String(args.cron ?? "").trim();
  const timezone = String(args.timezone ?? "").trim();
  const misfireValue = args.misfire === undefined ? ROUTINE_DEFAULTS.misfire : String(args.misfire);
  if (misfireValue !== "skip" && misfireValue !== "run_once") throw new Error("misfire must be skip or run_once");
  const preflightInput = (args.preflight ?? { kind: "none" }) as Record<string, unknown>;
  if (!name || name.length > 120 || !prompt || prompt.length > 4_000) throw new Error("name and prompt are required (name max 120, prompt max 4000)");
  if (!timezoneValid(timezone)) throw new Error(`invalid timezone "${timezone}"`);
  validateCron(cron, timezone);
  let preflight: Preflight;
  if (preflightInput.kind === "http") {
    let url: URL;
    try { url = new URL(String(preflightInput.url ?? "")); } catch { throw new Error("preflight URL is invalid"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("preflight URL must use http or https");
    preflight = { kind: "http", url: url.toString() };
  } else if (preflightInput.kind === "sql") {
    const query = String(preflightInput.query ?? "").trim();
    assertReadOnlySelect(query);
    preflight = { kind: "sql", query };
  } else if (preflightInput.kind === "none") {
    preflight = { kind: "none" };
  } else throw new Error("preflight kind must be http, sql, or none");

  const maxTokens = args.maxTokens === undefined ? ROUTINE_DEFAULTS.maxTokens : Number(args.maxTokens);
  const maxExecutionMs = args.maxExecutionMs === undefined ? ROUTINE_DEFAULTS.maxExecutionMs : Number(args.maxExecutionMs);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 16_000) throw new Error("maxTokens must be a positive integer no greater than 16000");
  if (!Number.isInteger(maxExecutionMs) || maxExecutionMs < 1 || maxExecutionMs > 600_000) throw new Error("maxExecutionMs must be a positive integer no greater than 600000");

  const id = newID("rtn");
  const createdAt = nowISO();
  const runAt = nextRun(cron, timezone, new Date()).toISOString();
  let routine!: Routine;
  db.transaction(() => {
    const job = enqueueJob(db, { kind: "routine", payload: { routineID: id }, runAt });
    routine = {
      id, jobID: job.id, agentID, name, prompt, cron, timezone, misfire: misfireValue,
      preflight, maxTokens, maxExecutionMs, allowedDomains: [], threadID: null,
      lastStateHash: null, stateContext: null, successStreak: 0, failureStreak: 0,
      createdAt, updatedAt: createdAt,
    };
    insertRoutine(db, routine);
  })();
  return routine;
}

export function createRoutineTools(db: Database): ToolDefinition<unknown, unknown>[] {
  return [
    {
      name: "routine_create", description: "Create a recurring background routine for this bot.", kind: "static",
      schema: objectSchema({
        name: { type: "string", minLength: 1, maxLength: 120 }, prompt: { type: "string", minLength: 1, maxLength: 4000 },
        cron: stringProp, timezone: stringProp,
        preflight: { type: "object", properties: { kind: { type: "string", enum: ["http", "sql", "none"] }, url: { type: "string" }, query: { type: "string" } }, required: ["kind"], additionalProperties: false },
        misfire: { type: "string", enum: ["skip", "run_once"] },
        maxTokens: { type: "integer", minimum: 1, maximum: 16000 }, maxExecutionMs: { type: "integer", minimum: 1, maximum: 600000 },
      }, ["name", "prompt", "cron", "timezone"]), timeoutMs: 5_000,
      handler: async (args, ctx) => {
        if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
        return createRoutine(db, (args ?? {}) as Record<string, unknown>, ctx.chain?.currentAgentID ?? "ea");
      },
    } as ToolDefinition<unknown, unknown>,
    {
      name: "routine_list", description: "List this bot's routines and recent outcomes.", kind: "static",
      schema: objectSchema({}, []), timeoutMs: 2_000,
      handler: async (_args, ctx) => listRoutines(db).filter((r) => r.agentID === (ctx.chain?.currentAgentID ?? "ea")).map((r) => ({
        id: r.id, name: r.name, cron: r.cron, timezone: r.timezone,
        nextRun: getJob(db, r.jobID)?.run_at ?? null,
        lastOutcome: listRuns(db, r.id, 1)[0]?.outcome ?? null,
      })),
    } as ToolDefinition<unknown, unknown>,
    {
      name: "routine_pause", description: "Pause or resume one of this bot's routines.", kind: "static",
      schema: objectSchema({ id: stringProp, enabled: { type: "boolean" } }, ["id", "enabled"]), timeoutMs: 2_000,
      handler: async (args, ctx) => {
        const input = (args ?? {}) as Record<string, unknown>;
        const routine = callerRoutine(db, String(input.id ?? ""), ctx.chain?.currentAgentID ?? "ea");
        setJobEnabled(db, routine.jobID, Boolean(input.enabled));
        return { id: routine.id, enabled: Boolean(input.enabled) };
      },
    } as ToolDefinition<unknown, unknown>,
    {
      name: "routine_delete", description: "Delete one of this bot's routines.", kind: "static",
      schema: objectSchema({ id: stringProp }, ["id"]), timeoutMs: 2_000,
      handler: async (args, ctx) => {
        if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
        const routine = callerRoutine(db, String(((args ?? {}) as Record<string, unknown>).id ?? ""), ctx.chain?.currentAgentID ?? "ea");
        if (!deleteRoutineJob(db, routine.jobID)) throw new Error("routine is running and cannot be deleted yet");
        return { id: routine.id, deleted: true };
      },
    } as ToolDefinition<unknown, unknown>,
  ];
}
