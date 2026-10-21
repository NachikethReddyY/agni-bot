/**
 * Memory conflicts — the flag for review (MEM-002, conflict rule).
 *
 * When a new fact contradicts an older one, the newest user-stated fact
 * wins and the old one is closed. That is not the same as saying the
 * conflict did not happen, so the conflict is recorded: what changed, from
 * what, and when. The owner (or an eval) can look at it later.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface MemoryConflictRow {
  id: string;
  memory_id: string;
  previous_id: string;
  previous_content: string;
  content: string;
  created_at: string;
  resolved: number;
  resolved_at: string | null;
}

const COLUMNS = "id, memory_id, previous_id, previous_content, content, created_at, resolved, resolved_at";

export function recordConflict(
  db: Database,
  input: { memoryID: string; previousID: string; previousContent: string; content: string },
): MemoryConflictRow {
  const row: MemoryConflictRow = {
    id: newID("cfl"),
    memory_id: input.memoryID,
    previous_id: input.previousID,
    previous_content: input.previousContent,
    content: input.content,
    created_at: nowISO(),
    resolved: 0,
    resolved_at: null,
  };
  db.run(
    `INSERT INTO memory_conflicts (id, memory_id, previous_id, previous_content, content, created_at, resolved, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    [row.id, row.memory_id, row.previous_id, row.previous_content, row.content, row.created_at],
  );
  return row;
}

export function listConflicts(db: Database, options: { includeResolved?: boolean; limit?: number } = {}): MemoryConflictRow[] {
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = options.includeResolved ? "" : "WHERE resolved = 0";
  return db
    .query<MemoryConflictRow, [number]>(
      `SELECT ${COLUMNS} FROM memory_conflicts ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function resolveConflict(db: Database, id: string): boolean {
  const result = db.run(
    "UPDATE memory_conflicts SET resolved = 1, resolved_at = ? WHERE id = ? AND resolved = 0",
    [nowISO(), id],
  );
  return result.changes > 0;
}
