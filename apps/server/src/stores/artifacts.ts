/**
 * Artifacts — a delegated result stored by reference (DEL-004).
 *
 * The task row keeps a short summary, because that is what belongs in the
 * caller's context. The full result lives here, in the workspace of the
 * agent that produced it, and is only ever read through the visibility
 * filter: a private agent's artifact is a receipt to everyone else.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface ArtifactRow {
  id: string;
  task_id: string | null;
  agent_id: string;
  kind: string;
  content: string;
  created_at: string;
}

const COLUMNS = "id, task_id, agent_id, kind, content, created_at";

export function saveArtifact(
  db: Database,
  input: { taskID?: string | null; agentID: string; kind?: string; content: string },
): ArtifactRow {
  const content = input.content.trim();
  if (!content) throw new Error("an artifact needs content");
  if (content.length > 200_000) throw new Error("an artifact is at most 200000 characters");
  const row: ArtifactRow = {
    id: newID("art"),
    task_id: input.taskID ?? null,
    agent_id: input.agentID,
    kind: input.kind?.trim() || "result",
    content,
    created_at: nowISO(),
  };
  db.run(
    `INSERT INTO artifacts (id, task_id, agent_id, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.task_id, row.agent_id, row.kind, row.content, row.created_at],
  );
  return row;
}

export function getArtifact(db: Database, id: string): ArtifactRow | null {
  return db.query<ArtifactRow, [string]>(`SELECT ${COLUMNS} FROM artifacts WHERE id = ?`).get(id) ?? null;
}

export function listArtifactsForTask(db: Database, taskID: string): ArtifactRow[] {
  return db
    .query<ArtifactRow, [string]>(`SELECT ${COLUMNS} FROM artifacts WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskID);
}
