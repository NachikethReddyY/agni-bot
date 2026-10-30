/** Shared scratchpad per delegated task (migration 58). */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface TaskNoteRow { id: string; task_id: string; agent_id: string; text: string; created_at: string }

/** Notes kept per task; the oldest beyond this are dropped on append. */
export const MAX_TASK_NOTES = 100;

export function appendTaskNote(db: Database, taskID: string, agentID: string, text: string): TaskNoteRow {
  const row: TaskNoteRow = { id: newID("tnt"), task_id: taskID, agent_id: agentID, text, created_at: nowISO() };
  db.run("INSERT INTO task_notes (id, task_id, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
    [row.id, row.task_id, row.agent_id, row.text, row.created_at]);
  db.run(
    `DELETE FROM task_notes WHERE task_id = ? AND id NOT IN
       (SELECT id FROM task_notes WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    [taskID, taskID, MAX_TASK_NOTES],
  );
  return row;
}

export function listTaskNotes(db: Database, taskID: string): TaskNoteRow[] {
  return db.query<TaskNoteRow, [string]>(
    "SELECT id, task_id, agent_id, text, created_at FROM task_notes WHERE task_id = ? ORDER BY created_at, rowid",
  ).all(taskID);
}
