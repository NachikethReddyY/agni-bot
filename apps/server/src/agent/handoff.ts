/**
 * Agent-to-agent handoff hook.
 *
 * A handoff is the moment one agent says "I can't do this well; let X do it."
 * It is a tool call inside the task lane, not a new process: the child turn
 * runs in the same thread, streams to the same client, and lands in the same
 * session block — so the user sees one nested activity strip, not a second
 * chat.
 *
 * The hook itself is a thin wrapper around the existing `runTaskTurn` runner:
 * it builds the child `TaskTurnRun`, applies the depth/chain guardrails, and
 * returns the child's final text so the parent can fold it into its answer.
 * The durable state (turns, messages, tool_calls, agent_sessions) is shared
 * with the parent turn's stores — no duplicate schemas.
 */
import type { Database } from "bun:sqlite";
import type { PeerIntent, ServerFrameBody } from "@agni/protocol";
import { GuardrailError, enterDelegation, rootGuardrail, type GuardrailState } from "./guardrails";
import { defaultResolvedPersona, getPersona, resolvePersona, type ResolvedPersona } from "./personas";
import type { Router } from "../models/router";
import type { TaskTurnSettings, TaskTurnRun, TaskTurnResult } from "./task-loop";
import { runTaskTurn } from "./task-loop";
import { createThread } from "../stores/threads";
import { delegationSession, ensureConversation } from "../stores/conversations";

export interface HandoffRequest {
  /** Agent id the work is handed to. */
  toAgentID: string;
  /** Short brief for the child — what to do, what is known. */
  task: string;
  /** Optional context the parent wants the child to have. */
  context?: string;
  /**
   * What this handoff is for (request, question, …); absent reads as
   * "request". It rides in the child's peer envelope.
   */
  intent?: PeerIntent;
  /** Parent turn's emit, so the child streams to the same client. */
  emit: (frame: ServerFrameBody) => void;
  /** Parent turn's abort signal; cancelling the parent cancels the child. */
  signal: AbortSignal;
}

export interface HandoffResult {
  childTurnID: string;
  agentID: string;
  text: string;
  stopReason: string;
  /** Depth the child ran at (1 = root, 2 = first delegation). */
  depth: number;
}

export interface HandoffDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  /** The parent turn's emit. */
  emit: (frame: ServerFrameBody) => void;
  /** The parent turn's abort signal. */
  signal: AbortSignal;
  /** The parent turn's thread + conversation context. */
  threadID: string;
  conversationID?: string;
  carrySummary?: string | null;
  /** The parent's guardrail state. */
  guardrail: GuardrailState;
  /** Optional persona override for the child (defaults to the target agent's persona). */
  persona?: ResolvedPersona;
}

/**
 * Run a delegated child turn. Applies the depth/chain guardrails before
 * calling the runner; a refused delegation surfaces as a typed error the
 * parent can report to the user instead of spinning.
 */
export async function handoff(deps: HandoffDeps, request: HandoffRequest): Promise<HandoffResult> {
  const persona = deps.persona ?? resolvePersona(deps.db, request.toAgentID) ?? defaultResolvedPersona(deps.db);
  const child = enterDelegation(deps.guardrail, persona.id, request.context ?? null);
  // The delegated work belongs to the agent that was asked: its block lives in
  // that agent's conversation, so opening that agent's chat in the app shows
  // the work instead of an empty room.
  const conversation = ensureConversation(deps.db, persona.id);
  const parent = parentName(deps.db, deps.guardrail.currentAgentID);
  const childThread = delegationSession(deps.db, conversation, `${parent} messaged ${persona.name}`);
  const childThreadID = childThread.id;

  // Peer context is data, not authority: the brief and the delegating
  // agent's context both travel inside the peer envelope, so they arrive
  // with their attribution and none of the system prefix's weight.
  const text = request.context?.trim()
    ? `${request.task}\n\nContext from the delegating agent:\n${request.context.trim()}`
    : request.task;

  const run: TaskTurnRun = {
    threadID: childThreadID,
    text,
    persona,
    peer: {
      from: parent,
      intent: request.intent ?? "request",
    },
    conversationID: conversation.id,
    // The brief is a message *to* the specialist, not the owner speaking:
    // it is written to the log as a note, so the specialist's chat reads
    // like a conversation rather than a transcript of someone else's brief.
    inputRole: "system",
    inputText: `${parent} messaged you: ${text}`,
    carrySummary: deps.carrySummary ?? null,
    // Child work is internal; the parent receives the result through the tool
    // response and remains the only agent writing to the user-facing stream.
    emit: (frame) => {
      if (frame.type === "status.update") deps.emit(frame);
    },
    signal: deps.signal,
    guardrail: child,
    // Preserve guardrail bookkeeping; peer context itself is carried in text.
    handoffSummary: child.handoffSummary,
  };

  const result = await runTaskTurn(deps.db, deps.router, deps.settings, run);
  return {
    childTurnID: result.turnID,
    agentID: persona.id,
    text: result.text,
    stopReason: result.stopReason,
    depth: child.depth,
  };
}

/** The delegating agent's live display name, for the note the child reads. */
function parentName(db: Database, agentID: string): string {
  const row = db.query<{ display_name: string | null }, [string]>("SELECT display_name FROM agents WHERE id = ?").get(agentID);
  return row?.display_name?.trim() || agentID;
}

/** Build the ToolContext chain metadata for a turn. */
export function chainContext(state: GuardrailState) {
  return {
    depth: state.depth,
    rootAgentID: state.rootAgentID,
    currentAgentID: state.currentAgentID,
    handoffSummary: state.handoffSummary,
  };
}

export { GuardrailError, rootGuardrail, type GuardrailState };
