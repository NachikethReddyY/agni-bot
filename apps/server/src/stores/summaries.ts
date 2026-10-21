/**
 * Summaries, in levels (CMP-001).
 *
 * A block's summary is one level of a ladder: block → day → epoch. The
 * block summary says what happened in one session block; the day summary
 * says what happened in a day; the epoch summary says what happened over
 * a longer stretch. Each level keeps the range it came from, so a summary
 * can always be traced back to the turns that produced it.
 *
 * The levels are rolled up by a job, not by a turn: rolling up is
 * background work, and the owner's next message never waits for it.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export type SummaryLevel = "block" | "day" | "epoch";

export interface SummaryRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  level: SummaryLevel;
  /** The summary this one was rolled up from. */
  parent_id: string | null;
  title: string;
  text: string;
  structured: string | null;
  /** The turns the summary covers. */
  source_from: number | null;
  source_to: number | null;
  /** The day the summary covers (YYYY-MM-DD). */
  day: string | null;
  created_at: string;
}

const COLUMNS =
  "id, conversation_id, agent_id, level, parent_id, title, text, structured, source_from, source_to, day, created_at";

export function saveSummary(
  db: Database,
  input: {
    conversationID: string;
    agentID: string;
    level: SummaryLevel;
    title: string;
    text: string;
    structured?: unknown;
    parentID?: string | null;
    sourceFrom?: number | null;
    sourceTo?: number | null;
    day?: string | null;
  },
): SummaryRow {
  const row: SummaryRow = {
    id: newID("sum"),
    conversation_id: input.conversationID,
    agent_id: input.agentID,
    level: input.level,
    parent_id: input.parentID ?? null,
    title: input.title,
    text: input.text,
    structured: input.structured === undefined ? null : JSON.stringify(input.structured),
    source_from: input.sourceFrom ?? null,
    source_to: input.sourceTo ?? null,
    day: input.day ?? null,
    created_at: nowISO(),
  };
  db.run(
    `INSERT INTO summaries (id, conversation_id, agent_id, level, parent_id, title, text, structured, source_from, source_to, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.conversation_id,
      row.agent_id,
      row.level,
      row.parent_id,
      row.title,
      row.text,
      row.structured,
      row.source_from,
      row.source_to,
      row.day,
      row.created_at,
    ],
  );
  return row;
}

export function listSummaries(
  db: Database,
  input: { conversationID?: string; agentID?: string; level?: SummaryLevel; limit?: number } = {},
): SummaryRow[] {
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 20)));
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (input.conversationID) {
    clauses.push("conversation_id = ?");
    values.push(input.conversationID);
  }
  if (input.agentID) {
    clauses.push("agent_id = ?");
    values.push(input.agentID);
  }
  if (input.level) {
    clauses.push("level = ?");
    values.push(input.level);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  values.push(limit);
  return db
    .query<SummaryRow, (string | number)[]>(
      `SELECT ${COLUMNS} FROM summaries ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...values);
}

/** The summaries of one day, oldest first — the material for a day summary. */
export function listBlockSummariesForDay(
  db: Database,
  input: { conversationID: string; day: string },
): SummaryRow[] {
  return db
    .query<SummaryRow, [string, string]>(
      `SELECT ${COLUMNS} FROM summaries
       WHERE conversation_id = ? AND day = ? AND level = 'block'
       ORDER BY created_at ASC`,
    )
    .all(input.conversationID, input.day);
}

/** The newest summary of a level for a conversation. */
export function latestSummary(
  db: Database,
  input: { conversationID: string; level: SummaryLevel },
): SummaryRow | null {
  return (
    db
      .query<SummaryRow, [string, string]>(
        `SELECT ${COLUMNS} FROM summaries
         WHERE conversation_id = ? AND level = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.conversationID, input.level) ?? null
  );
}

/** The UTC day a timestamp falls in. */
export function dayOf(timestamp: string): string {
  const at = Date.parse(timestamp);
  return new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 10);
}
