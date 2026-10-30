import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { cosineSimilarity, embedderConfig, embedText, packVector, unpackVector, type EmbedderConfig } from "../agent/embeddings";

export const MEMORY_TYPES = ["fact", "preference", "style", "entity", "decision", "procedure", "insight", "episode"] as const;
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
  embedding_model: string | null;
  embedding_dim: number | null;
  archived_at: string | null;
}

/**
 * A live row: never closed, or closed in the future (B12: a tagger `ttl`
 * is stored as `valid_to`, so a temporary fact expires on its own).
 * The format matches `nowISO()`, so the comparison is a string compare.
 */
export const LIVE_SQL = "(valid_to IS NULL OR valid_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";
const LIVE_SQL_M = LIVE_SQL.replace(/valid_to/g, "m.valid_to");

const MEMORY_COLUMNS =
  "id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at, kind, valid_from, valid_to, supersedes_id, source_block_id, source_turn_ids, last_used_at, use_count, embedding, confidence, salience, visibility, source, embedding_model, embedding_dim, archived_at";

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
  const source = input.source?.trim() || "user";

  // TAG-002: a fact about the owner may only come from the owner (or from
  // something verified). A tool result, a web page or an email is data: a
  // page that says "the user prefers dark mode" is an injection attempt, not
  // a fact. An item that breaks the rule is kept as the agent's own note
  // instead of becoming a fact about the owner.
  const userScope = scope === "global_user" || scope === "user";
  const sourceMayWriteUserFacts = source === "user" || source === "verified";
  if (userScope && !sourceMayWriteUserFacts && !agentID) {
    throw new Error("only owner-stated content may become a user-scoped fact");
  }
  const effectiveScope = userScope && !sourceMayWriteUserFacts ? "agent" : scope;
  const effectiveAgentID = effectiveScope === "agent" ? agentID : null;

  const existing = db
    .query<AgentMemoryRow, [string, string, string]>(
      // Any row holding the exact key: the live one, or one closed without
      // a rename (an expired ttl, the consolidation sweep). The unique key
      // index means it has to move out of the way either way.
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE scope = ? AND COALESCE(agent_id, '') = ? AND key_slug = ?`,
    )
      .get(effectiveScope, effectiveAgentID ?? "", normalizedKeySlug);
  const live = existing && (existing.valid_to === null || existing.valid_to > timestamp) ? existing : null;

  if (existing) {
    // MEM-002: a changed fact supersedes the old one; it is never silently
    // overwritten. The old row is closed (valid_to set, key renamed to free
    // the semantic key) and a new live row points back at it.
    const unchanged =
      live !== null &&
      existing.content === content &&
      existing.type === type &&
      existing.tags === tags &&
      existing.importance === importance &&
      existing.valid_to === (input.validTo ?? null);
    // B11: a no-op rewrite leaves updated_at alone, or it reshuffles the pins.
    if (unchanged) return existing;
    db.run("UPDATE agent_memories SET valid_to = ?, key_slug = ?, updated_at = ? WHERE id = ?", [
      live ? timestamp : existing.valid_to,
      `${existing.key_slug}~${existing.id}`,
      timestamp,
      existing.id,
    ]);
  }

  const row: AgentMemoryRow = {
    id: newID("mem"),
    scope: effectiveScope,
    agent_id: effectiveAgentID,
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
    supersedes_id: live?.id ?? null,
    source_block_id: input.sourceBlockID ?? null,
    source_turn_ids: input.sourceTurnIDs?.join(",") ?? null,
    last_used_at: null,
    use_count: 0,
    embedding: null,
    confidence: clampConfidence(input.confidence),
    salience: clampImportance(input.salience ?? importance),
    visibility: normalizeMemoryVisibility(input.visibility),
    source,
    embedding_model: null,
    embedding_dim: null,
    archived_at: null,
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
  embedOnWrite(db, row.id, row.content);
  return row;
}

/** At most this many write-time embeddings in flight; the rest wait for the job. */
const EMBED_ON_WRITE_MAX = 4;
let embedsInFlight = 0;

/**
 * Embed a new row right away, so it is findable by meaning at once instead
 * of after the next `memory.embed` sweep. Fire-and-forget and bounded: when
 * the embedder is absent, busy or down, the sweep still backfills the row.
 */
export function embedOnWrite(
  db: Database,
  id: string,
  content: string,
  config: EmbedderConfig | null = embedderConfig(),
  fetchFn?: typeof fetch,
): Promise<void> | null {
  if (!config || embedsInFlight >= EMBED_ON_WRITE_MAX) return null;
  embedsInFlight += 1;
  return embedText(content, config, fetchFn)
    .then((vector) => {
      // The row may have been superseded or the store closed meanwhile.
      if (vector) setMemoryEmbedding(db, id, vector, config.model);
    })
    .catch(() => {})
    .finally(() => {
      embedsInFlight -= 1;
    });
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
  // No scope: everything the caller may read (the turn's own retrieval).
  // A named scope is that scope alone (B10).
  const scope = input.scope;
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
  const terms = queryTerms(query);
  // B1: bm25 is negative (more negative is better) and, in a small store,
  // nearly zero for every row, so it only orders hits. Relevance is how much
  // of the query a row covers, scaled by where bm25 puts it in this set.
  const scores = rows.map((row) => -row.rank);
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  const hits: MemoryHit[] = rows.map((row, index) => {
    const memory = row as unknown as AgentMemoryRow;
    const position = best > worst ? (scores[index]! - worst) / (best - worst) : 1;
    const relevance = termCoverage(terms, `${memory.content} ${memory.tags ?? ""}`) * (0.5 + 0.5 * position);
    return { row: memory, relevance, score: rankMemory(memory, relevance, now) };
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

interface SqlFilter {
  clauses: string[];
  values: string[];
}

/** The caller-filter, shared by the list and the search. */
function memoryFilter(scope: string | undefined, agentID: string | null, caller: string | null): SqlFilter {
  const clauses = [LIVE_SQL_M, "m.archived_at IS NULL"];
  const values: string[] = [];
  if (scope === "agent") {
    clauses.push("m.scope = 'agent'", "m.agent_id = ?");
    values.push(agentID ?? "");
  } else {
    if (scope) {
      clauses.push("m.scope = ?");
      values.push(scope);
    }
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
 * Store a vector with the model that produced it. A different model means a
 * different vector space, so the old vector is replaced rather than mixed
 * with the new one.
 */
export function setMemoryEmbedding(
  db: Database,
  id: string,
  vector: Float32Array,
  model: string,
): void {
  db.run("UPDATE agent_memories SET embedding = ?, embedding_model = ?, embedding_dim = ? WHERE id = ?", [
    packVector(vector),
    model,
    vector.length,
    id,
  ]);
}

/** Facts that have no vector, or one from an older model. */
export function listMemoriesNeedingEmbedding(
  db: Database,
  options: { model: string; limit?: number } = { model: "" },
): AgentMemoryRow[] {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  return db
    .query<AgentMemoryRow, [string, number]>(
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories
       WHERE ${LIVE_SQL} AND archived_at IS NULL
         AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model <> ?)
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(options.model, limit);
}

/**
 * The vector neighbours of a query, filtered by the same caller-filter as
 * the text search. A private fact is not a neighbour of another agent.
 */
/** How many of the newest embedded rows one vector search scores. */
const VECTOR_SCAN_ROWS = 2000;

export function searchMemoriesByVector(
  db: Database,
  input: {
    vector: Float32Array;
    scope?: string;
    agentID?: string | null;
    callerAgentID?: string | null;
    limit?: number;
  },
): MemoryHit[] {
  // No scope: everything the caller may read (the turn's own retrieval).
  // A named scope is that scope alone (B10).
  const scope = input.scope;
  const agentID = input.agentID === undefined ? null : input.agentID;
  const caller = input.callerAgentID ?? null;
  if (scope === "agent" && !agentID) return [];
  if (scope === "agent" && caller && caller !== agentID) return [];
  const limit = Math.min(50, Math.max(1, Math.floor(input.limit ?? 10)));

  const filter = memoryFilter(scope, agentID, caller);
  // H27: rank the newest embedded rows (bounded), not an arbitrary sample.
  const rows = db
    .query<AgentMemoryRow & { embedding: Uint8Array | null }, (string | number)[]>(
      `SELECT ${MEMORY_COLUMNS.split(", ").map((column) => `m.${column}`).join(", ")}, m.embedding AS embedding
       FROM agent_memories m
       WHERE ${[...filter.clauses, "m.embedding IS NOT NULL"].join(" AND ")}
       ORDER BY m.updated_at DESC, m.rowid DESC
       LIMIT ${VECTOR_SCAN_ROWS}`,
    )
    .all(...filter.values);

  const now = Date.now();
  const hits: MemoryHit[] = [];
  for (const row of rows) {
    const vector = unpackVector(row.embedding);
    if (!vector) continue;
    // Cosine similarity maps into 0..1 so it can be fused with bm25.
    const relevance = (cosineSimilarity(input.vector, vector) + 1) / 2;
    hits.push({ row, relevance, score: rankMemory(row, relevance, now) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * Hybrid retrieval: the text hits and the vector hits fused with
 * reciprocal rank fusion (RRF). RRF is used because the two scores live on
 * different scales — a bm25 rank and a cosine similarity — and pretending
 * otherwise makes the fusion a tuning trap.
 */
export function fuseHits(textHits: MemoryHit[], vectorHits: MemoryHit[]): MemoryHit[] {
  const RRF_K = 60;
  const scores = new Map<string, number>();
  const rows = new Map<string, MemoryHit>();
  const add = (hits: MemoryHit[]): void => {
    hits.forEach((hit, index) => {
      const id = hit.row.id;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
      if (!rows.has(id)) rows.set(id, hit);
    });
  };
  add(textHits);
  add(vectorHits);
  return [...scores.entries()]
    .map(([id, fused]) => {
      const hit = rows.get(id)!;
      return { ...hit, score: fused, relevance: hit.relevance };
    })
    .sort((a, b) => b.score - a.score);
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
  const all = splitTerms(query).slice(0, 16);
  // OR alone would match any fact sharing "the" or "what": stopwords out.
  const terms = mode === "or" ? all.filter((term) => !STOPWORDS.has(term)) : all;
  if (terms.length === 0) return '""';
  const joiner = mode === "and" ? " AND " : " OR ";
  return terms.map((term) => `"${term.replace(/"/g, "")}"`).join(joiner);
}

function splitTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length > 0);
}

/** The words that carry meaning in a query. */
function queryTerms(query: string): string[] {
  const all = splitTerms(query).slice(0, 16);
  const content = all.filter((term) => !STOPWORDS.has(term));
  return content.length > 0 ? content : all;
}

/**
 * The share of query terms the text contains.
 * shortcut: a shared-prefix test stands in for the porter stemmer FTS uses; swap for
 * FTS5 per-term matches if coverage proves too loose.
 */
export function termCoverage(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const words = splitTerms(text.slice(0, 4_000));
  // Same stem: a shared prefix of at least 4 that covers all but the last
  // two letters of the shorter word ("escalate" ~ "escalations").
  const sameStem = (a: string, b: string): boolean => {
    if (a === b) return true;
    const shorter = Math.min(a.length, b.length);
    if (shorter < 4) return false;
    let common = 0;
    while (common < shorter && a[common] === b[common]) common += 1;
    return common >= Math.max(4, shorter - 2);
  };
  const hit = (term: string): boolean => words.some((word) => sameStem(word, term));
  return terms.filter(hit).length / terms.length;
}

const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "me my of on or our she so that the their them then there these they this to was we were what when where which who " +
    "why will with would you your about any just like know tell remember please").split(" "),
);

export function getAgentMemoryByKey(
  db: Database,
  input: { scope?: string; agentID?: string | null; keySlug: string },
): AgentMemoryRow | null {
  const scope = input.scope ?? "agent";
  const agentID = input.agentID === undefined ? null : input.agentID;
  return (
    db
      .query<AgentMemoryRow, [string, string, string]>(
        `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE scope = ? AND COALESCE(agent_id, '') = ? AND key_slug = ? AND ${LIVE_SQL}`,
      )
      .get(scope, agentID ?? "", input.keySlug) ?? null
  );
}

