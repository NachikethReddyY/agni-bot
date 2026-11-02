import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "../src/jobs/backup";
import { nextDailyRun, nextIntervalRun } from "../src/jobs/schedule";
import { openDatabase } from "../src/db";
import { createTask, getTask } from "../src/stores/tasks";
import { JobRunner } from "../src/jobs/runner";
import { registerTaskReminderJob, scheduleTaskReminder } from "../src/jobs/task-reminders";

describe("db.backup", () => {
  test("copy is readable, mode 0600, keeps newest 7", () => {
    const root = mkdtempSync(join(tmpdir(), "agni-bk-"));
    const db = new Database(join(root, "it's.sqlite"));
    db.run("CREATE TABLE t(x)"); db.run("INSERT INTO t VALUES (42)");
    const dir = join(root, "backups");
    for (let d = 1; d <= 10; d += 1) runBackup(db, { dir, keep: 7 }, new Date(Date.UTC(2026, 0, d)));
    const files = readdirSync(dir).sort();
    expect(files.length).toBe(7);
    expect(files[0]).toBe("agni-20260104.db");
    const f = join(dir, files[6]!);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(new Database(f, { readonly: true }).query("SELECT x FROM t").get()).toEqual({ x: 42 });
    expect(runBackup(new Database(":memory:"), { dir })).toBeNull();
  });
});

describe("timezones", () => {
  const from = new Date("2026-06-01T00:00:00Z");
  test("09:05 Singapore vs UTC", () => {
    expect(nextDailyRun("09:05", undefined, from, "Asia/Singapore").toISOString()).toBe("2026-06-01T01:05:00.000Z");
    expect(nextDailyRun("09:05", undefined, from, "UTC").toISOString()).toBe("2026-06-01T09:05:00.000Z");
  });
  test("New York across DST (Mar 8 2026)", () => {
    expect(nextDailyRun("09:05", undefined, new Date("2026-03-07T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-03-08T13:05:00.000Z");
    expect(nextDailyRun("09:05", undefined, new Date("2026-03-06T15:00:00Z"), "America/New_York").toISOString()).toBe("2026-03-07T14:05:00.000Z");
  });
  test("weekday filter uses the zone's day", () => {
    // Sunday 2026-05-31 20:00Z is already Monday in Singapore.
    expect(nextDailyRun("09:05", [1], new Date("2026-05-31T20:00:00Z"), "Asia/Singapore").toISOString()).toBe("2026-06-01T01:05:00.000Z");
  });
  test("everyMs keeps cadence, skips missed", () => {
    expect(nextIntervalRun("2026-01-01T00:00:00Z", 3600_000, Date.parse("2026-01-01T00:00:40Z")).toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(nextIntervalRun("2026-01-01T00:00:00Z", 3600_000, Date.parse("2026-01-01T03:10:00Z")).toISOString()).toBe("2026-01-01T04:00:00.000Z");
  });
});

describe("daily reminder catch-up", () => {
  test("a week offline fires once, next occurrence is in the future", async () => {
    const db = openDatabase(":memory:");
    const runner = new JobRunner(db, () => {});
    const sent: unknown[] = [];
    registerTaskReminderJob(runner, { db, emit: (f) => sent.push(f) });
    const past = new Date(Date.now() - 7 * 86400_000 - 3600_000).toISOString();
    const task = createTask(db, { title: "pills", reminderAt: past, repeatRule: "daily" } as never);
    scheduleTaskReminder(db, task.id);
    db.run("UPDATE jobs SET run_at=? WHERE kind='task.reminder'", [past]);
    await runner.tick();
    expect(sent.length).toBe(1);
    const next = getTask(db, task.id)!.reminder_at!;
    expect(Date.parse(next)).toBeGreaterThan(Date.now());
    expect(Date.parse(next)).toBeLessThanOrEqual(Date.now() + 86400_000);
    await runner.tick();
    expect(sent.length).toBe(1);
  });
});
