import { Cron } from "croner";
import { ROUTINE_LIMITS } from "./types";

function makeCron(cron: string, tz: string): Cron {
  if (cron.trim().split(/\s+/).length !== 5) {
    throw new Error("Cron expression must have exactly five fields");
  }
  new Intl.DateTimeFormat("en-US", { timeZone: tz });
  return new Cron(cron, { timezone: tz, paused: true });
}

export function nextRun(cron: string, tz: string, after: Date): Date {
  const run = makeCron(cron, tz).nextRun(after);
  if (!run) throw new Error("Cron expression has no upcoming run");
  return run;
}

export function validateCron(cron: string, tz: string): void {
  const schedule = makeCron(cron, tz);
  const runs = schedule.nextRuns(10, new Date());
  if (runs.length !== 10) throw new Error("Cron expression has too few upcoming runs");
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < ROUTINE_LIMITS.minCronPeriodMs) {
      throw new Error("Cron period must be at least five minutes");
    }
  }
}
