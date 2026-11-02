/**
 * Every job kind, registered in one place.
 *
 * A job that is enqueued but never registered is a silent failure: the runner
 * has no handler, the job parks as `failed`, and the owner gets a "Job
 * failed" notification for work nobody asked about. That happened once (the
 * rollover summary), so the kinds are registered together here and the test
 * beside it checks that every kind the code can enqueue has a handler.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import type { TaskTurnSettings } from "../agent/task-loop";
import type { JobRunner } from "./runner";
import { registerTurnJob } from "./turn";
import { registerBriefJob } from "./brief";
import { registerTaggerJob } from "./tagger";
import { registerMemoryJobs } from "./memory";
import { registerRolloverJob } from "./rollover";
import { registerTaskReminderJob } from "./task-reminders";
import { registerBackupJob } from "./backup";
import { registerRoutineJob } from "./routine";
import { registerHarnessReviewJob } from "./harness-review";

export interface AllJobsDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  firstTokenTimeoutMs: number;
  emit: (frame: ServerFrameBody) => void;
}

/** Register every job kind the daemon knows how to run. */
export function registerAllJobs(runner: JobRunner, deps: AllJobsDeps): void {
  registerTurnJob(runner, { db: deps.db, router: deps.router, settings: deps.settings, emit: deps.emit });
  registerRoutineJob(runner, { db: deps.db, router: deps.router, settings: deps.settings, emit: deps.emit });
  registerBackupJob(runner, { db: deps.db });
  registerBriefJob(runner, { db: deps.db, emit: deps.emit });
  registerTaskReminderJob(runner, { db: deps.db, emit: deps.emit });
  // TAG-001: memory is extracted in batches, never on the path of a turn.
  registerTaggerJob(runner, { db: deps.db, router: deps.router, emit: deps.emit });
  // MEM-003/MEM-006: vectors, the nightly sweep, the summary rollup.
  registerMemoryJobs(runner, { db: deps.db, router: deps.router });
  // The harness review: proposals from tool-usage counts, for the owner to approve.
  registerHarnessReviewJob(runner, { db: deps.db });
  // ROL-002: the summary of a closed block is written in the background, so
  // a turn never waits for it.
  registerRolloverJob(runner, {
    db: deps.db,
    router: deps.router,
    firstTokenTimeoutMs: deps.firstTokenTimeoutMs,
    emit: deps.emit,
  });
}
