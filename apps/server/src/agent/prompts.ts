/**
 * Prompt construction for the task (delegation) lane.
 *
 * Prefix-cache consciousness (S5): the leading block of every prompt is
 * stable across turns in a lane — the persona system prompt, then the lane
 * header, then the bounded facts block. Only the tail (history, summary,
 * user text) changes. Providers that cache prefixes get a hit on the stable
 * head and only pay for the tail.
 *
 * The delegation prompt adds the lane header, the tool catalog, and the
 * carried summary — but the stable head is still first.
 */
import type { ResolvedPersona } from "./personas";
import { MAX_FACT_PREFIX_CHARS } from "./guardrails";
import { assembleContext, type Anchor } from "../context/compiler";
import { PEER_RULE } from "./peer-message";

/** Stable lane header — kept identical across turns in the same lane. */
export function laneHeader(lane: "task" | "deep"): string {
  switch (lane) {
    case "task":
      return "You are in the task lane: use tools when they help, observe their results, and finish with a concise answer.";
    case "deep":
      return "You are in the deep lane: delegate to subagents and compile their findings into one answer.";
  }
}

/** Build the delegation (task lane) prefix block, for the loop to prepend. */
export function buildDelegationPrefix(params: {
  persona: ResolvedPersona;
  facts: string[];
  carrySummary: string | null;
  depth: number;
  maxDepth: number;
  toolHints?: string[];
  /** The other agents this one may hand work to, with their roles. */
  team?: Array<{ id: string; name: string; role: string }>;
  /** ASM-002: short always-present note of the current topic, if available. */
  anchor?: Anchor | null;
  /** ASM-004: what this turn needs, retrieved rather than carried. */
  recall?: string[];
  /** ROL-006: the last turns of the previous block, verbatim. */
  previousTail?: string[];
  /** CMP-001: the rolled-up day and epoch summaries, when there are any. */
  rollups?: string[];
}): string {
  const summaries: string[] = [];
  if (params.carrySummary) {
    summaries.push(`Carried summary of earlier session blocks: ${params.carrySummary}`);
  }
  if (params.rollups?.length) {
    summaries.push(`Earlier, at a wider scope:\n${params.rollups.join("\n")}`);
  }
  const tail: string[] = [];
  tail.push(PEER_RULE);
  if (params.team?.length) {
    // The roster is the model's only view of who else exists, so it states both
    // who they are and what the contract is: hand off in one call, then fold
    // the returned result into the reply.
    tail.push(
      [
        "Your team — hand work to these with `handoff` (synchronous) or `delegate_task` (background):",
        ...params.team.map((member) => `- ${member.id} (${member.name}): ${member.role}`),
        "Offload rather than pile up. If a request is someone else's job, hand it off and keep working.",
        "When the owner writes `use @name` or `@name`, that names the specialist to delegate to.",
        "The specialist's answer comes back to you privately as the tool result; only you write to the",
        "owner's chat, so synthesize it instead of forwarding it. Never claim a delegated task finished",
        "before you have seen its result. Use `delegate_wait` only when you need the result this turn;",
        "otherwise start the work, tell the owner it has begun, and let the completion notice arrive.",
      ].join("\n"),
    );
  }
  tail.push(`You are at depth ${params.depth} of ${params.maxDepth} in an agent-to-agent chain.`);
  if (params.toolHints?.length) {
    tail.push(`Dynamic tools available (full schema on invocation):\n${params.toolHints.join("\n")}`);
  }
  return assembleContext({
    personaPrompt: params.persona.systemPrompt,
    laneHeader: laneHeader("task"),
    facts: params.facts,
    anchor: params.anchor ?? null,
    summaries,
    recall: params.recall ?? [],
    previousTail: params.previousTail ?? [],
    tail,
  });
}

export function estimatePrefixTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export { MAX_FACT_PREFIX_CHARS };
