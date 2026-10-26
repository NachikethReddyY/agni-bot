/**
 * Root turn / depth / chain guardrails for agent-to-agent work.
 *
 * The task lane can spawn child turns (delegated work, handoffs). Without a
 * bound that is a free-for-all: a handoff to a subagent that hands back to
 * another that hands again spins until the provider budget is gone. These
 * constants are the single source of truth for what is allowed, and the
 * `GuardrailState` carries the live counters through a chain so the runner
 * can refuse before it calls the model.
 *
 * Prefix-cache note: the guardrail counters are NOT part of the prompt prefix
 * (they are runtime metadata), so they never disturb the stable system prefix
 * that providers cache.
 */
import { newID } from "../util/ids";

/** How deep a chain of delegated turns may run. Root turn is depth 1. */
export const MAX_DEPTH = 5;
/** Maximum tool steps a single turn in the chain may take. */
export const MAX_CHAIN_STEPS = 24;
/** Maximum tool steps a delegated (depth > 1) turn may take. */
export const MAX_DELEGATED_STEPS = 12;
/** Maximum characters of handoff summary text carried between agents. */
export const MAX_HANDOFF_SUMMARY_CHARS = 1_200;
/** Maximum characters of durable fact text injected into a prompt prefix. */
export const MAX_FACT_PREFIX_CHARS = 2_400;

export interface GuardrailState {
  chainID: string;
  /** 1 = root turn, 2 = first delegation, … */
  depth: number;
  /** Steps taken in the current turn of the chain. */
  chainSteps: number;
  /** Total steps taken across the whole chain, for budgeting. */
  totalSteps: number;
  /** The agent id that started the chain (the root persona). */
  rootAgentID: string;
  /** The agent id currently running. */
  currentAgentID: string;
  /** Short summary passed in by the delegating agent. */
  handoffSummary: string | null;
}

export function rootGuardrail(rootAgentID: string, chainID?: string): GuardrailState {
  return {
    depth: 1,
    chainID: chainID ?? newID("chn"),
    chainSteps: 0,
    totalSteps: 0,
    rootAgentID,
    currentAgentID: rootAgentID,
    handoffSummary: null,
  };
}

/** True when another delegation is permitted at this depth. */
export function canDelegate(state: GuardrailState): boolean {
  return state.depth < MAX_DEPTH;
}

/**
 * Advance into a delegated child turn. Returns the child state, or throws if
 * the depth ceiling is reached — the caller should surface that as an error
 * frame rather than silently running a deeper chain.
 */
export function enterDelegation(
  state: GuardrailState,
  childAgentID: string,
  handoffSummary: string | null,
): GuardrailState {
  if (!canDelegate(state)) {
    throw new GuardrailError(
      `depth ceiling reached (${state.depth}/${MAX_DEPTH}); refusing to delegate further`,
      "depth_ceiling",
    );
  }
  return {
    depth: state.depth + 1,
    chainID: state.chainID,
    chainSteps: 0,
    totalSteps: state.totalSteps,
    rootAgentID: state.rootAgentID,
    currentAgentID: childAgentID,
    handoffSummary: clampHandoff(handoffSummary),
  };
}

/** Bump the step counters; throws when the chain budget is exhausted. */
export function stepGuardrail(state: GuardrailState, isDelegated: boolean): GuardrailState {
  const limit = isDelegated ? MAX_DELEGATED_STEPS : MAX_CHAIN_STEPS;
  if (state.chainSteps >= limit) {
    throw new GuardrailError(
      `chain step ceiling reached (${state.chainSteps}/${limit}) for ${state.currentAgentID}`,
      "chain_ceiling",
    );
  }
  return { ...state, chainSteps: state.chainSteps + 1, totalSteps: state.totalSteps + 1 };
}

export function clampHandoff(summary: string | null): string | null {
  if (!summary) return null;
  const cleaned = summary.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_HANDOFF_SUMMARY_CHARS ? `${cleaned.slice(0, MAX_HANDOFF_SUMMARY_CHARS)}…` : cleaned;
}

export function clampFactPrefix(facts: string[]): string {
  const joined = facts.filter(Boolean).join("\n");
  if (!joined) return "";
  return joined.length > MAX_FACT_PREFIX_CHARS ? `${joined.slice(0, MAX_FACT_PREFIX_CHARS)}…` : joined;
}

export class GuardrailError extends Error {
  readonly code: "depth_ceiling" | "chain_ceiling";
  constructor(message: string, code: "depth_ceiling" | "chain_ceiling") {
    super(message);
    this.name = "GuardrailError";
    this.code = code;
  }
}
