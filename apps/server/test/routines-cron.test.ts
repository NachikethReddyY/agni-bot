import { describe, expect, test } from "bun:test";
import { nextRun, validateCron } from "../src/routines/cron";

describe("routine cron", () => {
  test("handles the spring-forward gap as Croner schedules it", () => {
    expect(nextRun("30 2 * * *", "America/New_York", new Date("2026-03-08T00:00:00Z")).toISOString())
      .toBe("2026-03-08T07:00:00.000Z");
  });

  test("fires once during the fall-back repeated hour", () => {
    const first = nextRun("30 1 * * *", "America/New_York", new Date("2026-10-31T12:00:00Z"));
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(nextRun("30 1 * * *", "America/New_York", first).toISOString())
      .toBe("2026-11-02T06:30:00.000Z");
  });

  test("accepts five-minute and weekday schedules", () => {
    expect(() => validateCron("*/5 * * * *", "UTC")).not.toThrow();
    expect(() => validateCron("0 9 * * 1-5", "America/New_York")).not.toThrow();
  });

  test("rejects invalid expressions, timezones, and sub-five-minute gaps", () => {
    for (const expression of ["99 * * * *", "not a cron", "* * * * * *", "*/2 * * * *", "0,2 * * * *"]) {
      expect(() => validateCron(expression, "UTC")).toThrow();
    }
    expect(() => validateCron("*/5 * * * *", "Not/A_Zone")).toThrow();
  });
});
