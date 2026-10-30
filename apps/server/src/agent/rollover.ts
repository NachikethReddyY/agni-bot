/**
 * Session-block rollover — the boundary between what is in context and what
 * is not (ROL-001..006).
 *
 * The rule that shapes everything here: **a turn never waits for a
 * summary.** When a block fills up, the block is closed and a new one
 * opens immediately, carrying the previous summary and the last few turns
 * of the old block. The summary of the closed block is written afterwards,
 * in the background. The next turn is served from the old carry plus the
 * tail until the new summary lands, and then the new summary takes over.
 *
 * That is why the sweep (the tagger pass over the whole block) lives in
 * the background job and not in front of the rotation: a pre-close sweep
 * would put a model call on the path of the user's next turn.
 */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { Router, RouterError } from "../models/router";
import { recentMessages, type ThreadRow } from "../stores/threads";
import {
  activeSession,
  ensureConversation,
  getConversation,
  openSession,
  sessionCharLoad,
  updateSummary,
  type ConversationRow,
  type SessionCloseReason,
} from "../stores/conversations";
import { log } from "../log";
import { enqueueJob } from "../stores/jobs";
import type { RolloverJobPayload } from "../jobs/rollover";

/**
 * A block crossing this many chars of accumulated message text rolls over
 * before the next turn (~8k tokens of prose).
 */
export const SESSION_ROLLOVER_CHARS = 32_000;

/**
 * ROL-003: the trigger is 65% of the budget, not the budget itself. A
 * block that is never waited until is a block that never has to be
 * recovered from.
 */
export const ROLLOVER_TRIGGER_CHARS = Math.floor(SESSION_ROLLOVER_CHARS * 0.65);

/**
 * The hysteresis: a block only rotates again once it is well past the
 * trigger, or once it has enough turns to be worth a block of its own.
 * Without this, a block hovering near the threshold thrashes.
 */
export const ROLLOVER_HYSTERESIS_CHARS = Math.floor(SESSION_ROLLOVER_CHARS * 0.85);
export const ROLLOVER_MIN_TURNS = 3;

/** How long a block may sit idle before a topic shift is a new block. */
export const ROLLOVER_IDLE_MS = 30 * 60_000;

/** Hard cap on the carried summary the next block opens with. */
export const CARRY_SUMMARY_CHARS = 900;

/** How many turns of the old block the new one opens with (ROL-006). */
export const OPENED_TAIL_TURNS = 6;

/**
 * ROL-005: the structured summary. The model has to answer with this
 * shape, and the text version is rendered from it.
 */
export const StructuredSummarySchema = z.object({
  decisions: z.array(z.string().max(400)).max(20).default([]),
  open_loops: z.array(z.string().max(400)).max(20).default([]),
  entities: z.array(z.string().max(120)).max(30).default([]),
  tone: z.string().max(200).default(""),
  source_turn_range: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).nullable().default(null),
});
export type StructuredSummary = z.infer<typeof StructuredSummarySchema>;

const SUMMARY_SYSTEM_PROMPT = [
  "You compress a chat session for continuity. Answer with strict JSON:",
  '{"decisions":[],"open_loops":[],"entities":[],"tone":"","source_turn_range":{"from":0,"to":0}}',
  "decisions: what was decided. open_loops: what is still owed. entities: people, projects, files.",
  "tone: one short phrase. source_turn_range: the turn numbers you were given.",
  "Nothing else — no preamble, no prose outside the JSON.",
].join(" ");

export interface RolloverResult {
  /** The block the next turn writes into. */
  threadID: string;
  /** The carried summary this block opened with. */
  carry: string | null;
  /** Whether a block boundary actually happened (rollover or fresh block). */
  rolledOver: boolean;
  conversationID: string;
  /** What caused the boundary: one of the session reasons, or "none". */
  reason: SessionCloseReason | "none";
  /** The tail of the previous block, seeded into this one. */
  tail: string[];
}

export interface RolloverDeps {
  db: Database;
  router: Router;
  firstTokenTimeoutMs: number;
}

/**
 * Make sure the conversation has a writable block the next turn can use.
 *
 * Nothing here waits for a model: the block is closed and reopened, the
 * previous summary and the tail of the old block ride forward, and the
 * summary of the closed block is written by a background job.
 */
