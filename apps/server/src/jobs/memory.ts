/**
 * Memory maintenance (MEM-006).
 *
 * Two jobs, both optional and both idempotent:
 *
 *   - `memory.embed` backfills the vectors for the facts that do not have
 *     one (or have one from a different model).
 *   - `memory.consolidate` sweeps the store: it closes what is already
 *     superseded, merges duplicates, archives what nothing has used in
 *     months, and promotes what is used often into the pinned profile.
 *
 * Neither runs on the path of a turn, and neither resurrects anything a
 * hard delete removed.
 */
import type { Database } from "bun:sqlite";
import type { Router } from "../models/router";
import { log } from "../log";
import { embedderConfig, embedText } from "../agent/embeddings";
import {
  listMemoriesNeedingEmbedding,
  setMemoryEmbedding,
  type AgentMemoryRow,
} from "../stores/agent-memories";
import { nowISO } from "../util/ids";
import { nextDailyRun } from "./schedule";
import { rollupSummaries } from "./summary-rollup";
import type { JobRunner } from "./runner";

/** How long an unused fact stays warm before it is archived. */
export const ARCHIVE_AFTER_DAYS = 90;
/** The use count above which a fact is promoted to the pinned profile. */
export const PROMOTE_AFTER_USES = 10;
/** The salience above which a fact is never archived. */
export const KEEP_SALIENCE = 0.7;

export interface MemoryJobDeps {
  db: Database;
  router?: Router;
}

export function registerMemoryJobs(runner: JobRunner, deps: MemoryJobDeps): void {
  runner.register("memory.embed", async () => {
    const config = embedderConfig();
    if (!config) return { result: "no embedder configured" };
    const pending = listMemoriesNeedingEmbedding(deps.db, { model: config.model, limit: 200 });
    if (pending.length === 0) return { result: "nothing to embed" };
    let embedded = 0;
    for (const row of pending) {
      const vector = await embedText(row.content, config);
      if (!vector) break; // the embedder is down; stop, do not spin
      setMemoryEmbedding(deps.db, row.id, vector, config.model);
      embedded += 1;
    }
    log.info(`memory: embedded ${embedded} fact(s) with ${config.model}`);
    // More to do? Come back in a few minutes rather than in one long run.
    const remaining = listMemoriesNeedingEmbedding(deps.db, { model: config.model, limit: 1 });
    return {
      result: `embedded ${embedded} fact(s)`,
      ...(remaining.length > 0
        ? { nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString() }
        : {}),
    };
  });

  runner.register("summary.rollup", async () => {
    // CMP-001: the ladder of summaries — block → day → epoch. Deterministic,
    // so it costs nothing and can run in the background.
    const result = rollupSummaries(deps.db);
    return { result: `rolled up ${result.days} day(s) and ${result.epochs} epoch(s)` };
  });

  runner.register("memory.consolidate", async () => {
    const result = consolidateMemories(deps.db);
    log.info(
      `memory: consolidated — ${result.closed} closed, ${result.merged} merged, ` +
        `${result.archived} archived, ${result.promoted} promoted`,
    );
    return {
      result: `closed ${result.closed}, merged ${result.merged}, archived ${result.archived}, promoted ${result.promoted}`,
      // The sweep is a nightly habit, not a one-off.
      nextRunAt: nextDailyRun("03:00", undefined).toISOString(),
    };
  });
}

export interface ConsolidationResult {
  closed: number;
  merged: number;
  archived: number;
  promoted: number;
}

/**
 * The sweep. It only ever works on live rows, so a hard delete cannot be
 * undone by it, and it never deletes anything: archiving is a flag, and
 * forgetting is still the owner's call.
 */
export function consolidateMemories(
  db: Database,
  options: { now?: Date } = {},
): ConsolidationResult {
  const now = options.now ?? new Date();
  const result: ConsolidationResult = { closed: 0, merged: 0, archived: 0, promoted: 0 };

  // 1. Close what has been superseded but is still marked live. A superseded
  //    row keeps its history; it just stops being the current answer. (The
  //    normal path closes the old row when the new one is written; this
  //    catches the rows a crash left behind.)
  const stale = db
    .query<{ id: string }, []>(
      `SELECT id FROM agent_memories
       WHERE valid_to IS NULL
         AND id IN (SELECT supersedes_id FROM agent_memories WHERE supersedes_id IS NOT NULL)`,
    )
    .all();
  for (const row of stale) {
    db.run("UPDATE agent_memories SET valid_to = ? WHERE id = ? AND valid_to IS NULL", [now.toISOString(), row.id]);
    result.closed += 1;
  }

  // 2. Merge duplicates: two live rows with the same key and the same
  //    content are one fact, and the newer one wins.
  const duplicates = db
    .query<{ content: string; scope: string; agent_id: string; count: number }, []>(
      `SELECT content, scope, COALESCE(agent_id, '') AS agent_id, count(*) AS count
       FROM agent_memories
       WHERE valid_to IS NULL AND archived_at IS NULL
       GROUP BY scope, COALESCE(agent_id, ''), content
       HAVING count(*) > 1`,
    )
    .all();
  for (const duplicate of duplicates) {
    const rows = db
      .query<AgentMemoryRow, [string, string, string]>(
        `SELECT ${"id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at, kind, valid_from, valid_to, supersedes_id, source_block_id, source_turn_ids, last_used_at, use_count, embedding, confidence, salience, visibility, source, embedding_model, embedding_dim, archived_at"}
         FROM agent_memories
         WHERE scope = ? AND COALESCE(agent_id, '') = ? AND content = ? AND valid_to IS NULL
         ORDER BY updated_at DESC`,
      )
      .all(duplicate.scope, duplicate.agent_id, duplicate.content);
    for (const older of rows.slice(1)) {
      db.run("UPDATE agent_memories SET valid_to = ? WHERE id = ? AND valid_to IS NULL", [now.toISOString(), older.id]);
      result.merged += 1;
    }
  }

  // 3. Archive what nothing has used in months — unless it matters.
  const cutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 86_400_000).toISOString();
  const archived = db.run(
    `UPDATE agent_memories SET archived_at = ?
     WHERE valid_to IS NULL AND archived_at IS NULL
       AND salience < ? AND use_count <= 1
       AND COALESCE(last_used_at, updated_at) < ?`,
    [now.toISOString(), KEEP_SALIENCE, cutoff],
  );
  result.archived = archived.changes;

  // 4. Promote what is used often into the pinned profile: a fact that the
  //    owner keeps asking about belongs in front of them.
  const promoted = db.run(
    `UPDATE agent_memories SET salience = 1.0
     WHERE valid_to IS NULL AND archived_at IS NULL AND use_count >= ? AND salience < 1.0`,
    [PROMOTE_AFTER_USES],
  );
  result.promoted = promoted.changes;
  return result;
}