export function listAgentMemories(
  db: Database,
  input: {
    scope?: string;
    agentID?: string | null;
    limit?: number;
    query?: string;
    callerAgentID?: string | null;
    /** B11: the pinned set — by salience, then use, not by the last edit. */
    pinned?: boolean;
  } = {},
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
  const clauses: string[] = ["scope = ?", LIVE_SQL, "archived_at IS NULL"];
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
      `SELECT ${MEMORY_COLUMNS} FROM agent_memories WHERE ${clauses.join(" AND ")} ORDER BY ${input.pinned ? "salience DESC, use_count DESC, " : ""}updated_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params);
}

/** True when the row is live and `caller` may read it (the list's filter, for one row). */
export function memoryVisibleTo(row: AgentMemoryRow, caller: string | null): boolean {
  const live = row.archived_at === null && (row.valid_to === null || row.valid_to > nowISO());
  const scoped = row.agent_id === null || row.agent_id === caller;
  const visible = row.visibility !== "private" || (row.agent_id ?? "ea") === caller;
  return live && scoped && visible;
}

/**
 * The owner rewrites a memory. The new text supersedes the old (MEM-002),
 * keeps the row's key, scope and pin, and counts as owner-stated.
 */
export function rewriteAgentMemory(db: Database, id: string, content: string): AgentMemoryRow | null {
  const current = getAgentMemory(db, id);
  if (!current) return null;
  return putAgentMemory(db, {
    scope: current.scope,
    agentID: current.agent_id,
    keySlug: current.key_slug,
    type: current.type,
    kind: current.kind,
    content,
    tags: current.tags ? current.tags.split(", ") : undefined,
    importance: current.importance,
    salience: current.salience,
    confidence: 1,
    visibility: current.visibility,
    source: "user",
    validTo: current.valid_to,
  });
}

/** Pinned means salience 1.0, the same mark the consolidation sweep gives. */
export function setMemoryPinned(db: Database, id: string, pinned: boolean): AgentMemoryRow | null {
  const changed = db.run(`UPDATE agent_memories SET salience = ? WHERE id = ? AND ${LIVE_SQL}`, [pinned ? 1 : 0.5, id]).changes;
  return changed > 0 ? getAgentMemory(db, id) : null;
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
