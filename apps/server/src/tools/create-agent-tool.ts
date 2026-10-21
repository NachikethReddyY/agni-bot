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
import type { Persona } from "../agent/personas";
import { getPersona, personaInfo, mentionRoster, registerPersona, DEFAULT_AGENT_TOOLS } from "../agent/personas";
import { nowISO } from "../util/ids";
import { MAX_AGENT_NAME_CHARS } from "../agent/identity";
import type { ToolRegistry } from "./registry";

export interface CreateAgentToolDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
}

/** A starting toolset for a new agent when the caller doesn't pick one. */
const DEFAULT_TOOLS = DEFAULT_AGENT_TOOLS;

const PALETTE = ["#e05252", "#5b9bd5", "#65a765", "#9a7bd1", "#e0a75a", "#5ac8c8", "#d95f9e", "#8a9a5b"];

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (slug || "agent").slice(0, 40);
}

function colorFor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
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
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    handler: async (args: Record<string, unknown>) => {
      const db = deps.db;
      const name = String(args.name ?? "").trim();
      if (!name || name.length > MAX_AGENT_NAME_CHARS) throw new Error(`name must be 1–${MAX_AGENT_NAME_CHARS} characters`);
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) throw new Error("a new agent needs a system prompt");
      const role = String(args.role ?? "").trim() || "agent";
      const id = String(args.id ?? "").trim() || slugify(name);
      if (!/^[a-z0-9_]+$/.test(id)) throw new Error("id must be lowercase letters, numbers, and underscores");
      // Say what to do instead: an agent that exists is renamed, not rebuilt.
      if (getPersona(id)) throw new Error(`agent ${id} already exists — use rename_agent to change it, or pick another id`);
      const row = db.query("SELECT display_name FROM agents WHERE id = ?").get(id) as { display_name: string | null } | null;
      if (row) throw new Error(`agent ${id} already exists (${row.display_name ?? id}) — use rename_agent to change it, or pick another id`);

      const requested: string[] = Array.isArray(args.tools)
        ? args.tools.filter((tool): tool is string => typeof tool === "string")
        : [];
      const known = new Set(registry.listByKind("static").map((tool) => tool.name));
      const tools = requested.filter((tool) => known.has(tool));
      const dropped = requested.filter((tool) => !known.has(tool));
      const finalTools = tools.length > 0 ? tools : [...DEFAULT_TOOLS];

      const colorArg = typeof args.color === "string" ? args.color.trim() : "";
      const color = colorArg ? colorArg : colorFor(id);
      // DEL-007: a new agent reads user memory but cannot write it unless the
      // caller explicitly says so.
      const memoryScope: "read" | "readwrite" = args.memoryScope === "readwrite" ? "readwrite" : "read";
      const persona: Persona = { id, name, color, role, systemPromptTemplate: prompt, tools: finalTools, memoryScope };

      const now = nowISO();
      db.run(
        `INSERT INTO agents (id, name, color, role, role_detail, default_name, display_name, system_prompt, avatar_color, onboarded, tools, memory_scope, created_at, updated_at)
         VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [id, name, color, role, name, name, prompt, color, JSON.stringify(finalTools), memoryScope, now, now],
      );
      registerPersona(persona);
      deps.emit({ type: "agents.update", agents: personaInfo(db), mentions: mentionRoster(db) });

      return {
        id,
        name,
        role,
        color,
        tools: finalTools,
        memoryScope,
        ...(dropped.length > 0 ? { droppedTools: dropped } : {}),
        promptChars: prompt.length,
      };
    },
  });
}
