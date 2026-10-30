/**
 * Wall-clock recurrence for scheduled work.
 *
 * A fixed interval is the wrong shape for anything a human states as a clock:
 * "weekdays at 9:05" must not drift across a DST change and must not fire on
 * a Saturday. A schedule is therefore a local wall-clock time plus the days
 * it fires on, and the next run is computed from those.
 */

import { resolveTimeZone } from "../config";

export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export interface WallClock {
  hour: number;
  minute: number;
}

/** Parse "09:05" into a wall-clock time. Throws on anything else. */
export function parseWallClock(value: string): WallClock {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`expected a wall-clock time like "09:05", got "${value}"`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`"${value}" is not a time of day`);
  return { hour, minute };
}

/**
 * A weekday: "mon", "Monday", "mon." or 0-6 (0 = Sunday). The model writes
 * both spellings, so both are accepted.
 */
export function parseDay(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 6) throw new Error(`expected a weekday 0-6 (0 = Sunday), got ${value}`);
    return value;
  }
  const text = value.trim().toLowerCase().replace(/\.$/, "");
  const index = DAY_NAMES.indexOf(text.slice(0, 3) as (typeof DAY_NAMES)[number]);
  if (index >= 0) return index;
  const numeric = Number(text);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) return numeric;
  throw new Error(`expected a weekday like "mon" or 1-6 (0 = Sunday), got "${value}"`);
}

/** Calendar fields of `date` as seen in `timeZone`. */
function zoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)])) as Record<string, number>;
  return { year: v.year!, month: v.month!, day: v.day!, hour: v.hour!, minute: v.minute!, second: v.second! };
}

/** The instant at which `timeZone`'s wall clock reads y-m-d h:min. Day/month may overflow. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let i = 0; i < 3; i += 1) {
    const p = zoneParts(new Date(guess), timeZone);
    guess += desired - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(guess);
}

/**
 * The next moment the schedule fires, strictly after `from`, on the wall
 * clock of `timeZone` (AGNI_TZ, default the server's zone).
 */
export function nextDailyRun(at: string, days: number[] | undefined, from: Date = new Date(), timeZone: string = resolveTimeZone()): Date {
  const { hour, minute } = parseWallClock(at);
  const allowed = days && days.length > 0 ? new Set(days) : null;
  const today = zoneParts(from, timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const dayStart = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const candidate = zonedTime(dayStart.getUTCFullYear(), dayStart.getUTCMonth() + 1, dayStart.getUTCDate(), hour, minute, timeZone);
    if (candidate.getTime() <= from.getTime()) continue;
    if (allowed && !allowed.has(dayStart.getUTCDay())) continue;
    return candidate;
  }
  throw new Error(`no next run found for ${describeSchedule(at, days)}`);
}

/**
 * Next run of an `everyMs` job: the previous scheduled time plus whole
 * intervals, skipping missed ones, so run duration never shifts the cadence.
 */
export function nextIntervalRun(scheduledAt: string | Date, everyMs: number, now: number = Date.now()): Date {
  const base = new Date(scheduledAt).getTime();
  if (!Number.isFinite(base)) return new Date(now + everyMs);
  const steps = Math.max(1, Math.floor((now - base) / everyMs) + 1);
  return new Date(base + steps * everyMs);
}

/** Human description of a schedule, for the model and for the owner. */
export function describeSchedule(at: string, days: number[] | undefined): string {
  const { hour, minute } = parseWallClock(at);
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (!days || days.length === 0 || days.length === 7) return `every day at ${clock}`;
  const names = [...new Set(days)].sort((a, b) => a - b).map((day) => DAY_NAMES[day]);
  return `${names.join(", ")} at ${clock}`;
}
