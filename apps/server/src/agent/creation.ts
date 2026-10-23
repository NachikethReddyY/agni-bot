/**
 * Creating an agent, in one place.
 *
 * The `create_agent` chat tool and the `agent.create` frame the app's "new
 * agent" button sends both come through here, so a bot made in chat and a bot
 * made in the app cannot drift apart: one row in `agents`, one persona in
 * memory, one roster frame out.
 */
import type { Database } from "bun:sqlite";
import type { Persona } from "./personas";
import { getPersona, registerPersona, DEFAULT_AGENT_TOOLS } from "./personas";
import { normalizeVisibility, type Visibility } from "./visibility";
import { nowISO } from "../util/ids";
import { MAX_AGENT_NAME_CHARS } from "./identity";

const PALETTE = ["#e05252", "#5b9bd5", "#65a765", "#9a7bd1", "#e0a75a", "#5ac8c8", "#d95f9e", "#8a9a5b"];

export interface CreateAgentSpec {
  name: string;
  id?: string;
  role?: string;
  prompt: string;
  color?: string;
  tools?: string[];
  memoryScope?: "read" | "readwrite";
  visibility?: Visibility;
}

export interface CreatedAgent {
  id: string;
  name: string;
  role: string;
  color: string;
  tools: string[];
  memoryScope: string;
  visibility: Visibility;
  droppedTools: string[];
  promptChars: number;
}

export function slugifyAgentID(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (slug || "agent").slice(0, 40);
}

function colorFor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

/**
 * Write the row, register the persona, and hand back what the caller should
 * report. Throws with a plain reason when the request cannot be honoured.
 */
export function createAgentPersona(
  db: Database,
  spec: CreateAgentSpec,
  knownTools: string[],
): CreatedAgent {
  const name = spec.name.trim();
  if (!name || name.length > MAX_AGENT_NAME_CHARS) {
    throw new Error(`name must be 1–${MAX_AGENT_NAME_CHARS} characters`);
  }
  const prompt = spec.prompt.trim();
  if (!prompt) throw new Error("a new agent needs a system prompt");
  const role = spec.role?.trim() || "agent";
  const id = spec.id?.trim() || slugifyAgentID(name);
  if (!/^[a-z0-9_]+$/.test(id)) throw new Error("id must be lowercase letters, numbers, and underscores");
  // Say what to do instead: an agent that exists is renamed, not rebuilt.
  if (getPersona(id)) throw new Error(`agent ${id} already exists — use rename_agent to change it, or pick another id`);
  const row = db.query("SELECT display_name FROM agents WHERE id = ?").get(id) as
    | { display_name: string | null }
    | null;
  if (row) throw new Error(`agent ${id} already exists (${row.display_name ?? id}) — use rename_agent to change it, or pick another id`);

  const requested = (spec.tools ?? []).filter((tool) => knownTools.includes(tool));
  const dropped = (spec.tools ?? []).filter((tool) => !knownTools.includes(tool));
  const finalTools = requested.length > 0 ? requested : [...DEFAULT_AGENT_TOOLS];

  const color = spec.color?.trim() || colorFor(id);
  // DEL-007: a new agent reads user memory but cannot write it unless the
  // caller explicitly says so.
  const memoryScope = spec.memoryScope === "readwrite" ? "readwrite" : "read";
  // D-01: a new agent is `summary` — the caller learns that it finished and
  // roughly what it found, not its full working.
  const visibility = normalizeVisibility(spec.visibility);

  const persona: Persona = {
    id,
    name,
    color,
    role,
    systemPromptTemplate: prompt,
    tools: finalTools,
    memoryScope,
    visibility,
  };

  const now = nowISO();
  db.run(
    `INSERT INTO agents (id, name, color, role, role_detail, default_name, display_name, system_prompt, avatar_color, onboarded, tools, memory_scope, visibility, created_at, updated_at)
     VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [id, name, color, role, name, name, prompt, color, JSON.stringify(finalTools), memoryScope, visibility, now, now],
  );
  registerPersona(persona);

  return {
    id,
    name,
    role,
    color,
    tools: finalTools,
    memoryScope,
    visibility,
    droppedTools: dropped,
    promptChars: prompt.length,
  };
}
