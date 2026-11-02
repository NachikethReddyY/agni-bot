import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import type { TaskTurnSettings } from "../agent/task-loop";
import { executeRoutine } from "../routines/run";
import { nextRun } from "../routines/cron";
import { getRoutine } from "../stores/routines";
import { parseJobPayload, type JobRow } from "../stores/jobs";
import type { JobRunner } from "./runner";
import { seedCheckAppsRoutine } from "../routines/templates";
import { resolveTimeZone } from "../config";

export interface RoutineJobDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
}

export function registerRoutineJob(runner: JobRunner, deps: RoutineJobDeps): void {
  seedCheckAppsRoutine(deps.db, resolveTimeZone());
  runner.register("routine", async (job: JobRow) => {
    const payload = parseJobPayload<{ routineID?: string }>(job);
    if (!payload.routineID) throw new Error("routine job payload has no routineID");
    const routine = getRoutine(deps.db, payload.routineID);
    if (!routine) return;

    if (routine.misfire === "skip") {
      const scheduledAt = new Date(job.run_at);
      const nextScheduledAt = nextRun(routine.cron, routine.timezone, scheduledAt);
      const periodMs = nextScheduledAt.getTime() - scheduledAt.getTime();
      if (Date.now() - scheduledAt.getTime() > periodMs) {
        return { nextRunAt: nextRun(routine.cron, routine.timezone, new Date()).toISOString() };
      }
    }

    await executeRoutine(deps, routine);
    return { nextRunAt: nextRun(routine.cron, routine.timezone, new Date()).toISOString() };
  }, {
    // M38: after a failed run, skip to the routine's next cron slot (null if the routine is gone).
    nextRun: (job) => {
      const routineID = parseJobPayload<{ routineID?: string }>(job).routineID;
      const routine = routineID ? getRoutine(deps.db, routineID) : null;
      return routine ? nextRun(routine.cron, routine.timezone, new Date()).toISOString() : null;
    },
  });
}
