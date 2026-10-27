/**
 * The agent's clock. A schedule has to survive a restart, land on the
 * wall-clock time the owner named, and not fire on the days it was told to
 * skip — "weekdays at 9:05" is not "every 24 hours".
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { cancelScheduledJob, listScheduledJobs, scheduleJob } from "../src/tools/jobs-tool";
import { describeSchedule, nextDailyRun, parseDay, parseWallClock } from "../src/jobs/schedule";
import { getJob } from "../src/stores/jobs";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("wall-clock schedules", () => {
  test("a clock time and its weekdays are understood", () => {
    expect(parseWallClock("09:05")).toEqual({ hour: 9, minute: 5 });
    expect(() => parseWallClock("9am")).toThrow(/wall-clock/);
    expect(parseDay("mon")).toBe(1);
    expect(parseDay("Monday")).toBe(1);
    expect(parseDay(0)).toBe(0);
    expect(describeSchedule("09:05", [1, 2, 3, 4, 5])).toBe("mon, tue, wed, thu, fri at 09:05");
    expect(describeSchedule("09:05", undefined)).toBe("every day at 09:05");
  });

  test("the next run skips the days the schedule does not fire on", () => {
    // Friday 10:00 → Monday 09:05.
    const friday = new Date(2026, 9, 23, 10, 0, 0, 0);
    const next = nextDailyRun("09:05", [1, 2, 3, 4, 5], friday);
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(5);
    expect(next.getTime()).toBeGreaterThan(friday.getTime());
    // Saturday → Monday as well.
    const saturday = new Date(2026, 9, 24, 8, 0, 0, 0);
    expect(nextDailyRun("09:05", [1, 2, 3, 4, 5], saturday).getDay()).toBe(1);
    // Same day, later hour → today.
    const early = new Date(2026, 9, 23, 7, 0, 0, 0);
    const sameDay = nextDailyRun("09:05", [1, 2, 3, 4, 5], early);
    expect(sameDay.getDay()).toBe(5);
    expect(sameDay.getDate()).toBe(23);
  });
});

describe("scheduling tools", () => {
  test("a weekday clock becomes a durable job", () => {
    db = openDatabase(":memory:");
    const database = db;
    const result = scheduleJob(database, {
      text: "Sift the inbox and escalate what matters.",
      dailyAt: "09:05",
      days: ["mon", "tue", "wed", "thu", "fri"],
      agentID: "friday",
    }, "ea");

    expect(result.recurrence).toBe("mon, tue, wed, thu, fri at 09:05");
    expect(result.agent).toBe("friday");
    // The row is in the database, so it survives a restart.
    const row = getJob(database, result.id);
    expect(row?.kind).toBe("turn");
    expect(row?.state).toBe("queued");
    const payload = JSON.parse(row?.payload ?? "{}") as { dailyAt: string; days: number[]; text: string };
    expect(payload.dailyAt).toBe("09:05");
    expect(payload.days).toEqual([1, 2, 3, 4, 5]);
    expect(payload.text).toBe("Sift the inbox and escalate what matters.");
    // The next run is on a weekday, at the wall-clock time.
    const runAt = new Date(row?.run_at ?? "");
    expect([1, 2, 3, 4, 5]).toContain(runAt.getDay());
    expect(runAt.getHours()).toBe(9);
    expect(runAt.getMinutes()).toBe(5);
  });

  test("a one-off job runs at the moment it was given", () => {
    db = openDatabase(":memory:");
    const database = db;
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const result = scheduleJob(database, { text: "Remind me.", at: when }, "ea");
    expect(result.recurrence).toBe("once");
    expect(new Date(result.nextRun).getTime()).toBe(new Date(when).getTime());
  });

  test("a job with no time is refused", () => {
    db = openDatabase(":memory:");
    const database = db;
    expect(() => scheduleJob(database, { text: "Do something." }, "ea")).toThrow(/say when it should run/);
    expect(() => scheduleJob(database, { text: "Do something.", at: "not-a-date" }, "ea")).toThrow(/not a date/);
  });

  test("scheduled work is visible, and cancelling it stops it", () => {
    db = openDatabase(":memory:");
    const database = db;
    const job = scheduleJob(database, { text: "Sweep the inbox.", everyMinutes: 30 }, "ea");
    const list = listScheduledJobs(database);
    const found = list.scheduled.find((entry) => entry.id === job.id);
    expect(found?.what).toBe("Sweep the inbox.");
    expect(found?.recurrence).toBe("every 30 minute(s)");

    const cancelled = cancelScheduledJob(database, job.id.slice(0, 12));
    expect(cancelled.state).toBe("cancelled");
    expect(listScheduledJobs(database).scheduled.find((entry) => entry.id === job.id)).toBeUndefined();
    expect(() => cancelScheduledJob(database, job.id)).toThrow(/no scheduled job/);
  });
});
