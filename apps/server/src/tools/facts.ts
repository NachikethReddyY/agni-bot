import type { Database } from "bun:sqlite";
import {
  deleteAgentMemory,
  getAgentMemory,
  listAgentMemories,
  putAgentMemory,
  type AgentMemoryRow,
} from "../stores/agent-memories";

export const FACT_TAG = "fact";

export interface RememberFactArgs {
  fact: string;
  keySlug?: string;
  scope?: string;
  agentID?: string | null;
  tags?: string[];
  importance?: number;
  /** Who may read this fact later: private | summary | shared. */
  visibility?: string;
  /** Where it came from: user | agent | tool | web. */
  source?: string;
}

export interface RememberFactResult { id: string; fact: string }

function slugForFact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "saved_fact";
}

export function rememberFact(db: Database, args: RememberFactArgs): RememberFactResult {
  const fact = args.fact.trim();
  if (!fact || fact.length > 8_000) throw new Error("fact must be 1–8000 characters");
  const tags = [...new Set([...(args.tags ?? []), FACT_TAG].map((tag) => tag.trim()).filter(Boolean))];
  const row = putAgentMemory(db, {
    scope: args.scope ?? "global_user",
    agentID: args.agentID ?? null,
    keySlug: args.keySlug ?? slugForFact(fact),
    type: "fact",
    content: fact,
    tags,
    importance: args.importance ?? 0.5,
    visibility: args.visibility,
    source: args.source ?? "user",
  });
  return { id: row.id, fact: row.content };
}

export interface RecallFactArgs {
  query?: string;
  limit?: number;
  scope?: string;
  agentID?: string | null;
  /** The agent asking. Scope and visibility are enforced against it. */
  callerAgentID?: string | null;
}
export interface RecallFactResult { facts: { id: string; fact: string; summary: string | null; tags: string | null }[] }

export function recallFact(db: Database, args: RecallFactArgs): RecallFactResult {
  const limit = clampLimit(args.limit);
  const scope = args.scope ?? "global_user";
  const rows = listAgentMemories(db, {
    scope,
    agentID: args.agentID ?? null,
    limit,
    query: args.query,
    callerAgentID: args.callerAgentID ?? null,
  });
  return { facts: rows.map((row) => ({ id: row.id, fact: row.content, summary: null, tags: row.tags })) };
}

export interface ForgetFactArgs { id: string }
export interface ForgetFactResult { deleted: boolean }

export function forgetFact(db: Database, args: ForgetFactArgs): ForgetFactResult {
  return { deleted: deleteAgentMemory(db, args.id) };
}

export function getFact(db: Database, id: string) {
  const row = getAgentMemory(db, id);
  return row ? toFact(row) : null;
}

export function updateFact(db: Database, id: string, patch: { fact?: string; tags?: string[] }) {
  const current = getAgentMemory(db, id);
  if (!current) return null;
  const row = putAgentMemory(db, {
    scope: current.scope,
    agentID: current.agent_id,
    keySlug: current.key_slug,
    type: current.type,
    content: patch.fact ?? current.content,
    tags: [...new Set([...(patch.tags ?? (current.tags ? current.tags.split(", ") : [])), FACT_TAG])],
    importance: current.importance,
  });
  return toFact(row);
}

function toFact(row: AgentMemoryRow) {
  return { id: row.id, fact: row.content, summary: null, tags: row.tags };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return 8;
  return Math.min(25, limit);
}
