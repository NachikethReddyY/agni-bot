/**
 * `say` — post a short progress update as its own message.
 *
 * A long task should not arrive as one wall of prose at the end. The agent
 * calls `say` before a slow step and after each milestone; the owner sees
 * separate bubbles while the turn keeps running. The final answer stays a
 * separate message.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import { appendChannelMessage } from "../stores/channels";
import { appendMessage } from "../stores/threads";
import { stripPeerTags } from "../agent/peer-message";

export interface SayDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
  threadID: string;
  turnID: string;
  channelID?: string;
  persona: { id: string; name: string };
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

export function registerSayTool(registry: ToolRegistry, deps: SayDeps): void {
  if (registry.get("say")) return;
  registry.register({
    name: "say",
    description:
      "Post a short progress update as its own message in the chat, while the turn continues. " +
      "Use it before a slow step and after each milestone — one or two sentences, no headings, no full answer. " +
      "Do not repeat these updates in the final answer.",
    schema: objectSchema({ text: { type: "string", minLength: 1, maxLength: 800 } }, ["text"]),
    timeoutMs: 2_000,
    handler: async (args, ctx) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const raw = String(input.text ?? "").trim();
      // A peer-influenced turn shows its words without the envelope tags.
      const text = ctx.peerInput ? stripPeerTags(raw) : raw;
      if (!text) throw new Error("text is required");
      const message = appendMessage(deps.db, {
        threadID: deps.threadID,
        turnID: deps.turnID,
        role: "assistant",
        text,
      });
      if (!deps.channelID) {
        // The CLI has no channel surface; a notify still shows the update
        // immediately instead of hiding it until history is reloaded.
        deps.emit({ type: "notify", title: deps.persona.name, body: text, sound: false });
        return { delivered: true, messageID: message.id, channel: false };
      }
      const agent = deps.db.query<{ display_name: string; avatar_color: string }, [string]>(
        "SELECT display_name, avatar_color FROM agents WHERE id = ?",
      ).get(deps.persona.id);
      const row = appendChannelMessage(deps.db, {
        channelID: deps.channelID,
        fromType: "agent",
        fromID: deps.persona.id,
        text,
        turnID: deps.turnID,
        uiHint: "progress",
        peerInfluenced: Boolean(ctx.peerInput),
      });
      deps.emit({
        type: "msg.new",
        id: row.id,
        channelId: deps.channelID,
        fromType: "agent",
        fromId: deps.persona.id,
        senderName: agent?.display_name ?? deps.persona.name,
        senderColor: agent?.avatar_color,
        text,
        internal: false,
        uiHint: "progress",
        createdAt: row.created_at,
      });
      return { delivered: true, messageID: row.id, channel: true };
    },
  });
}
