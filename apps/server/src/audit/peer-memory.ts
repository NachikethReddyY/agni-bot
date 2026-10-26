import type { Database } from "bun:sqlite";

export interface PeerMemoryAuditResult {
  totalMemories: number;
  candidateMemories: number;
  candidatesBySource: Record<string, number>;
  unlinkedCompaction: number;
  checkedAt: string;
}

interface MemoryAuditRow {
  id: string;
  source: string;
  agent_id: string | null;
  source_block_id: string | null;
  source_turn_ids: string | null;
}

function parseTurnIds(raw: string | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Fall through to the comma-separated form used by the store.
    }
  }
  return trimmed.split(/[\s,]+/).filter((value) => value.length > 0);
}

function isPeerContent(text: string): boolean {
  return (
    text.startsWith("Goal: ") ||
    text.includes(" messaged you: ") ||
    text.startsWith("A delegated task finished")
  );
}

function turnThreadId(db: Database, turnId: string): string | null {
  const row = db
    .query<{ thread_id: string }, [string]>("SELECT thread_id FROM turns WHERE id = ?")
    .get(turnId);
  return row?.thread_id ?? null;
}

function unlinkedPeerSystemInThread(db: Database, threadId: string): boolean {
  // Legacy/container-adjacent messages that are not explicitly linked to a turn
  // (turn_id IS NULL) but carry peer content. Count by text, not container.
  const rows = db
    .query<{ text: string }, [string]>(
      "SELECT text FROM messages WHERE thread_id = ? AND turn_id IS NULL AND role = 'system'",
    )
    .all(threadId);
  return rows.some((row) => isPeerContent(row.text));
}

function turnHasPeerSystemMessage(db: Database, turnId: string): boolean {
  // Messages explicitly linked to this turn.
  const direct = db
    .query<{ text: string }, [string]>(
      "SELECT text FROM messages WHERE turn_id = ? AND role = 'system'",
    )
    .all(turnId);
  if (direct.some((row) => isPeerContent(row.text))) return true;

  // Legacy messages in the turn's thread that are not linked to any turn.
  const threadId = turnThreadId(db, turnId);
  if (threadId && unlinkedPeerSystemInThread(db, threadId)) return true;

  return false;
}

function messageIsPeerSystem(db: Database, messageId: string): boolean {
  const row = db
    .query<{ role: string; text: string; thread_id: string }, [string]>(
      "SELECT role, text, thread_id FROM messages WHERE id = ?",
    )
    .get(messageId);
  if (!row) return false;
  if (row.role === "system" && isPeerContent(row.text)) return true;
  // Legacy unlinked peer system message in the same thread.
  return unlinkedPeerSystemInThread(db, row.thread_id);
}

function sourceIdHasPeerSystemMessage(db: Database, id: string): boolean {
  // Turn id.
  const threadId = turnThreadId(db, id);
  if (threadId !== null) {
    // Distinguish a real turn (threadId found) from a missing one.
    return turnHasPeerSystemMessage(db, id);
  }

  // Message id.
  const messageRow = db
    .query<{ id: string }, [string]>("SELECT id FROM messages WHERE id = ?")
    .get(id);
  if (messageRow) {
    return messageIsPeerSystem(db, id);
  }

  // channel_messages are never candidates (handoff notices excluded).
  return false;
}

export function auditPeerMemory(db: Database): PeerMemoryAuditResult {
  const totalMemories =
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM agent_memories WHERE archived_at IS NULL",
      )
      .get()?.count ?? 0;

  const memories = db
    .query<MemoryAuditRow, []>(
      "SELECT id, source, agent_id, source_block_id, source_turn_ids FROM agent_memories WHERE archived_at IS NULL",
    )
    .all();

  let candidateMemories = 0;
  const candidatesBySource: Record<string, number> = {};
  let unlinkedCompaction = 0;

  for (const memory of memories) {
    const sourceIds = parseTurnIds(memory.source_turn_ids);

    let isCandidate = false;
    for (const sourceId of sourceIds) {
      if (sourceIdHasPeerSystemMessage(db, sourceId)) {
        isCandidate = true;
        break;
      }
    }

    if (!isCandidate && memory.source === "compaction" && sourceIds.length === 0) {
      unlinkedCompaction += 1;
    }

    if (isCandidate) {
      candidateMemories += 1;
      const source = memory.source || "unknown";
      candidatesBySource[source] = (candidatesBySource[source] ?? 0) + 1;
    }
  }

  return {
    totalMemories,
    candidateMemories,
    candidatesBySource,
    unlinkedCompaction,
    checkedAt: new Date().toISOString(),
  };
}
