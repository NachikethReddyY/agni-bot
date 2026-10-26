/**
 * Register the `handoff` tool on a task-lane registry.
 *
 * The handoff tool is a closure over the running turn's deps so it can spawn
 * a delegated child turn in the same thread. It is registered per-turn (like
 * the mail tools) rather than in the static registry, because its handler
 * needs the live emit/signal/guardrail — it is not a pure function of `db`.
 *
 * Visibility is the point of this file. The user sees who was asked and what
 * for, but not what the specialist said back: the full answer is a tool result
 * for the delegating agent to synthesize. The specialist's own conversation
 * still holds the work, so opening that agent's DM shows it — which is the
 * difference between "Vision asked Friday" and "I asked Friday".
 */
import type { Database } from "bun:sqlite";
import { PEER_INTENTS, PeerIntentSchema, type PeerIntent, type ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import type { TaskTurnSettings } from "../agent/task-loop";
import type { Router } from "../models/router";
import type { GuardrailState } from "../agent/guardrails";
import { handoff, type HandoffDeps, type HandoffRequest } from "../agent/handoff";
import { teamRoster, resolvePersona } from "../agent/personas";
import { DEFAULT_VISIBILITY, redactForCaller } from "../agent/visibility";
import { appendChannelMessage, ensureDMChannel } from "../stores/channels";
import { checkPeerRequest, fingerprintPeerRequest } from "../stores/peer-chains";

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

export interface HandoffToolDeps {
  db: Database;
  router: Router;
  settings: TaskTurnSettings;
  emit: (frame: ServerFrameBody) => void;
  signal: AbortSignal;
  threadID: string;
  channelID?: string;
  currentAgentID: string;
  conversationID?: string;
  carrySummary?: string | null;
  guardrail: GuardrailState;
}

export function registerHandoffTool(registry: ToolRegistry, deps: HandoffToolDeps): void {
  if (registry.get("handoff")) return;
  const team = teamRoster(deps.db, { exclude: deps.currentAgentID });
  const nameOf = (agentID: string): string => {
    const row = deps.db
      .query<{ display_name: string | null; avatar_color: string | null }, [string]>(
        "SELECT display_name, avatar_color FROM agents WHERE id = ?",
      )
      .get(agentID);
    return row?.display_name?.trim() || team.find((member) => member.id === agentID)?.name || agentID;
  };
  const colorOf = (agentID: string): string | undefined => {
    const row = deps.db
      .query<{ avatar_color: string | null }, [string]>("SELECT avatar_color FROM agents WHERE id = ?")
      .get(agentID);
    return row?.avatar_color ?? undefined;
  };
  /** Append a durable channel message and stream it, so reloads and live agree. */
  const post = (
    fromType: "user" | "agent" | "system",
    fromID: string,
    text: string,
    uiHint?: "onboarding_name_prompt" | "handoff_notice" | "progress" | "normal",
    toAgentID?: string,
    channelID = deps.channelID,
    intent?: PeerIntent,
  ): void => {
    if (!channelID) return;
    // The specialist may not have a DM channel yet; create it so the reply
    // has somewhere durable to live.
    if (channelID.startsWith("dm:")) ensureDMChannel(deps.db, channelID.slice(3));
    const row = appendChannelMessage(deps.db, {
      channelID,
      fromType,
      fromID,
      text,
      uiHint: uiHint ?? null,
      toAgentID: toAgentID ?? null,
    });
    deps.emit({
      type: "msg.new", id: row.id, channelId: channelID, fromType,
      fromId: fromID, senderName: nameOf(fromID), senderColor: colorOf(fromID),
      text, internal: false, uiHint: uiHint ?? "normal",
      ...(intent ? { intent } : {}),
      // The target rides along, so the client can make the name a link to
      // that agent's chat.
      ...(toAgentID ? { toAgentId: toAgentID } : {}),
      createdAt: row.created_at,
    });
  };

  registry.register({
    name: "handoff",
    description:
      "Hand a sub-task to another agent and get its answer back privately as this call's result. " +
      "Use it whenever the request is another agent's job — research, coding, or analysis — instead of doing it yourself. " +
      "Give a focused brief: what to do, and any context it needs to start. The other agent's answer does NOT appear in the user's chat; " +
      "synthesize what it means for the user. The user can open that agent's DM to read the work directly.",
    kind: "static",
    timeoutMs: 120_000,
    schema: objectSchema({
      toAgentID: team.length > 0
        ? { type: "string", enum: team.map((member) => member.id), description: team.map((member) => `${member.id}: ${member.role}`).join("; ") }
        : stringProp,
      task: { type: "string", minLength: 1, description: "The brief for the other agent." },
      context: { type: "string", minLength: 1, description: "Optional extra context for the other agent." },
      intent: {
        type: "string",
        enum: [...PEER_INTENTS],
        description: "What this handoff is for: request (default), result, question, status or fyi.",
      },
    }, ["toAgentID", "task"]),
    handler: async (args: Record<string, unknown>) => {
      const toAgentID = String(args.toAgentID ?? "").trim();
      if (!toAgentID) throw new Error("handoff requires a toAgentID");
      if (team.length > 0 && !team.some((member) => member.id === toAgentID)) {
        throw new Error(`unknown agent ${toAgentID}; the team is ${team.map((member) => member.id).join(", ")}`);
      }
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("handoff requires a task");
      const intent = readIntent(args.intent);
      const context = args.context === undefined ? "" : String(args.context).trim();
      // The fingerprint is the primary request text only, the same canonical
      // form delegate_task uses, so one request sent through either tool is
      // one request. Context is not hashed: it cannot make two tasks collide.
      const check = checkPeerRequest(deps.db, deps.guardrail.chainID,
        fingerprintPeerRequest(deps.currentAgentID, toAgentID, intent, task));
      if (check === "retry") return { repeated: true, note: "That exact request was already sent in this chain. Say something new, or stop." };
      if (check === "stop") {
        post("system", deps.currentAgentID, "Stopped: agents repeated the same request in this chain.", "normal", undefined, deps.channelID ?? "main");
        return { stopped: true, note: "The chain is stopped; report to the owner." };
      }

      // The user sees who was asked, before the work starts — this is the
      // "message this bot" line they asked for. The brief is internal
      // routing: it belongs in the tool call, not in the chat. The target
      // rides along, so the name can be a link to that agent's chat.
      post("system", deps.currentAgentID, `Messaged ${nameOf(toAgentID)}`, "handoff_notice", toAgentID, deps.channelID, intent);
      if (deps.channelID) {
        deps.emit({
          type: "status.update", channelId: deps.channelID, agentId: deps.currentAgentID,
          text: `Waiting on ${nameOf(toAgentID)}…`, transient: true,
        });
      }

      const request: HandoffRequest = {
        toAgentID,
        task,
        context: context || undefined,
        intent,
        emit: deps.emit,
        signal: deps.signal,
      };
      const handoffDeps: HandoffDeps = {
        db: deps.db,
        router: deps.router,
        settings: deps.settings,
        emit: deps.emit,
        signal: deps.signal,
        threadID: deps.threadID,
        conversationID: deps.conversationID,
        carrySummary: deps.carrySummary,
        guardrail: deps.guardrail,
      };
      const result = await handoff(handoffDeps, request);
      // Not posted to the delegating agent's channel: the answer belongs to
      // its synthesis. It is posted to the specialist's own DM instead, so a
      // direct chat with that agent reads like a conversation — the brief was
      // a note there, and this is the reply.
      if (result.text.trim()) {
        post("agent", result.agentID, result.text, "normal", undefined, `dm:${result.agentID}`);
      }
      // The one place the specialist's words cross into another agent's
      // context, so the one place visibility is applied. A private agent
      // gives the caller a receipt, not its answer.
      const visibility = resolvePersona(deps.db, toAgentID)?.visibility ?? DEFAULT_VISIBILITY;
      const visible = redactForCaller(result.text, toAgentID, deps.currentAgentID, visibility);
      return {
        childTurnID: result.childTurnID,
        agentID: result.agentID,
        agentName: nameOf(result.agentID),
        depth: result.depth,
        stopReason: result.stopReason,
        text: visible.text,
        visibility: visible.mode,
        redacted: visible.redacted,
      };
    },
  });
}

/** Read the optional intent; absent means "request", invalid is an error. */
function readIntent(raw: unknown): PeerIntent {
  if (raw === undefined || raw === null || raw === "") return "request";
  const parsed = PeerIntentSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`intent must be one of ${PEER_INTENTS.join(", ")}`);
  return parsed.data;
}