export async function rolloverIfNeeded(
  deps: RolloverDeps,
  conversation: ConversationRow,
  options: { text?: string } = {},
): Promise<RolloverResult> {
  const active = activeSession(deps.db, conversation);
  if (!active) {
    // No live block: open one. There is nothing to close and nothing to
    // summarize — the first block of a conversation has nothing to carry.
    const block = openSession(deps.db, conversation, "manual", getConversation(deps.db, conversation.id)?.summary ?? null);
    return {
      threadID: block.id,
      carry: block.opened_carry,
      rolledOver: true,
      conversationID: conversation.id,
      reason: "manual",
      tail: [],
    };
  }
  const load = sessionCharLoad(deps.db, active.id);
  if (!shouldRotate(deps.db, active, load, { text: options.text })) {
    return {
      threadID: active.id,
      carry: getConversation(deps.db, conversation.id)?.summary ?? null,
      rolledOver: false,
      conversationID: conversation.id,
      reason: "none",
      tail: [],
    };
  }
  return rotateNow(deps, conversation, "context");
}

/**
 * Close the block and open the next one — now, without a model call.
 *
 * The tail of the closed block (its last turns, verbatim) is seeded into
 * the new block, so the boundary does not lose the stretch of
 * conversation the summary has not caught up with.
 */
export function rotateNow(
  deps: RolloverDeps,
  conversation: ConversationRow,
  reason: SessionCloseReason,
): RolloverResult {
  const { db } = deps;
  const active = activeSession(db, conversation);
  const tail = active ? tailOf(db, active.id) : [];
  const carry = getConversation(db, conversation.id)?.summary ?? null;
  const block = openSession(db, conversation, reason, carry, tail);
  if (active) {
    // The summary of the closed block is written afterwards, in the
    // background: the next turn must not wait for a model call.
    enqueueJob(db, {
      kind: "rollover.summarize",
      payload: {
        threadID: active.id,
        conversationID: conversation.id,
        version: Date.parse(active.created_at) || Date.now(),
      } satisfies RolloverJobPayload,
    });
  }
  log.info(
    `session block rotated conversation=${conversation.id} reason=${reason} closed=${active ? active.id : "-"} opened=${block.id}`,
  );
  return {
    threadID: block.id,
    carry,
    rolledOver: true,
    conversationID: conversation.id,
    reason,
    tail,
  };
}

/**
 * The trigger (ROL-003): pressure, or an idle gap with a topic shift.
 * The hysteresis keeps a block that hovers near the threshold from
 * rotating over and over.
 */
export function shouldRotate(
  db: Database,
  block: ThreadRow,
  load: number,
  options: { text?: string; now?: number } = {},
): boolean {
  const turns = db
    .query<{ count: number }, [string]>("SELECT count(*) AS count FROM messages WHERE thread_id = ?")
    .get(block.id)?.count ?? 0;
  if (load >= ROLLOVER_HYSTERESIS_CHARS) return true;
  if (load >= ROLLOVER_TRIGGER_CHARS) {
    // Near the trigger: only rotate if the block has earned it.
    if (turns >= ROLLOVER_MIN_TURNS) return true;
  } else if (options.text) {
    // ROL-003: an idle gap plus a topic shift is a new block, even when the
    // old one is not full. The conversation moved on.
    const now = options.now ?? Date.now();
    const last = db
      .query<{ created_at: string }, [string]>(
        "SELECT created_at FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(block.id);
    const lastAt = last ? Date.parse(last.created_at) : NaN;
    if (Number.isFinite(lastAt) && now - lastAt >= ROLLOVER_IDLE_MS && topicShifted(db, block, options.text)) {
      return true;
    }
  }
  return false;
}

/** Words worth comparing: longer than three letters, not the usual noise. */
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "our", "was", "are", "have", "has",
  "but", "not", "can", "will", "would", "could", "should", "from", "what", "when", "where", "which",
  "who", "why", "how", "about", "into", "them", "then", "than", "there", "here", "just", "like",
  "some", "more", "very", "also", "any", "all", "get", "got", "did", "does", "done", "make",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
  );
}

/**
 * A topic shift: the new message shares no significant word with the
 * block. Crude on purpose — a false positive costs one summary, a false
 * negative costs a muddled block.
 */
