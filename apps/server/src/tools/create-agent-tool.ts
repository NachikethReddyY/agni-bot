/**
 * `create_agent` — an agent making its own agent.
 *
 * The owner asks in chat for a bot, and the agent builds it: a persona (name,
 * role, prompt, tools, color) registered into the live roster, plus a durable
 * row so the new agent can be renamed and its prompt survives restarts. The
 * roster frame goes out the same turn, so the bot appears in the app at once.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { personaInfo, mentionRoster } from "../agent/personas";
import { createAgentPersona } from "../agent/creation";
import { nowISO } from "../util/ids";
import { MAX_AGENT_NAME_CHARS } from "../agent/identity";
import type { ToolRegistry } from "./registry";

export interface CreateAgentToolDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
}

export function registerCreateAgentTool(registry: ToolRegistry, deps: CreateAgentToolDeps): void {
  if (registry.get("create_agent")) return;
  registry.register({
    name: "create_agent",
    description:
      "Create a new agent with its own name, role, prompt, and tools, and add it to the app. " +
      "Use it when the user asks you to make a new agent or bot, or to spin up a helper for a job. " +
      "The new agent appears in the app right away and can be selected, renamed, and handed work " +
      "like any other. Give it a system prompt that is its personality and its job.",
    kind: "static",
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: MAX_AGENT_NAME_CHARS, description: "The new agent's display name." },
        id: { type: "string", minLength: 1, maxLength: 64, description: `Optional id in lowercase (e.g. 'friday'). A slug of the name is used if omitted.` },
        role: { type: "string", maxLength: 120, description: "One line describing what this agent does." },
        prompt: { type: "string", minLength: 1, maxLength: 8_000, description: "The new agent's system prompt — its personality and job." },
        color: { type: "string", description: "Optional hex color (e.g. '#e05252'). A color is picked if omitted." },
        tools: { type: "array", items: { type: "string" }, description: "Tool names the new agent may use." },
        memoryScope: { type: "string", enum: ["read", "readwrite"], description: "Whether the agent may write user-scope memory. Default read-only." },
        visibility: { type: "string", enum: ["private", "summary", "shared"], description: "What other agents may see of this agent's work. private = a receipt only, summary = one line, shared = full text. Default summary." },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    handler: async (args: Record<string, unknown>, ctx) => {
      if (ctx.peerInput) return { error: "not done: this turn started from another agent's message" };
      const db = deps.db;
      const known = registry.listByKind("static").map((tool) => tool.name);
      const created = createAgentPersona(
        db,
        {
          name: String(args.name ?? ""),
          id: typeof args.id === "string" ? args.id : undefined,
          role: typeof args.role === "string" ? args.role : undefined,
          prompt: String(args.prompt ?? ""),
          color: typeof args.color === "string" ? args.color : undefined,
          tools: Array.isArray(args.tools) ? args.tools.map((tool) => String(tool)) : [],
          memoryScope: args.memoryScope === "readwrite" ? "readwrite" : "read",
          visibility:
            typeof args.visibility === "string"
              ? (args.visibility as "private" | "summary" | "shared")
              : undefined,
        },
        known,
      );
      deps.emit({ type: "agents.update", agents: personaInfo(db), mentions: mentionRoster(db) });

      return {
        id: created.id,
        name: created.name,
        role: created.role,
        color: created.color,
        tools: created.tools,
        memoryScope: created.memoryScope,
        visibility: created.visibility,
        ...(created.droppedTools.length > 0 ? { droppedTools: created.droppedTools } : {}),
        promptChars: created.promptChars,
      };
    },
  });
}
