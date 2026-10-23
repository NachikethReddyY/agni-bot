/**
 * Every job kind that gets enqueued must have a handler.
 *
 * A kind that is enqueued but never registered is a silent failure: the
 * runner has no handler for it, the job parks as `failed`, and the owner
 * gets a "Job failed" notification for work nobody asked about. The rollover
 * summary shipped that way once — the test below is the scar.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { registerAllJobs } from "../src/jobs/registry";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

const SOURCE_ROOT = join(import.meta.dir, "..", "src");

/** Every source file under the server, so a new enqueue site is covered. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** The job kinds the code enqueues. */
function enqueuedKinds(): Set<string> {
  const kinds = new Set<string>();
  const pattern = /enqueueJob\([\s\S]{0,240}?kind:\s*"([a-z.]+)"/g;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      kinds.add(match[1]!);
    }
  }
  return kinds;
}

describe("the job registry", () => {
  test("every kind the code enqueues has a handler", () => {
    const db = openDatabase(":memory:");
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 1 });
    registerAllJobs(runner, {
      db,
      router: new Router([provider], new HealthTracker(), (async () => {
        throw new Error("not called");
      }) as unknown as typeof fetch),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      firstTokenTimeoutMs: 1000,
      emit: () => undefined,
    });
    const registered = new Set(runner.kinds());
    const enqueued = enqueuedKinds();
    expect(enqueued.size).toBeGreaterThan(0);
    const missing = [...enqueued].filter((kind) => !registered.has(kind));
    expect(missing).toEqual([]);
    db.close();
  });

  test("the kinds that matter are registered", () => {
    const db = openDatabase(":memory:");
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 1 });
    registerAllJobs(runner, {
      db,
      router: new Router([provider], new HealthTracker(), (async () => {
        throw new Error("not called");
      }) as unknown as typeof fetch),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      firstTokenTimeoutMs: 1000,
      emit: () => undefined,
    });
    const kinds = runner.kinds();
    for (const kind of ["turn", "brief", "tagger", "rollover.summarize", "memory.embed", "memory.consolidate", "summary.rollup"]) {
      expect(kinds).toContain(kind);
    }
    db.close();
  });
});
