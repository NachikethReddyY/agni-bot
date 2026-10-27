/**
 * Background job runner. The daemon owns one runner; it claims due jobs from
 * SQLite and executes them sequentially, so background work is visible,
 * bounded, and survives restarts (claims and retries live in the table).
 *
 * Failure honesty: a handler that throws is retried up to `maxAttempts` with
 * a delay, then parked as `failed` and announced with a `notify` frame.
 * Nothing is silently dropped.
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

export interface JobContext {
  emit: (frame: ServerFrameBody) => void;
}

export interface JobRunnerOptions {
  pollMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxPerTick?: number;
}

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly pollMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxPerTick: number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
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
  }

  register(kind: string, handler: JobHandler): void {
    if (this.handlers.has(kind)) throw new Error(`job kind already registered: ${kind}`);
    this.handlers.set(kind, handler);
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

  /** Run every due job (bounded per tick). Public so tests can drive it. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let ran = 0;
    try {
      while (ran < this.maxPerTick) {
        const job = claimDueJob(this.db);
        if (!job) break;
        ran += 1;
        await this.execute(job);
      }
    } finally {
      this.ticking = false;
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
      if (job.attempts >= this.maxAttempts) {
        finishJob(this.db, job.id, "failed", message);
        log.error(`job ${job.id} (${job.kind}) failed after ${job.attempts} attempts: ${message}`);
        this.notify("Job failed", `${job.kind}: ${truncate(message, 140)}`);
      } else {
        const runAt = new Date(Date.now() + this.retryDelayMs).toISOString();
        requeueJob(this.db, job.id, runAt);
        this.db.run("UPDATE jobs SET result = ? WHERE id = ?", [`attempt ${job.attempts} failed: ${message}`, job.id]);
        log.warn(`job ${job.id} (${job.kind}) attempt ${job.attempts} failed: ${message} — retrying at ${runAt}`);
      }
    }
  }

  private notify(title: string, body: string): void {
    this.emit({ type: "notify", title, body, sound: false });
  }
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}
