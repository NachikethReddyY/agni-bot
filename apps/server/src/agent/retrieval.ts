/**
 * Retrieval — the path a turn takes to find what it needs (ASM-003..006).
 *
 * Three things live here:
 *
 *   - the **rewrite**: a message that is not self-contained ("explain this")
 *     is turned into a query using the anchor and the last turns. The
 *     user's own words are never changed — only the query is.
 *   - the **hybrid search**: FTS and vectors fused, with the confidence
 *     floor applied. Below the floor, nothing is injected.
 *   - the **fallback**: when the search finds nothing good enough, the tail
 *     of the previous block is used instead of a broader, worse search.
 */
import type { Database } from "bun:sqlite";
import {
  fuseHits,
  markMemoryUsed,
  searchAgentMemories,
  searchMemoriesByVector,
  type MemoryHit,
} from "../stores/agent-memories";
import { embedText, type EmbedderConfig } from "./embeddings";
import type { Anchor } from "../context/compiler";

/** The confidence floor for automatic retrieval (TUNABLE). */
export const DEFAULT_MIN_SCORE = 0.15;

/**
 * ASM-003: rewrite a message that refers to earlier context.
 *
 * "explain this" means nothing to a search index. The anchor says what the
 * topic is, and the last turns say what was just discussed, so the query
 * becomes concrete. A message that stands on its own is left alone.
 */
export function rewriteForRetrieval(
  text: string,
  context: { anchor?: Anchor | null; history?: Array<{ role: string; content: string }> } = {},
): { query: string; rewritten: boolean } {
  const original = text.trim();
  const history = context.history ?? [];
  const anchor = context.anchor ?? null;
  // A message that names its own subject needs no rewrite. A short message
  // that points back ("explain this") does.
  const refersBack = /\b(this|that|it|they|those|these|the same|again|earlier|before|above|option \d)\b/i.test(original);
  if (!refersBack || original.length > 40) return { query: original, rewritten: false };
  const parts: string[] = [];
  if (anchor?.topic) parts.push(anchor.topic);
  if (anchor?.entities.length) parts.push(anchor.entities.join(" "));
  const lastUser = [...history].reverse().find((message) => message.role === "user" && message.content.trim());
  if (lastUser) parts.push(lastUser.content.trim().slice(0, 200));
  const context_ = parts.join(" ").trim();
  if (!context_) return { query: original, rewritten: false };
  return { query: `${context_} ${original}`.trim(), rewritten: true };
}

export interface RetrieveOptions {
  query: string;
  scope?: string;
  agentID?: string | null;
  callerAgentID?: string | null;
  limit?: number;
  /** Below this score, nothing is injected. */
  minScore?: number;
  /** The local embedder, when one is configured. */
  embedder?: EmbedderConfig | null;
  fetchFn?: typeof fetch;
}

export interface RetrieveResult {
  hits: MemoryHit[];
  /** True when the best match was under the floor and nothing was returned. */
  belowThreshold: boolean;
  /** True when the vector half was used. */
  usedVectors: boolean;
}

/**
 * The hybrid search. The vector half is optional: without an embedder (or
 * with one that is down) this is FTS alone, which is a smaller result, not
 * a failure.
 */
export async function retrieveFacts(
  db: Database,
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  const limit = options.limit ?? 8;
  const floor = options.minScore ?? DEFAULT_MIN_SCORE;
  const textHits = searchAgentMemories(db, {
    query: options.query,
    scope: options.scope,
    agentID: options.agentID,
    callerAgentID: options.callerAgentID,
    limit,
  });

  // The text search first: it is local, it is fast, and it is usually
  // enough. The embedder is the *lift* for the cases the text search
  // cannot serve — a paraphrase, or a question with no matching words —
  // not a tax on every turn.
  const textIsGood = textHits.length > 0 && textHits[0]!.score >= floor;
  if (textIsGood || !options.embedder) {
    const kept = textHits.filter((hit) => hit.score >= floor);
    if (kept.length === 0 && textHits.length > 0) return { hits: [], belowThreshold: true, usedVectors: false };
    markMemoryUsed(db, kept.map((hit) => hit.row.id));
    return { hits: kept.slice(0, limit), belowThreshold: false, usedVectors: false };
  }

  const vector = await embedText(options.query, options.embedder, options.fetchFn);
  if (!vector) {
    // The embedder is down: FTS alone is a smaller result, not a failure.
    const kept = textHits.filter((hit) => hit.score >= floor);
    if (kept.length === 0 && textHits.length > 0) return { hits: [], belowThreshold: true, usedVectors: false };
    markMemoryUsed(db, kept.map((hit) => hit.row.id));
    return { hits: kept.slice(0, limit), belowThreshold: false, usedVectors: false };
  }
  const vectorHits = searchMemoriesByVector(db, {
    vector,
    scope: options.scope,
    agentID: options.agentID,
    callerAgentID: options.callerAgentID,
    limit,
  });
  const fused = fuseHits(textHits, vectorHits);
  const kept = fused.filter((hit) => hit.score >= floor);
  if (kept.length === 0) return { hits: [], belowThreshold: fused.length > 0, usedVectors: true };
  // A recall moves the ranking inputs.
  markMemoryUsed(db, kept.map((hit) => hit.row.id));
  return { hits: kept.slice(0, limit), belowThreshold: false, usedVectors: true };
}

/**
 * ASM-006: the fallback when the search is not good enough — the tail of
 * the previous block. It is the context the user just had, so it is a
 * better guess than a wider search.
 */
export function previousBlockTail(
  db: Database,
  input: { conversationID: string | null; threadID: string; limit?: number },
): string[] {
  if (!input.conversationID) return [];
  const limit = Math.min(12, Math.max(1, Math.floor(input.limit ?? 6)));
  const rows = db
    .query<{ text: string; role: string }, [string, string, number]>(
      `SELECT m.text AS text, m.role AS role
       FROM messages m
       JOIN threads t ON t.id = m.thread_id
       WHERE t.conversation_id = ? AND t.id <> ? AND t.closed_at IS NOT NULL
       ORDER BY m.created_at DESC, m.rowid DESC
       LIMIT ?`,
    )
    .all(input.conversationID, input.threadID, limit);
  return rows.reverse().map((row) => `${row.role}: ${row.text}`);
}
