import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export const MEMORY_TYPES = ["fact", "preference", "style", "entity", "decision", "procedure", "insight"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ["agent", "global", "global_user", "user"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export interface AgentMemoryRow {
  id: string;
  scope: string;
  agent_id: string | null;
  type: string;
  key_slug: string;
  content: string;
  tags: string | null;
  importance: number;
  created_at: string;
  updated_at: string;
  kind: string;
  valid_from: string | null;
  valid_to: string | null;
  supersedes_id: string | null;
  source_block_id: string | null;
  source_turn_ids: string | null;
  last_used_at: string | null;
  use_count: number;
  embedding: Uint8Array | null;
  confidence: number;
  salience: number;
  visibility: string;
  source: string;
}

const MEMORY_COLUMNS =
  "id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at, kind, valid_from, valid_to, supersedes_id, source_block_id, source_turn_ids, last_used_at, use_count, embedding, confidence, salience, visibility, source";

export interface AgentMemoryInput {
  scope?: string;
  agentID?: string | null;
  type?: string;
  keySlug: string;
  content: string;
  tags?: string[];
  importance?: number;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function keySlug(input: string): string {
  const slug = slugify(input);
  if (slug.length === 0) throw new Error("memory key must produce a non-empty slug");
  return slug;
}

export function normalizeTags(tags: string[] | undefined): string | null {
  if (!tags?.length) return null;
  // Trim, collapse inner whitespace, then de-duplicate case-insensitively while
  // keeping the first spelling — "A" and "a" are the same tag to a reader.
  const clean: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    clean.push(tag);
  }
  if (clean.some((tag) => tag.length > 64) || clean.length > 20) {
    throw new Error("tags must be at most 20 items of 64 characters");
  }
  return clean.join(", ") || null;
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function putAgentMemory(db: Database, input: AgentMemoryInput): AgentMemoryRow {
  const scope = input.scope ?? "agent";
  const type = MEMORY_TYPES.includes(input.type as MemoryType) ? input.type! : "fact";
  const normalizedKeySlug = input.keySlug.includes("-") && !/[^a-z0-9-]/.test(input.keySlug)
    ? input.keySlug
    : keySlug(input.keySlug);
  const content = input.content.trim();
  if (!content || content.length > 20_000) throw new Error("memory content must be 1–20000 characters");
  const tags = normalizeTags(input.tags);
  const importance = clampImportance(input.importance ?? 0);
  const agentID = input.agentID === undefined ? null : input.agentID;
  const timestamp = nowISO();

  const existing = db
    .query<AgentMemoryRow, [string, string, string]>(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE scope = ? AND COALESCE(agent_id, '') = ? AND key_slug = ? AND valid_to IS NULL`,
    )
      .get(scope, agentID ?? "", normalizedKeySlug);

  if (existing) {
    // MEM-002: a changed fact supersedes the old one; it is never silently
    // overwritten. The old row is closed (valid_to set, key renamed to free
    // the semantic key) and a new live row points back at it.
    const unchanged =
      existing.content === content &&
      existing.type === type &&
      existing.tags === tags &&
      existing.importance === importance;
    if (unchanged) {
      db.run("UPDATE agent_memories SET updated_at = ? WHERE id = ?", [timestamp, existing.id]);
      return getAgentMemory(db, existing.id)!;
    }
    db.run("UPDATE agent_memories SET valid_to = ?, key_slug = ?, updated_at = ? WHERE id = ?", [
      timestamp,
      `${existing.key_slug}~${existing.id}`,
      timestamp,
      existing.id,
    ]);
  }

  const row: AgentMemoryRow = {
    id: newID("mem"),
    scope,
    agent_id: agentID,
    type,
    key_slug: normalizedKeySlug,
    content,
    tags,
    importance,
    created_at: timestamp,
    updated_at: timestamp,
    kind: type,
    valid_from: timestamp,
    valid_to: null,
    supersedes_id: existing?.id ?? null,
    source_block_id: null,
    source_turn_ids: null,
    last_used_at: null,
    use_count: 0,
    embedding: null,
    confidence: 1,
    salience: importance,
    visibility: "shared",
    source: "user",
  };
  db.run(
    `INSERT INTO agent_memories (id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at, kind, valid_from, valid_to, supersedes_id, source_block_id, source_turn_ids, last_used_at, use_count, embedding, confidence, salience, visibility, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.scope,
      row.agent_id,
      row.type,
      row.key_slug,
      row.content,
      row.tags,
      row.importance,
      row.created_at,
      row.updated_at,
      row.kind,
      row.valid_from,
      row.valid_to,
      row.supersedes_id,
      row.source_block_id,
      row.source_turn_ids,
      row.last_used_at,
      row.use_count,
      row.embedding,
      row.confidence,
      row.salience,
      row.visibility,
      row.source,
    ],
  );
  return row;
}

export function getAgentMemory(db: Database, id: string): AgentMemoryRow | null {
  return (
    db
      .query<AgentMemoryRow, [string]>(
        `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function getAgentMemoryByKey(
  db: Database,
  input: { scope?: string; agentID?: string | null; keySlug: string },
): AgentMemoryRow | null {
  const scope = input.scope ?? "agent";
  const agentID = input.agentID === undefined ? null : input.agentID;
  return (
    db
      .query<AgentMemoryRow, [string, string, string]>(
        `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE scope = ? AND COALESCE(agent_id, '') = ? AND key_slug = ? AND valid_to IS NULL`,
      )
      .get(scope, agentID ?? "", input.keySlug) ?? null
  );
}

export function listAgentMemories(
  db: Database,
  input: { scope?: string; agentID?: string | null; limit?: number; query?: string } = {},
): AgentMemoryRow[] {
  const scope = input.scope ?? "agent";
  const agentID = input.agentID === undefined ? null : input.agentID;
  // MEM-004: scope enforcement lives in the query layer, not in prompts. An
  // agent-scoped read must name its agent; without one it is an empty result,
  // never "everything".
  if (scope === "agent" && !agentID) return [];
  const limit = clampLimit(input.limit);
  const query = input.query?.trim();
  // Match in SQL so the limit applies to matches, not to the newest rows.
  const params: (string | number)[] = agentID === null ? [scope] : [scope, agentID];
  if (query) params.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
  params.push(limit);
  return db
    .query<AgentMemoryRow, (string | number)[]>(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE scope = ? AND agent_id ${agentID === null ? "IS NULL" : "= ?"} AND valid_to IS NULL${query ? " AND (content || ' ' || COALESCE(tags, '')) LIKE ? ESCAPE '\\'" : ""} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params);
}

export function deleteAgentMemory(db: Database, id: string): boolean {
  // MEM-005: "forget" is a hard delete. A superseded fact and its whole
  // version chain go too — deleting only the live row would leave the old
  // value recoverable by id.
  const row = getAgentMemory(db, id);
  if (!row) return false;
  const base = row.key_slug.includes("~") ? row.key_slug.split("~")[0]! : row.key_slug;
  return (
    db.run(
      "DELETE FROM agent_memories WHERE scope = ? AND COALESCE(agent_id, '') = ? AND (key_slug = ? OR key_slug LIKE ?)",
      [row.scope, row.agent_id ?? "", base, `${base}~%`],
    ).changes > 0
  );
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit)) return 10;
  return Math.min(200, Math.max(1, limit));
}
