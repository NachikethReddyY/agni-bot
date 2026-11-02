/**
 * Background job runner. The daemon owns one runner; it claims due jobs from
 * SQLite and executes them on a small pool (`concurrency`, default 1 here and
 * 2 in the daemon), so background work is visible, bounded, and survives
 * restarts (claims and retries live in the table). Only kinds in
 * PARALLEL_KINDS may overlap with themselves; every other kind is a singleton
 * (memory consolidate, rollover, backup, ...) and never runs twice at once.
 *
 * Failure honesty: a handler that throws is retried up to `maxAttempts` with
 * exponential backoff and jitter, then parked as `failed` and announced with
 * a `notify` frame. A recurring kind skips to its next scheduled run instead
 * of dying. Nothing is silently dropped.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { log } from "../log";
import { claimDueJob, finishJob, requeueJob, type JobRow } from "../stores/jobs";

export interface JobOutcome {
  /** Short human-readable note stored on the job row. */
  result?: string;
  /** Set to run this job again at a later time (recurring jobs). */
  nextRunAt?: string;
}

export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<JobOutcome | void>;

/** Throw to fail this run without a retry (e.g. a retry would replay side effects). */
export class JobGiveUp extends Error {
  /** quiet: the handler already told the owner, so the runner does not notify. */
  constructor(message: string, readonly quiet = false) {
    super(message);
  }
}

export interface JobRegisterOptions {
  /** For recurring kinds: the next scheduled run after a failed one, or null for none. */
  nextRun?: (job: JobRow) => string | null;
}

const MAX_RETRY_DELAY_MS = 3_600_000;

/** Kinds whose jobs are independent of each other; all others run one at a time. */
export const PARALLEL_KINDS: ReadonlySet<string> = new Set(["turn", "routine", "task.reminder"]);

export interface JobContext {
  emit: (frame: ServerFrameBody) => void;
}

export interface JobRunnerOptions {
  pollMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxPerTick?: number;
  /** How many jobs may run at once (AGNI_JOB_CONCURRENCY). Default 1. */
  concurrency?: number;
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly nextRuns = new Map<string, (job: JobRow) => string | null>();
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxPerTick: number;
  private readonly concurrency: number;
  private readonly runningSingletons = new Set<string>();
  private workers = 0;

  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly emit: (frame: ServerFrameBody) => void,
    options: JobRunnerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 3000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.maxPerTick = options.maxPerTick ?? 3;
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  register(kind: string, handler: JobHandler, options: JobRegisterOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`job kind already registered: ${kind}`);
    this.handlers.set(kind, handler);
    if (options.nextRun) this.nextRuns.set(kind, options.nextRun);
  }

  /** Kinds this runner can execute — everything else is parked as failed. */
  kinds(): string[] {
    return [...this.handlers.keys()];
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    log.info(`job runner: polling every ${this.pollMs}ms [${this.kinds().join(", ") || "no kinds"}]`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Fill the free pool slots with workers; each claims due jobs (bounded per
   * tick) until none is due. A long job keeps only its own slot busy, so the
   * next tick still starts workers for reminders. Public so tests can drive it.
   */
  async tick(): Promise<number> {
    const free = this.concurrency - this.workers;
    const loops: Promise<number>[] = [];
    for (let i = 0; i < free; i += 1) {
      this.workers += 1;
      loops.push(this.work().finally(() => { this.workers -= 1; }));
    }
    return (await Promise.all(loops)).reduce((a, b) => a + b, 0);
  }

  private async work(): Promise<number> {
    let ran = 0;
    while (ran < this.maxPerTick) {
      const job = claimDueJob(this.db, undefined, [...this.runningSingletons]);
      if (!job) break;
      ran += 1;
      const singleton = !PARALLEL_KINDS.has(job.kind);
      if (singleton) this.runningSingletons.add(job.kind);
      try {
        await this.execute(job);
      } finally {
        if (singleton) this.runningSingletons.delete(job.kind);
      }
    }
    return ran;
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      finishJob(this.db, job.id, "failed", `no handler registered for kind "${job.kind}"`);
      this.notify(`Job failed`, `${job.kind}: no handler registered`);
      return;
    }

    try {
      const outcome = (await handler(job, { emit: this.emit })) ?? {};
      if (outcome.nextRunAt) {
        requeueJob(this.db, job.id, outcome.nextRunAt);
        // A clean recurring run starts a fresh retry budget for its next failure.
        this.db.run("UPDATE jobs SET attempts = 0 WHERE id = ?", [job.id]);
        if (outcome.result !== undefined) {
          this.db.run("UPDATE jobs SET result = ? WHERE id = ?", [`${outcome.result} (recurring)`, job.id]);
        }
        log.debug(`job ${job.id} (${job.kind}) done, next run ${outcome.nextRunAt}`);
      } else {
        finishJob(this.db, job.id, "done", outcome.result);
        log.info(`job ${job.id} (${job.kind}) done${outcome.result ? `: ${truncate(outcome.result, 80)}` : ""}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const quiet = error instanceof JobGiveUp && error.quiet;
      if (error instanceof JobGiveUp || job.attempts >= this.maxAttempts) {
        let next: string | null = null;
        try {
          next = this.nextRuns.get(job.kind)?.(job) ?? null;
        } catch {
          // A broken schedule cannot be skipped to; park the job below.
        }
        if (next) {
          // M38: a recurring job outlives a bad run: skip to its next slot.
          requeueJob(this.db, job.id, next);
          this.db.run("UPDATE jobs SET attempts = 0, result = ? WHERE id = ?", [`run failed: ${message}; next run ${next}`, job.id]);
          log.error(`job ${job.id} (${job.kind}) gave up on this run: ${message} — next run ${next}`);
          if (!quiet) this.notify("Job failed", `${job.kind}: ${truncate(message, 120)} (will run again ${next})`);
        } else {
          finishJob(this.db, job.id, "failed", message);
          log.error(`job ${job.id} (${job.kind}) failed after ${job.attempts} attempts: ${message}`);
          if (!quiet) this.notify("Job failed", `${job.kind}: ${truncate(message, 140)}`);
        }
      } else {
        const runAt = new Date(Date.now() + this.backoffMs(job.attempts)).toISOString();
        requeueJob(this.db, job.id, runAt);
        this.db.run("UPDATE jobs SET result = ? WHERE id = ?", [`attempt ${job.attempts} failed: ${message}`, job.id]);
        log.warn(`job ${job.id} (${job.kind}) attempt ${job.attempts} failed: ${message} — retrying at ${runAt}`);
      }
    }
  }

  /** Exponential backoff from `retryDelayMs`, capped at an hour, with jitter in [half, full]. */
  backoffMs(attempt: number): number {
    const full = Math.min(this.retryDelayMs * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
    return Math.round(full / 2 + Math.random() * (full / 2));
  }

  private notify(title: string, body: string): void {
    this.emit({ type: "notify", title, body, sound: false });
  }
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
