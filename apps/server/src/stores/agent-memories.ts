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
  /** What kind of item this is (`fact` by default). */
  kind?: string;
  /**
   * Who may read this item: `shared` (any agent with scope access),
   * `summary` (readable, but shown as a one-liner) or `private` (only the
   * owning agent).
   */
  visibility?: string;
  /** Where the item came from: `user`, `agent`, `tool`, `web`, … */
  source?: string;
  /** How sure the writer is, 0..1. */
  confidence?: number;
  /** How much this item matters for ranking, 0..1. */
  salience?: number;
  /** The session block this item was derived from. */
  sourceBlockID?: string | null;
  /** The turns this item was derived from. */
  sourceTurnIDs?: string[] | null;
  /** Validity window for temporal facts. */
  validFrom?: string | null;
  validTo?: string | null;
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

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

/** Only the three known visibilities; anything else is `shared`. */
export function normalizeMemoryVisibility(value: string | null | undefined): string {
  return value === "private" || value === "summary" ? value : "shared";
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
    kind: input.kind?.trim() || type,
    valid_from: input.validFrom ?? timestamp,
    valid_to: input.validTo ?? null,
    supersedes_id: existing?.id ?? null,
    source_block_id: input.sourceBlockID ?? null,
    source_turn_ids: input.sourceTurnIDs?.join(",") ?? null,
    last_used_at: null,
    use_count: 0,
    embedding: null,
    confidence: clampConfidence(input.confidence),
    salience: clampImportance(input.salience ?? importance),
    visibility: normalizeMemoryVisibility(input.visibility),
    source: input.source?.trim() || "user",
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

/**
 * A search hit, with the score that ranked it.
 */
export interface MemoryHit {
  row: AgentMemoryRow;
  /** 0..1 — higher is a better match. */
  score: number;
  /** The text relevance, before the ranking multipliers. */
  relevance: number;
}

/**
 * The ranking formula from the spec:
 *   score = relevance * recency_decay(last_used_at) * salience * (1 + log(1 + use_count))
 *
 * `relevance` comes from FTS5's bm25; the rest is how much the item matters
 * and how fresh it is. A formula whose inputs never change is dead code, so
 * `markMemoryUsed` moves `last_used_at` and `use_count` on every recall.
 */
export function rankMemory(
  row: AgentMemoryRow,
  relevance: number,
  now = Date.now(),
): number {
  const recency = recencyDecay(row.last_used_at ?? row.updated_at, now);
  const salience = row.salience > 0 ? row.salience : 0.5;
  const use = 1 + Math.log(1 + (row.use_count ?? 0));
  return relevance * recency * salience * use;
}

/** A half-life of two weeks, floored so a stale item is not worthless. */
export function recencyDecay(timestamp: string | null, now = Date.now()): number {
  if (!timestamp) return 0.5;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return 0.5;
  const days = Math.max(0, (now - at) / 86_400_000);
  return Math.max(0.2, Math.pow(0.5, days / 14));
}

/**
 * Full-text search over the facts, with the same caller-filter the list
 * uses. The filter is applied in SQL, so a private fact cannot be ranked
 * into a result set the caller will see.
 */
export function searchAgentMemories(
  db: Database,
  input: {
    query: string;
    scope?: string;
    agentID?: string | null;
    callerAgentID?: string | null;
    limit?: number;
  },
): MemoryHit[] {
  const query = input.query.trim();
  if (!query) return [];
  const scope = input.scope ?? "global_user";
  const agentID = input.agentID === undefined ? null : input.agentID;
  const caller = input.callerAgentID ?? null;
  if (scope === "agent" && !agentID) return [];
  if (scope === "agent" && caller && caller !== agentID) return [];
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));

  const rows = runFtsSearch(db, {
    table: "agent_memories_fts",
    columns: MEMORY_COLUMNS.split(", ").map((column) => `m.${column}`).join(", "),
    join: "JOIN agent_memories m ON m.rowid = agent_memories_fts.rowid",
    filter: memoryFilter(scope, agentID, caller),
    query,
    limit: limit * 4,
  });
  if (rows.length === 0) return [];

  const now = Date.now();
  const hits: MemoryHit[] = rows.map((row) => {
    // bm25 is negative and smaller is better; turn it into a 0..1 relevance.
    const relevance = 1 / (1 + Math.max(0, row.rank));
    return { row: row as unknown as AgentMemoryRow, relevance, score: rankMemory(row as unknown as AgentMemoryRow, relevance, now) };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

interface SqlFilter {
  clauses: string[];
  values: string[];
}

/** The caller-filter, shared by the list and the search. */
function memoryFilter(scope: string, agentID: string | null, caller: string | null): SqlFilter {
  const clauses = ["m.valid_to IS NULL"];
  const values: string[] = [];
  if (scope === "agent") {
    clauses.push("m.agent_id = ?");
    values.push(agentID ?? "");
  } else {
    clauses.push("(m.agent_id IS NULL OR m.agent_id = ?)");
    values.push(caller ?? "");
  }
  clauses.push("(m.visibility <> 'private' OR COALESCE(m.agent_id, 'ea') = ?)");
  values.push(caller ?? "");
  return { clauses, values };
}

/**
 * Run an FTS query with the caller's filter. Precision first (`AND`), then
 * recall (`OR`): a paraphrase that misses every term still finds the item.
 */
function runFtsSearch(
  db: Database,
  input: {
    table: string;
    columns: string;
    join: string;
    filter: SqlFilter;
    query: string;
    limit: number;
  },
): Array<Record<string, unknown> & { rank: number }> {
  for (const mode of ["and", "or"] as const) {
    const params: (string | number)[] = [toMatchQuery(input.query, mode), ...input.filter.values, input.limit];
    try {
      const rows = db
        .query<Record<string, unknown> & { rank: number }, (string | number)[]>(
          `SELECT ${input.columns}, bm25(${input.table}) AS rank
           FROM ${input.table}
           ${input.join}
           WHERE ${input.table} MATCH ? AND ${input.filter.clauses.join(" AND ")}
           ORDER BY rank ASC
           LIMIT ?`,
        )
        .all(...params);
      if (rows.length > 0) return rows;
    } catch {
      // A malformed FTS query must not take the turn down.
      return [];
    }
  }
  return [];
}

/**
 * Mark facts as used. The ranking formula reads `last_used_at` and
 * `use_count`, so a recall has to move them or the formula is decoration.
 */
export function markMemoryUsed(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.run(
    `UPDATE agent_memories SET last_used_at = ?, use_count = use_count + 1 WHERE id IN (${placeholders})`,
    [nowISO(), ...ids],
  );
}

/**
 * Turn free text into an FTS5 MATCH expression. Every term is quoted, so a
 * stray quote or operator in the user's words cannot become a query error.
 *
 * `mode` is the trade-off between precision and recall: `and` wants every
 * term, `or` wants any of them. The search tries `and` first and falls back
 * to `or`, so a paraphrase ("when do we deploy") still finds the fact that
 * says "deployments happen on Tuesday".
 */
export function toMatchQuery(query: string, mode: "and" | "or" = "and"): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 0)
    .slice(0, 16);
  if (terms.length === 0) return '""';
  const joiner = mode === "and" ? " AND " : " OR ";
  return terms.map((term) => `"${term.replace(/"/g, "")}"`).join(joiner);
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
  input: { scope?: string; agentID?: string | null; limit?: number; query?: string; callerAgentID?: string | null } = {},
): AgentMemoryRow[] {
  const scope = input.scope ?? "agent";
  const agentID = input.agentID === undefined ? null : input.agentID;
  // MEM-004: scope and visibility are enforced in the query layer, not in
  // prompts — and through ONE filter, so the two rules cannot drift apart.
  //
  //   scope       → `agent` scope is that agent's alone; a global scope
  //                  holds the owner's facts and the caller's own.
  //   visibility  → a private row belongs to its owner alone. A row with no
  //                  agent belongs to the owner of the system (`ea`), the
  //                  executive assistant acting for the human.
  if (scope === "agent" && !agentID) return [];
  const caller = input.callerAgentID ?? null;
  // Another agent never reads another agent's scoped memory.
  if (scope === "agent" && caller && caller !== agentID) return [];
  const limit = clampLimit(input.limit);
  const query = input.query?.trim();
  const params: (string | number)[] = [];
  const clauses: string[] = ["scope = ?", "valid_to IS NULL"];
  params.push(scope);
  if (scope === "agent") {
    clauses.push("agent_id = ?");
    params.push(agentID!);
  } else {
    // A global scope holds the shared facts and the caller's own.
    clauses.push("(agent_id IS NULL OR agent_id = ?)");
    params.push(caller ?? "");
  }
  // Visibility: a private row is for its owner alone.
  clauses.push("(visibility <> 'private' OR COALESCE(agent_id, 'ea') = ?)");
  params.push(caller ?? "");
  if (query) {
    clauses.push("(content || ' ' || COALESCE(tags, '')) LIKE ? ESCAPE '\\'");
    params.push(`%${query.replace(/[\\%_]/g, "\\$&")}%`);
  }
  params.push(limit);
  return db
    .query<AgentMemoryRow, (string | number)[]>(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
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
