/**
 * The instant lane (S3): one model call, no tools, bounded prompt (S1).
 * This is the only turn runner at P0 — task and deep lanes arrive with the
 * queue in P2/P3.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody, StopReason } from "@agni/protocol";
import { log } from "../log";
import { ProviderError } from "../models/client";
import { MidStreamError, Router, RouterBusyError, RouterError } from "../models/router";
import { appendMessage, createTurn, finishTurn, recentMessages, titleThreadFromFirstMessage, touchThread } from "../stores/threads";
import { recordUsage } from "../stores/usage";
import { newID } from "../util/ids";
import type { ResolvedPersona } from "./personas";
import { recallFact } from "../tools/facts";
import { buildFastPathMessages } from "./prompts";
import type { MailAccountResolver } from "../plugins/credentials";
import { stripPeerTags } from "./peer-message";

/** S1: hard ceiling on history riding in the prompt — never the full thread. */
export const HISTORY_MESSAGE_LIMIT = 16;

export interface TurnSettings {
  firstTokenTimeoutMs: number;
  turnTimeoutMs: number;
  /** Mailboxes connected in Settings → Plugins, for the mail tools. */
  mailAccounts?: MailAccountResolver;
}

export interface TurnRun {
  threadID: string;
  text: string;
  persona: ResolvedPersona;
  emit: (frame: ServerFrameBody) => void;
  signal: AbortSignal;
  /** Conversation model (v2): the conversation the turn belongs to. */
  conversationID?: string;
  /** Carried summary of the session blocks that closed before this one. */
  carrySummary?: string | null;
  /**
   * Bounded durable facts injected into the stable prompt prefix. Default
   * true: facts are agent-kept (remember_fact), read from the indexed store at
   * write time (S4), and capped hard — they never make the instant lane call a
   * tool or grow the prompt with history (S1/S2).
   */
  facts?: boolean;
}

export interface TurnResult {
  turnID: string;
  /** Full assistant text -- partial when the turn was cancelled, timed out, or errored. */
  text: string;
  stopReason: StopReason;
}

export async function runInstantTurn(
  db: Database,
  router: Router,
  settings: TurnSettings,
  run: TurnRun,
): Promise<TurnResult> {
  const { threadID, persona } = run;
  const turnID = newID("trn");

  createTurn(db, { id: turnID, threadID, agentID: persona.id });
  appendMessage(db, { threadID, turnID, role: "user", text: run.text });
  titleThreadFromFirstMessage(db, threadID, run.text);
  run.emit({
    type: "turn.start",
    turnID,
    threadID,
    agentID: persona.id,
    ...(run.conversationID ? { conversationID: run.conversationID } : {}),
  });

  // Prompt: stable system prefix + the last N messages. Nothing else — no
  // memory dump, no tool output (S1/S2). The only cross-bridge content is
  // the carried summary of session blocks that closed before this one, plus
  // the bounded durable facts the agent has kept (read from the indexed store
  // at write time — S4 — never a tool call on the hot path).
  const history = recentMessages(db, threadID, HISTORY_MESSAGE_LIMIT)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.text }));
  if (history.at(-1)?.role === "user" && history.at(-1)?.content === run.text) history.pop();
  const facts = run.facts !== false ? recallFact(db, { limit: 6, callerAgentID: run.persona.id }).facts.map((row) => row.fact) : [];
  const messages = buildFastPathMessages({
    persona,
    facts,
    history,
    carrySummary: run.carrySummary ?? null,
    userText: run.text,
  });

  // The turn timer and the caller's cancel both land on this controller.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, settings.turnTimeoutMs);
  const abortFromCaller = (): void => controller.abort();
  run.signal.addEventListener("abort", abortFromCaller, { once: true });

  let text = "";
  let stopReason: StopReason = "end";
  let routed: { provider: string; model: string; latencyMs: number; inputTokens?: number; outputTokens?: number } | undefined;

  try {
    const result = await router.route({
      messages,
      signal: controller.signal,
      firstTokenTimeoutMs: settings.firstTokenTimeoutMs,
      onDelta: (delta) => {
        text += delta;
        run.emit({ type: "token", turnID, threadID, delta });
      },
    });
    routed = result;
    text = result.text;
  } catch (error) {
    if (timedOut) {
      stopReason = "timeout";
    } else if (run.signal.aborted || (error instanceof ProviderError && error.kind === "aborted")) {
      stopReason = "cancelled";
    } else {
      stopReason = "error";
      const code =
        error instanceof RouterBusyError ? "server_busy" : error instanceof RouterError ? error.code : "provider_failed";
      const message = error instanceof Error ? error.message : String(error);
      run.emit({ type: "error", code, message });
      if (error instanceof MidStreamError) log.warn(`mid-stream failure: ${error.message}`);
    }
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", abortFromCaller);
  }

  // Partial output is still output: save whatever streamed before a timeout
  // or cancellation, and let stopReason carry the honest story.
  if (text.length > 0) appendMessage(db, { threadID, turnID, role: "assistant", text: stripPeerTags(text) });
  finishTurn(db, {
    id: turnID,
    stopReason,
    provider: routed?.provider,
    model: routed?.model,
    inputTokens: routed?.inputTokens,
    outputTokens: routed?.outputTokens,
    latencyMs: routed?.latencyMs,
  });
  touchThread(db, threadID);
  if (routed) {
    recordUsage(db, {
      turnID,
      provider: routed.provider,
      model: routed.model,
      inputTokens: routed.inputTokens,
      outputTokens: routed.outputTokens,
      latencyMs: routed.latencyMs,
    });
  }
  run.emit({
    type: "turn.end",
    turnID,
    threadID,
    stopReason,
    ...(run.conversationID ? { conversationID: run.conversationID } : {}),
    ...(routed
      ? {
          usage: {
            provider: routed.provider,
            model: routed.model,
            inputTokens: routed.inputTokens,
            outputTokens: routed.outputTokens,
            latencyMs: routed.latencyMs,
          },
        }
      : {}),
  });

  return { turnID, text, stopReason };
}