export function topicShifted(db: Database, block: ThreadRow, text: string): boolean {
  const words = significantWords(text);
  if (words.size === 0) return false;
  const messages = recentMessages(db, block.id, 12);
  const blockWords = significantWords(messages.map((message) => message.text).join(" "));
  for (const word of words) {
    if (blockWords.has(word)) return false;
  }
  return true;
}

/**
 * The last turns of a block, verbatim. The new block opens with them.
 */
export function tailOf(db: Database, threadID: string, limit = OPENED_TAIL_TURNS): string[] {
  const messages = recentMessages(db, threadID, limit);
  return messages.map((message) => `${message.role}: ${message.text}`);
}

/**
 * Rotate on demand: summarize the active block, close it, open a fresh one.
 * Used by the manual `/new` seam, where the owner asked for the boundary
 * and can afford the wait.
 */
export async function rotate(deps: RolloverDeps, agentOrConversation: string | ConversationRow, reason: SessionCloseReason): Promise<RolloverResult> {
  const { db } = deps;
  const conversation =
    typeof agentOrConversation === "string"
      ? ensureConversation(db, agentOrConversation)
      : (getConversation(db, agentOrConversation.id) ?? agentOrConversation);
  const active = activeSession(db, conversation);
  if (active) {
    // The owner asked for this boundary, so the summary is worth the wait.
    const summary = await summarizeBlock(deps, conversation, active);
    if (summary) updateSummary(db, conversation.id, summary.text);
  }
  return rotateNow(deps, conversation, reason);
}

/**
 * Summarize a block into the structured shape, and render the text version.
 * A failure carries the previous summary forward: a missing summary must
 * never block a turn.
 */
export async function summarizeBlock(
  deps: RolloverDeps,
  conversation: ConversationRow,
  block: ThreadRow,
): Promise<{ text: string; structured: StructuredSummary } | null> {
  const { db } = deps;
  const previous = conversation.summary ?? "";
  const messages = recentMessages(db, block.id, 40);
  if (messages.length === 0) return null;
  const transcript = messages
    .map((message, index) => `${index}: ${message.role}: ${message.text}`)
    .join("\n")
    .slice(-12_000); // keep the newest turns; the oldest are what the carry already covers
  try {
    const result = await deps.router.route({
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: [previous ? `Running summary so far:\n${previous}` : null, `Session to fold in:\n${transcript}`]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
      signal: AbortSignal.timeout(20_000),
      firstTokenTimeoutMs: deps.firstTokenTimeoutMs,
      onDelta: () => {},
      toolChoice: "none",
      maxTokens: 600,
    });
    const structured = parseStructuredSummary(result.text);
    // A model that answers in prose still gets a summary: the structured
    // shape is preferred, the text is the fallback.
    const rendered = renderSummary(structured);
    const text = clampCarry(rendered || result.text);
    if (!text) throw new RouterError("provider_failed", "empty summary");
    return { text, structured };
  } catch (error) {
    log.warn(`carry summary failed; previous summary rides forward: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Parse the model's answer into the structured shape. */
export function parseStructuredSummary(text: string): StructuredSummary {
  const fallback: StructuredSummary = {
    decisions: [],
    open_loops: [],
    entities: [],
    tone: "",
    source_turn_range: null,
  };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return fallback;
  try {
    const parsed = StructuredSummarySchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

/** The text version of a structured summary — what the prompt carries. */
export function renderSummary(summary: StructuredSummary): string {
  const parts: string[] = [];
  if (summary.decisions.length > 0) parts.push(`Decided: ${summary.decisions.join("; ")}`);
  if (summary.open_loops.length > 0) parts.push(`Still open: ${summary.open_loops.join("; ")}`);
  if (summary.entities.length > 0) parts.push(`Mentioned: ${summary.entities.join(", ")}`);
  if (summary.tone) parts.push(`Tone: ${summary.tone}`);
  return parts.join(". ");
}

/** Carry is a seam, not storage: keep it short, no matter what the model said. */
function clampCarry(text: string): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > CARRY_SUMMARY_CHARS ? `${cleaned.slice(0, CARRY_SUMMARY_CHARS)}…` : cleaned;
}

/** Rotate by conversation id when the caller already holds the id. */
export async function rotateById(deps: RolloverDeps, conversationID: string, reason: SessionCloseReason): Promise<RolloverResult> {
  const conversation = getConversation(deps.db, conversationID);
  if (!conversation) throw new Error(`no conversation ${conversationID}`);
  return rotate(deps, conversation, reason);
}
