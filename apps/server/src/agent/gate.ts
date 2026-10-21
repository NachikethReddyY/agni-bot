/**
 * The turn gate (GATE-001): a synchronous, cheap classifier that runs before
 * the main model call. It decides how a user turn should be remembered —
 * whether it is throwaway chatter, something that might become a durable
 * fact, a task the owner wants done, or an explicit "remember this".
 *
 * Rules first. There is no model call on this path: the instant lane has to
 * stay instant, and the classifier only has to be right enough to keep
 * ephemeral chatter out of compaction and long-term memory. Everything the
 * gate marks `temp` is still written to the durable transcript and still
 * served from the recent-turn window, so a misclassification never loses a
 * turn the user can still see (GATE-002).
 */

export type TurnCategory = "ephemeral" | "durable_candidate" | "task_intent" | "explicit_remember";

/** Salience carried on a channel message (see migration 17). */
export type TurnSalience = "temp" | "recent_turns" | "topic_anchor" | "durable_fact";

export interface GateResult {
  category: TurnCategory;
  salience: TurnSalience;
  /** The turn refers to earlier context ("explain this", "and tomorrow?"). */
  deictic: boolean;
  /** Short, human-readable reason — for logs and tests. */
  reason: string;
}

const EXPLICIT_REMEMBER = /^\s*(remember\s*:|add task\s*:|forget\s+|note (?:that|this)\b|keep in mind\b|don'?t forget\b)/i;
const TASK_VERB = /\b(schedule|remind|email|send|draft|book|research|summari[sz]e|find|look\s+up|search|write|plan|organi[sz]e|build|create|update|fix|debug|refactor|implement|delegate|ask|message|call|order|buy|pay|review|compare|analy[sz]e)\b/i;
const DURABLE_MARKER = /\b(i (?:prefer|like|always|usually|never|am|work|live)|my name is|call me|i'?m based|from now on|by default|remember (?:that|this)|we decided|the decision is|deadline|due (?:on|by))\b/i;
const DEICTIC = /\b(this|that|these|those|the former|the latter|above|earlier|previous|last one|option \d|the other (?:one|option|approach)|it|them|they)\b/i;
const THANKS = /^\s*(thanks|thank you|thx|ty|ok(?:ay)?|got it|sounds good|nice|cool|great|perfect|hi|hey|hello|good morning|good night|bye|see you)\b[\s!.,]*$/i;
const SHORT_QUESTION = /^(?:what|when|where|who|which|how|why|is|are|can|could|does|do|did|will|would)\b/i;

/**
 * Does this message point back at earlier context? The gate and the
 * retrieval rewrite have to agree on this: a turn the gate calls deictic
 * and a turn the rewrite leaves alone is a turn that loses its referent.
 */
export function looksDeictic(text: string, previousText?: string | null): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const short = trimmed.length <= 60 && words.length <= 10;
  if (DEICTIC.test(trimmed)) return true;
  return short && /^(and|what about|how about|then)\b/i.test(trimmed) && Boolean(previousText);
}

/**
 * Classify one user turn. `previousText` is the previous user turn, when the
 * caller has it; it is only used to recognise a bare follow-up ("and
 * tomorrow?") as deictic.
 */
export function classifyTurn(text: string, previousText?: string | null): GateResult {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const short = trimmed.length <= 60 && words.length <= 10;
  const deictic = looksDeictic(trimmed, previousText);

  if (!trimmed) return { category: "ephemeral", salience: "temp", deictic: false, reason: "empty" };

  if (EXPLICIT_REMEMBER.test(trimmed)) {
    return { category: "explicit_remember", salience: "durable_fact", deictic, reason: "explicit remember/task command" };
  }

  if (THANKS.test(trimmed)) {
    return { category: "ephemeral", salience: "temp", deictic: false, reason: "greeting or acknowledgement" };
  }

  // A task is a request to do something, not a fact about the owner. Keep it
  // in the working window and in the ledger; it is not a durable memory.
  if (TASK_VERB.test(trimmed) && trimmed.length >= 24) {
    return { category: "task_intent", salience: "recent_turns", deictic, reason: "action verb in a substantial request" };
  }

  if (DURABLE_MARKER.test(trimmed)) {
    return { category: "durable_candidate", salience: "recent_turns", deictic, reason: "first-person preference or decision marker" };
  }

  // A question that stands on its own and carries no durable signal is
  // ephemeral: answer it, keep it in the window, never compact it.
  if (short && (SHORT_QUESTION.test(trimmed) || /\?\s*$/.test(trimmed)) && !deictic) {
    return { category: "ephemeral", salience: "temp", deictic: false, reason: "short standalone question" };
  }

  if (deictic) {
    return { category: "durable_candidate", salience: "recent_turns", deictic: true, reason: "refers to earlier context" };
  }

  if (short) {
    return { category: "ephemeral", salience: "temp", deictic: false, reason: "short standalone remark" };
  }

  return { category: "durable_candidate", salience: "recent_turns", deictic: false, reason: "substantial turn, may carry durable content" };
}

/** Explicit remembers bypass batching and are processed immediately (GATE-003). */
export function bypassesBatch(category: TurnCategory): boolean {
  return category === "explicit_remember";
}
