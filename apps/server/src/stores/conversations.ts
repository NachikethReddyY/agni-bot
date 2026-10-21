/**
 * The conversation model (see docs/protocol.md, "conversation model").
 *
 * A conversation is the user-facing chat with an agent — one per agent, never
 * reset, never swapped. A session block is a row of `threads` tied to it:
 * an invisible span of context that opens with the conversation's carried
 * summary and closes into it again (compaction happens in agent/rollover.ts).
 *
 * Pure SQLite here; the model calls that generate summaries live in
 * agent/rollover.ts so these helpers stay trivially testable.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { appendMessage, createThread, getThread, type ThreadRow } from "./threads";

export interface ConversationRow {
  id: string;
  agent_id: string;
  /** The live, unclosed block — the block a chat turn writes into. */
  active_thread_id: string | null;
  /** Bounded carried summary, seeded into each new block's context. */
  summary: string | null;
  /** ROL-005: the structured summary behind the text. */
  summary_json: string | null;
  /** The version of the summary that is current (a block's created_at). */
  summary_version: number;
  created_at: string;
  updated_at: string;
}

export type SessionCloseReason = "manual" | "context" | "background";

export interface SessionMessage {
  id: string;
  sessionID: string;
  role: string;
  text: string;
  created_at: string;
}

/** Get the agent's conversation, creating it (empty, blockless) if needed. */
export function ensureConversation(db: Database, agentID: string): ConversationRow {
  const existing = db
    .query<ConversationRow, [string]>(
      "SELECT id, agent_id, active_thread_id, summary, summary_json, summary_version, created_at, updated_at FROM conversations WHERE agent_id = ?",
    )
    .get(agentID);
  if (existing) return existing;
  const row: ConversationRow = {
    id: newID("cnv"),
    agent_id: agentID,
    active_thread_id: null,
    summary: null,
    summary_json: null,
    summary_version: 0,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  db.run("INSERT INTO conversations (id, agent_id, active_thread_id, summary, summary_json, summary_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    row.id,
    row.agent_id,
    row.active_thread_id,
    row.summary,
    row.summary_json,
    row.summary_version,
    row.created_at,
    row.updated_at,
  ]);
  return row;
}

export function getConversation(db: Database, id: string): ConversationRow | null {
  return (
    db
      .query<ConversationRow, [string]>(
        "SELECT id, agent_id, active_thread_id, summary, summary_json, summary_version, created_at, updated_at FROM conversations WHERE id = ?",
      )
      .get(id) ?? null
  );
}

export function conversationOfAgent(db: Database, agentID: string): ConversationRow | null {
  return (
    db
      .query<ConversationRow, [string]>(
        "SELECT id, agent_id, active_thread_id, summary, created_at, updated_at FROM conversations WHERE agent_id = ?",
      )
      .get(agentID) ?? null
  );
}

/**
 * The active session block. Resolves through active_thread_id and survives
 * every kind of process restart because SQLite, not memory, holds the seam.
 * Re-reads the conversation row: callers may pass snapshots from before an
 * earlier rotation on the same tick.
 */
export function activeSession(db: Database, conversation: ConversationRow | string): ThreadRow | null {
  const conv =
    typeof conversation === "string"
      ? getConversation(db, conversation)
      : (getConversation(db, conversation.id) ?? conversation);
  if (!conv?.active_thread_id) return null;
  const row = getThread(db, conv.active_thread_id);
  if (!row || row.closed_at !== null) return null;
  return row;
}

/**
 * Close the current block (if any) and continue in a fresh one. The fresh
 * block becomes the conversation's active block; `opened_carry` records the
 * summary it will render its first turns from.
 */
export function openSession(
  db: Database,
  conversation: ConversationRow,
  reason: SessionCloseReason,
  carry: string | null,
  tail: string[] = [],
): ThreadRow {
  const now = nowISO();
  return db.transaction(() => {
    if (conversation.active_thread_id) {
      db.run("UPDATE threads SET closed_at = ?, closed_by = ? WHERE id = ?", [now, reason, conversation.active_thread_id]);
    }
    const block = createThread(db, conversation.agent_id, undefined, { conversationID: conversation.id });
    db.run("UPDATE threads SET opened_carry = ?, opened_tail = ?, created_at = ? WHERE id = ?", [
      carry,
      tail.length > 0 ? tail.join("\n") : null,
      now,
      block.id,
    ]);
    db.run("UPDATE conversations SET active_thread_id = ?, updated_at = ? WHERE id = ?", [block.id, now, conversation.id]);
    conversation.active_thread_id = block.id;
    conversation.updated_at = now;
    return { ...block, opened_carry: carry, opened_tail: tail.length > 0 ? tail.join("\n") : null, created_at: now };
  })();
}

