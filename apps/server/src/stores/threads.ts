import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface ThreadRow {
  id: string;
  agent_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  /** Conversation model (migration 7): the block's conversation, when assigned. */
  conversation_id: string | null;
  closed_at: string | null;
  /** manual (/new) | context (rollover at pressure) | background (job turn). */
  closed_by: string | null;
  /** The carried summary this block opened with (debuggability only). */
  opened_carry: string | null;
  /**
   * The last turns of the block before this one, verbatim (ROL-006). The
   * new block opens with them, so the boundary does not lose the stretch
   * of conversation that the summary has not caught up with.
   */
  opened_tail: string | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: string;
  text: string;
  created_at: string;
}

export interface ThreadListRow extends ThreadRow {
  preview: string | null;
}

export function createThread(
  db: Database,
  agentID: string,
  title?: string,
  options?: { conversationID?: string | null },
): ThreadRow {
  const row: ThreadRow = {
    id: newID("thr"),
    agent_id: agentID,
    title: title ?? null,
    created_at: nowISO(),
    updated_at: nowISO(),
    conversation_id: options?.conversationID ?? null,
    closed_at: null,
    closed_by: null,
    opened_carry: null,
    opened_tail: null,
  };
  db.run(
    "INSERT INTO threads (id, agent_id, title, created_at, updated_at, conversation_id, closed_at, closed_by, opened_carry, opened_tail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.agent_id,
      row.title,
      row.created_at,
      row.updated_at,
      row.conversation_id,
      row.closed_at,
      row.closed_by,
      row.opened_carry,
      row.opened_tail,
    ],
  );
  return row;
}

export function getThread(db: Database, id: string): ThreadRow | null {
  return (
    db
      .query<ThreadRow, [string]>(
        `SELECT id, agent_id, title, created_at, updated_at, conversation_id, closed_at, closed_by, opened_carry, opened_tail
         FROM threads WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

/** Most recently touched threads — the chat client's `/threads` list. */
export function listThreads(db: Database, limit = 20): ThreadRow[] {
  return db
    .query<ThreadRow, [number]>(
      `SELECT id, agent_id, title, created_at, updated_at, conversation_id, closed_at, closed_by, opened_carry
       FROM threads ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit);
}

/** Thread list and latest message in one indexed query (avoids per-thread reads). */
export function listThreadsWithPreview(db: Database, limit = 20): ThreadListRow[] {
  const rows = db
    .query<ThreadRow & { preview_text: string | null }, [number]>(
      `SELECT t.id, t.agent_id, t.title, t.created_at, t.updated_at,
              t.conversation_id, t.closed_at, t.closed_by, t.opened_carry, t.opened_tail,
              (SELECT m.text FROM messages m WHERE m.thread_id = t.id
               ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview_text
       FROM threads t ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map((row) => ({ ...row, preview: messagePreview(row.preview_text) }));
}

export function touchThread(db: Database, id: string): void {
  db.run("UPDATE threads SET updated_at = ? WHERE id = ?", [nowISO(), id]);
}

/** Set the thread title from the first user message if it has none yet. */
export function titleThreadFromFirstMessage(db: Database, threadID: string, text: string): void {
  const title = text.trim().replace(/\s+/g, " ").slice(0, 60);
  db.run("UPDATE threads SET title = ?, updated_at = ? WHERE id = ? AND (title IS NULL OR title = '')", [
    title,
    nowISO(),
    threadID,
  ]);
}

export function createTurn(db: Database, params: { id: string; threadID: string; agentID: string }): void {
  db.run("INSERT INTO turns (id, thread_id, agent_id, state, started_at) VALUES (?, ?, ?, 'running', ?)", [
    params.id,
    params.threadID,
    params.agentID,
    nowISO(),
  ]);
}

export function finishTurn(
  db: Database,
  params: {
    id: string;
    stopReason: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
  },
): void {
  db.run(
    `UPDATE turns
     SET state = 'done', stop_reason = ?, provider = ?, model = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?, ended_at = ?
     WHERE id = ?`,
    [
      params.stopReason,
      params.provider ?? null,
      params.model ?? null,
      params.inputTokens ?? null,
      params.outputTokens ?? null,
      params.latencyMs ?? null,
      nowISO(),
      params.id,
    ],
  );
}

export function appendMessage(
  db: Database,
  params: { threadID: string; turnID?: string; role: string; text: string },
): MessageRow {
  const row: MessageRow = {
    id: newID("msg"),
    thread_id: params.threadID,
    turn_id: params.turnID ?? null,
    role: params.role,
    text: params.text,
    created_at: nowISO(),
  };
  db.run("INSERT INTO messages (id, thread_id, turn_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    row.id,
    row.thread_id,
    row.turn_id,
    row.role,
    row.text,
    row.created_at,
  ]);
  return row;
}

/** Last `limit` messages in chronological order — the bounded prompt (S1). */
export function recentMessages(db: Database, threadID: string, limit: number): MessageRow[] {
  const rows = db
    .query<MessageRow, [string, number]>(
      `SELECT id, thread_id, turn_id, role, text, created_at
       FROM messages WHERE thread_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(threadID, limit);
  return rows.reverse();
}

/** One line of the newest message, for the client's thread list. */
export function lastMessagePreview(db: Database, threadID: string): string | null {
  const row = db
    .query<{ text: string }, [string]>(
      `SELECT text FROM messages WHERE thread_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadID);
  return messagePreview(row?.text ?? null);
}

function messagePreview(text: string | null): string | null {
  if (text === null) return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}
