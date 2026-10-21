/**
 * Transcript search (MEM-003).
 *
 * The channel messages are the durable transcript: what was said, in which
 * conversation. FTS5 finds them; the caller's visibility decides which
 * channels it may see — a private agent's conversation is not searchable by
 * anyone else.
 */
import type { Database } from "bun:sqlite";
import { toMatchQuery } from "./agent-memories";

export interface TranscriptHit {
  id: string;
  channelID: string;
  /** The agent that owns the channel. */
  agentID: string | null;
  fromType: string;
  fromID: string;
  text: string;
  createdAt: string;
  /** 0..1 — higher is a better match. */
  score: number;
}

export function searchTranscripts(
  db: Database,
  input: {
    query: string;
    /** The agent asking. A private agent's channel is not searchable for it. */
    callerAgentID?: string | null;
    limit?: number;
  },
): TranscriptHit[] {
  const query = input.query.trim();
  if (!query) return [];
  const caller = input.callerAgentID ?? null;
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));
  // Precision first, then recall: a paraphrase still finds the message.
  for (const mode of ["and", "or"] as const) {
    const params: (string | number)[] = [toMatchQuery(query, mode), caller ?? "", limit];
    let rows: Array<{
      id: string;
      channel_id: string;
      agent_id: string | null;
      from_type: string;
      from_id: string;
      text: string;
      created_at: string;
      rank: number;
    }>;
    try {
      rows = db
        .query<
          {
            id: string;
            channel_id: string;
            agent_id: string | null;
            from_type: string;
            from_id: string;
            text: string;
            created_at: string;
            rank: number;
          },
          (string | number)[]
        >(
          `SELECT cm.id AS id, cm.channel_id AS channel_id, c.agent_id AS agent_id,
                  cm.from_type AS from_type, cm.from_id AS from_id, cm.text AS text,
                  cm.created_at AS created_at, bm25(channel_messages_fts) AS rank
           FROM channel_messages_fts
           JOIN channel_messages cm ON cm.rowid = channel_messages_fts.rowid
           LEFT JOIN channels c ON c.id = cm.channel_id
           LEFT JOIN agents a ON a.id = c.agent_id
           WHERE channel_messages_fts MATCH ?
             AND (a.visibility IS NULL OR a.visibility <> 'private' OR c.agent_id = ?)
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(...params);
    } catch {
      return [];
    }
    if (rows.length === 0) continue;
    return rows.map((row) => ({
      id: row.id,
      channelID: row.channel_id,
      agentID: row.agent_id,
      fromType: row.from_type,
      fromID: row.from_id,
      text: row.text,
      createdAt: row.created_at,
      score: Number((1 / (1 + Math.max(0, row.rank))).toFixed(4)),
    }));
  }
  return [];
}