/**
 * A block for background work (routine results, the brief). It is born
 * closed: it shows up inside the conversation's transcript as its own block
 * but never steals the active chat, and never inherits or mutates the carry.
 */
export function backgroundSession(db: Database, conversation: ConversationRow, title?: string): ThreadRow {
  const now = nowISO();
  return db.transaction(() => {
    const block = createThread(db, conversation.agent_id, title, { conversationID: conversation.id });
    db.run("UPDATE threads SET closed_at = ?, closed_by = 'background' WHERE id = ?", [now, block.id]);
    db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, conversation.id]);
    conversation.updated_at = now;
    return { ...block, title: title ?? block.title, closed_at: now, closed_by: "background", created_at: now };
  })();
}

/**
 * A block for work an agent was asked to do by another agent.
 *
 * The work belongs to the agent that was asked: it lives in that agent's
 * conversation, so opening that agent's chat shows the work. When the agent
 * has no live block, this becomes the active one — that is the chat with
 * that agent. When it does, the work is a background block, so it never
 * steals a conversation the owner is in the middle of.
 */
export function delegationSession(db: Database, conversation: ConversationRow, title: string): ThreadRow {
  const now = nowISO();
  return db.transaction(() => {
    const active = conversation.active_thread_id ? getThread(db, conversation.active_thread_id) : null;
    if (!active || active.closed_at !== null) {
      const block = createThread(db, conversation.agent_id, title, { conversationID: conversation.id });
      db.run("UPDATE conversations SET active_thread_id = ?, updated_at = ? WHERE id = ?", [block.id, now, conversation.id]);
      conversation.active_thread_id = block.id;
      conversation.updated_at = now;
      return { ...block, created_at: now };
    }
    const block = createThread(db, conversation.agent_id, title, { conversationID: conversation.id });
    db.run("UPDATE threads SET closed_at = ?, closed_by = 'background' WHERE id = ?", [now, block.id]);
    db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, conversation.id]);
    conversation.updated_at = now;
    return { ...block, closed_at: now, closed_by: "background", created_at: now };
  })();
}

/** Store the refreshed carried summary. */
export function updateSummary(db: Database, conversationID: string, summary: string | null): void {
  db.run("UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?", [summary, nowISO(), conversationID]);
}

/**
 * Store the structured summary, but only if it is newer than what is
 * already there. Two rotations can land before the first summary does;
 * the newer one wins and the older one is ignored.
 */
export function updateSummaryIfNewer(
  db: Database,
  conversationID: string,
  input: { summary: string; structured: unknown; version: number },
): boolean {
  const result = db.run(
    "UPDATE conversations SET summary = ?, summary_json = ?, summary_version = ?, updated_at = ? WHERE id = ? AND summary_version < ?",
    [input.summary, JSON.stringify(input.structured), input.version, nowISO(), conversationID, input.version],
  );
  return result.changes > 0;
}

/** The structured summary, if there is one. */
export function getStructuredSummary(db: Database, conversationID: string): unknown | null {
  const raw = db
    .query<{ summary_json: string | null }, [string]>("SELECT summary_json FROM conversations WHERE id = ?")
    .get(conversationID)?.summary_json;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Message count pressure heuristic: chars across the block (fast, indexed). */
export function sessionCharLoad(db: Database, threadID: string): number {
  return (
    db
      .query<{ total: number | null }, [string]>("SELECT total(length(text)) AS total FROM messages WHERE thread_id = ?")
      .get(threadID)?.total ?? 0
  );
}

/**
 * The transcript across blocks of one conversation, oldest first, bounded by
 * `limit` like thread history. role filters to what a transcript renders.
 */
export function conversationTranscript(
  db: Database,
  conversationID: string,
  limit = 200,
): SessionMessage[] {
  const rows = db
    .query<SessionMessage, [string, number]>(
      `SELECT m.id, m.thread_id AS sessionID, m.role, m.text, m.created_at
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE t.conversation_id = ?
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
    )
    .all(conversationID, limit);
  return rows.reverse();
}

/** Append a system note into a conversation (used by tests and the shell). */
export function noteConversation(db: Database, conversation: ConversationRow, text: string): void {
  const threadID = conversation.active_thread_id;
  if (!threadID) return;
  appendMessage(db, { threadID, role: "system", text });
}
