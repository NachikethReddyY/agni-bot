/**
 * M50: a daily `VACUUM INTO` copy of the database, newest N kept.
 * The DB is the product; this is the only copy that survives a bad write.
 */
import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { enqueueJob } from "../stores/jobs";
import type { JobRunner } from "./runner";
import { nextDailyRun } from "./schedule";

export interface BackupOptions { dir?: string; keep?: number }

const isMemory = (db: Database) => !db.filename || db.filename === ":memory:";

/** Write today's backup unless it exists, then prune. Returns the path, or null when skipped. */
export function runBackup(db: Database, opts: BackupOptions = {}, now: Date = new Date()): string | null {
  if (isMemory(db)) return null;
  const dir = opts.dir ?? (Bun.env.AGNI_BACKUP_DIR?.trim() || join(dirname(db.filename), "backups"));
  const keep = opts.keep ?? (Number.parseInt(Bun.env.AGNI_BACKUP_KEEP ?? "", 10) || 7);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `agni-${now.toISOString().slice(0, 10).replaceAll("-", "")}.db`);
  if (!existsSync(file)) {
    db.run(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    chmodSync(file, 0o600);
  }
  const old = readdirSync(dir).filter((n) => /^agni-\d{8}\.db$/.test(n)).sort().reverse().slice(Math.max(1, keep));
  for (const name of old) unlinkSync(join(dir, name));
  return file;
}

/** Seed the single recurring job if none is live. */
export function ensureBackupJob(db: Database): void {
  if (isMemory(db)) return;
  const live = db.query("SELECT id FROM jobs WHERE kind='db.backup' AND state IN ('queued','running') LIMIT 1").get();
  if (!live) enqueueJob(db, { kind: "db.backup" });
}

export function registerBackupJob(runner: JobRunner, deps: { db: Database } & BackupOptions): void {
  ensureBackupJob(deps.db);
  runner.register("db.backup", async () => {
    const path = runBackup(deps.db, deps);
    return { result: path ? `backup ${path}` : "skipped (in-memory db)", nextRunAt: nextDailyRun("03:30", undefined).toISOString() };
  }, { nextRun: () => nextDailyRun("03:30", undefined).toISOString() });
}
