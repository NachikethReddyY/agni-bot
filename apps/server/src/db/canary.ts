/**
 * Canary scan — the leak detector for EVAL-004.
 *
 * A private agent's text must never reach a place the caller can read. The
 * owner-facing workspace of that agent is exempt: the owner opens the
 * agent's DM directly, and the agent keeps its own context. Everything else
 * is a sink.
 *
 * The exemption is per agent, not per table. A canary in the private
 * agent's own thread, DM, or carried summary is where it belongs; the same
 * canary in the caller's thread, in a global fact, in the caller's channel,
 * or in the log is a leak.
 *
 * The same scanner runs in the test suite and as `bun run scan:canary`.
 */
import type { Database } from "bun:sqlite";

export interface CanaryHit {
  sink: string;
  rowID: string;
  column: string;
  canary: string;
}

export interface CanaryScanOptions {
  /**
   * Agent ids whose own workspace may hold the canary. Their threads, DMs,
   * conversations and agent-scoped facts are skipped; global rows are not
   * exempt, because a global fact is readable by everyone.
   */
  exemptAgentIDs?: string[];
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row);
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function needles(canaries: string[]): string[] {
  return canaries.map((c) => c.trim()).filter(Boolean);
}

function scanRows(
  rows: Array<Record<string, string>>,
  idColumn: string,
  columns: string[],
  canaries: string[],
  sink: string,
  skip: (row: Record<string, string>) => boolean,
): CanaryHit[] {
  const hits: CanaryHit[] = [];
  for (const row of rows) {
    if (skip(row)) continue;
    for (const column of columns) {
      const value = row[column] ?? "";
      for (const canary of canaries) {
        if (value.includes(canary)) {
          hits.push({ sink, rowID: String(row[idColumn] ?? ""), column, canary });
        }
      }
    }
  }
  return hits;
}

/**
 * Scan the model-visible sinks. A row is a hit when it holds a canary and
 * it is not in an exempt agent's own workspace.
 */
export function scanDatabaseForCanaries(
  db: Database,
  canaries: string[],
  options: CanaryScanOptions = {},
): CanaryHit[] {
  const list = needles(canaries);
  if (list.length === 0) return [];
  const exempt = new Set(options.exemptAgentIDs ?? []);
  const hits: CanaryHit[] = [];

  // The model-visible transcript: every thread except the exempt agents'.
  if (tableExists(db, "messages") && tableExists(db, "threads")) {
    const rows = db
      .query<Record<string, string>, []>(
        `SELECT m.id AS id, m.text AS text, t.agent_id AS owner FROM messages m
         LEFT JOIN threads t ON t.id = m.thread_id`,
      )
      .all();
    hits.push(
      ...scanRows(rows, "id", ["text"], list, "messages", (row) => exempt.has(row.owner ?? "")),
    );
  }

  // The user-facing channels, except the exempt agents' own DMs.
  if (tableExists(db, "channel_messages") && tableExists(db, "channels")) {
    const rows = db
      .query<Record<string, string>, []>(
        `SELECT cm.id AS id, cm.text AS text, c.agent_id AS owner FROM channel_messages cm
         LEFT JOIN channels c ON c.id = cm.channel_id`,
      )
      .all();
    hits.push(
      ...scanRows(rows, "id", ["text"], list, "channel_messages", (row) => exempt.has(row.owner ?? "")),
    );
  }

  // Durable facts. A global row (no owner) is never exempt: everyone can
  // read it.
  if (tableExists(db, "agent_memories")) {
    const rows = db
      .query<Record<string, string>, []>(
        "SELECT id, COALESCE(content, '') AS content, COALESCE(tags, '') AS tags, COALESCE(key_slug, '') AS key_slug, COALESCE(agent_id, '') AS owner FROM agent_memories",
      )
      .all();
    hits.push(
      ...scanRows(rows, "id", ["content", "tags", "key_slug"], list, "agent_memories", (row) =>
        exempt.has(row.owner ?? ""),
      ),
    );
  }

  // Carried summaries and thread titles, except the exempt agents'.
  if (tableExists(db, "conversations")) {
    const rows = db
      .query<Record<string, string>, []>(
        "SELECT id, COALESCE(summary, '') AS summary, COALESCE(agent_id, '') AS owner FROM conversations",
      )
      .all();
    hits.push(
      ...scanRows(rows, "id", ["summary"], list, "conversations", (row) => exempt.has(row.owner ?? "")),
    );
  }
  if (tableExists(db, "threads")) {
    const rows = db
      .query<Record<string, string>, []>(
        "SELECT id, COALESCE(title, '') AS title, COALESCE(agent_id, '') AS owner FROM threads",
      )
      .all();
    hits.push(...scanRows(rows, "id", ["title"], list, "threads", (row) => exempt.has(row.owner ?? "")));
  }

  return hits;
}

/** Scan a log file for the canary strings. A log line is never exempt. */
export function scanTextForCanaries(text: string, canaries: string[], sink = "log"): CanaryHit[] {
  const hits: CanaryHit[] = [];
  for (const canary of needles(canaries)) {
    let index = text.indexOf(canary);
    while (index !== -1) {
      hits.push({ sink, rowID: `offset:${index}`, column: "line", canary });
      index = text.indexOf(canary, index + canary.length);
    }
  }
  return hits;
}

/** Scan a database and an optional log file in one call. */
export function scanForCanaries(
  db: Database,
  canaries: string[],
  options: CanaryScanOptions & { logText?: string } = {},
): CanaryHit[] {
  const hits = scanDatabaseForCanaries(db, canaries, options);
  if (options.logText) hits.push(...scanTextForCanaries(options.logText, canaries));
  return hits;
}
