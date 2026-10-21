# Audit: agni-context-memory-spec v2.0 against the Agni codebase

> **SUPERSEDED — do not use this as a source of truth.**
>
> This audit was written against `eb56aac`, before the memory, delegation,
> mention-routing and secure-input work landed. Several of its `MISSING` and
> `PARTIAL` verdicts are now wrong, and its build order and effort estimates
> no longer hold.
>
> - Current plan: [`docs/remaining-work.md`](remaining-work.md)
> - Requirements: [`docs/agni-context-memory-spec.md`](agni-context-memory-spec.md)
>
> Kept for history and for the reasoning behind the early build order only.

Read-only audit. Every status is backed by a file:line reference or a direct code
search. `TUNABLE` numbers are treated as guesses, not facts.

Repo audited: `/Users/ynr/Developer/Agni-Bot` (branch `main`, HEAD `eb56aac`).

---

## 0. Claims (C-01..C-09)

| Claim | Status | Evidence |
|---|---|---|
| C-01 One conversation per agent; never resets | **EXISTS** | `stores/conversations.ts` (`agent_id UNIQUE`, `ensureConversation`); `db/migrations.ts:241-248` (conversations table). No reset path found. |
| C-02 Session blocks rotate; a full block closes into a carried summary | **EXISTS** | `agent/rollover.ts` (`SESSION_ROLLOVER_CHARS = 32000`, `rolloverIfNeeded`, `rotate`, `carryForward`, `clampCarry`). |
| C-03 Channels `main` + `dm:<agent>`; channel messages are the durable transcript | **EXISTS** | `db/migrations.ts:311-329`; `ws/dispatch.ts:293` (`channelID = frame.channelId ?? "main"`), `:296` (dm channel creation). |
| C-04 `handoff` spawns a child turn **in the same thread** with a specialist persona; reply posts to the channel | **PARTIAL** | `agent/handoff.ts:73` creates a **new** thread (`createThread`) for the child — not the same thread. The reply does post to the channel (`tools/handoff-tool.ts:148` `post("agent", ...)`). So "same thread" is false; the rest holds. |
| C-05 `create_agent` registers agents at runtime | **EXISTS** | `tools/create-agent-tool.ts`; `agent/personas.ts` `registerPersona` (pushes to `PERSONAS`). |
| C-06 Specialists hidden from sidebar but valid handoff targets | **EXISTS** | `personas.ts` `hidden?: boolean`; `personaInfo` filters `!persona.hidden`; `teamRoster` does not filter. |
| C-07 Stores: `agent_memories` (scope/type/tags/importance), `links`, `tasks`; facts recalled into prompt prefix | **EXISTS** | `stores/agent-memories.ts`; `tools/facts.ts` `recallFact`; called in `agent/loop.ts:81` and `agent/task-loop.ts:102`. |
| C-08 `compactor.ts` compacts channel history | **EXISTS** | `agent/compactor.ts` `compactChannelHistory` (opportunistic, `COMPACT_AT=36` / `COMPACT_TOKEN_AT=12000`). |
| C-09 Roster is a static set of personas | **EXISTS (extended)** | `personas.ts` `PERSONAS` array; now runtime-extensible via `registerPersona`. |

---

## 1. Routing and channels (section 3)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| RTE-001 | **EXISTS** | `ws/dispatch.ts:293-304`: `channelID = frame.channelId ?? "main"`; `requestedAgentID = frame.toAgentId ?? (frame.channelId ? channel?.agent_id : session.agentID)`. DM resolves to the channel's agent. | — | low |
| RTE-002 | **EXISTS** | `runUserMessage` resolves `persona = resolvePersona(requestedAgentID)` and runs the turn as that agent; the DM transcript is appended to that agent's thread (`:364`). No EA invocation on the DM path. | — | low |
| RTE-003 | **EXISTS** | Hidden only filters `personaInfo` (sidebar). `getPersona` still resolves hidden agents; `createChannel` works for any `agentID`; `teamRoster` includes hidden. | — | low |
| RTE-004 | **MISSING** | No per-agent visibility enum. `channels` has a `visibility` column (`private`/`public`), but there is no `private \| summary \| shared` on the agent, and no DM-visibility policy. | M | low |

## 2. Gate (section 4)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| GATE-001 | **MISSING** | No classifier before the model call. `runUserMessage` only special-cases `isCapture`/`isStoreQuery` (`dispatch.ts:377-380`), then runs the task lane. No `ephemeral \| durable_candidate \| task_intent \| explicit_remember` classification; no small-model gate. | L | medium |
| GATE-002 | **PARTIAL** | Ephemeral turns (if they existed) would be persisted: `appendMessage` is called in both `loop.ts:62` and `task-loop.ts`. But "ephemeral" as a concept does not exist. | S | low |
| GATE-003 | **PARTIAL** | `isCapture` handles `remember:` / `add task:` prefixes and URLs (`dispatch.ts:409-411`); `isStoreQuery` handles search queries. These run immediately, but only as string-prefix heuristics, not a gate. | S | low |

## 3. Context assembler (section 5)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| ASM-001 | **PARTIAL** | Prompts are assembled in `agent/prompts.ts` (`buildFastPathMessages`, `buildDelegationPrefix`, `buildSystemPrefix`) with persona + lane header + facts + history + carry summary. But there is **no slot-based assembler** (pinned_core / anchor / ledger / summaries / recall / recent_turns) and no per-slot caps. | L | medium |
| ASM-002 | **MISSING** | No "anchor" concept anywhere (grep for `anchor` in `src/` returns only the export doc's helper). | M | low |
| ASM-003 | **MISSING** | No deictic rewrite. `recallFact` only does substring `includes` (`tools/facts.ts:50-55`). | M | low |
| ASM-004 | **MISSING** | No hybrid retrieval. `agent_memories` and `channel_messages` have **no FTS or vector index**. `recallFact` does substring `includes` over `listAgentMemories`. FTS5 exists only for legacy `memories`/`links` tables (`db/migrations.ts:137-138`). No embedding model/provider anywhere in the codebase. | XL | high |
| ASM-005 | **MISSING** | No `expand` tool. | M | low |
| ASM-006 | **MISSING** | No low-confidence fallback to the tail of the previous block. | S | low |
| ASM-007 | **PARTIAL** | Budgets are module constants (`SESSION_ROLLOVER_CHARS=32000`, `CARRY_SUMMARY_CHARS=900`, `COMPACT_AT=36`, `COMPACT_TOKEN_AT=12000`, `MAX_HISTORY_MESSAGES=16`), not configuration. | S | low |

## 4. Tagging and memory (section 6)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| TAG-001 | **MISSING** | No strict item schema. `compactor.ts:48-59` extracts facts via an LLM prompt into a loose shape (`scope/type/key_slug/content/importance`); items are not validated against a schema; invalid ones are silently skipped, not logged. | M | low |
| TAG-002 | **MISSING** | No `source` field on `agent_memories`. `putAgentMemory` accepts any scope without checking provenance. `tools/facts.ts` `rememberFact` defaults scope to `global_user` regardless of caller. | M | medium |
| TAG-003 | **MISSING** | No `confidence` column; no threshold gating promotion. | S | low |
| TAG-004 | **MISSING** | No ephemeral concept; every turn is persisted and compactor extracts facts from all turns. | S | low |
| MEM-001 | **MISSING** | `agent_memories` (v12) has `id, scope, agent_id, type, key_slug, content, tags, importance, created_at, updated_at`. **Missing:** `kind, valid_from, valid_to, supersedes_id, source_block_id, source_turn_ids, last_used_at, use_count, embedding, confidence, salience, visibility, source`. | XL | high |
| MEM-002 | **MISSING** | `putAgentMemory` updates in place on an existing key (`agent-memories.ts:90-96`). No `supersedes_id` link, no `valid_to`. Silent overwrite. | M | medium |
| MEM-003 | **MISSING** | No FTS or vector index on `agent_memories` or `channel_messages`. FTS5 exists only for legacy `memories`/`links` (`migrations.ts:137-138`). | XL | high |
| MEM-004 | **PARTIAL** | `listAgentMemories` enforces `scope` + `agent_id` in SQL (`agent-memories.ts:154-173`). No `visibility` dimension at all. | M | low |
| MEM-005 | **PARTIAL** | `deleteAgentMemory` deletes from `agent_memories` only (`agent-memories.ts:175-177`). No FTS index to clean for this table (none exists), but summaries and the search index are not touched. | M | medium |
| MEM-006 | **MISSING** | No consolidation job. The jobs runner polls for `turn` and `brief` jobs only (`index.ts` boot log). No nightly dedupe/close/archive. | L | medium |

## 5. Rollover and compaction (section 7)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| ROL-001 | **PARTIAL** | Session blocks are **per conversation**, not per channel (`conversations.ts` `active_thread_id`; `thread.conversation_id`). Channel compaction (`compactor.ts`) is per channel. So "blocks per channel" is not exactly true; it's per conversation. | S | low |
| ROL-002 | **CONFLICT** | `rolloverIfNeeded` is **awaited** in `runUserMessage` (`dispatch.ts:335`). The user turn waits for rollover. Not a background job. | M | medium |
| ROL-003 | **PARTIAL** | Trigger is char-based (`SESSION_ROLLOVER_CHARS = 32000`, `rollover.ts:30`), not "65% of budget." No topic-shift detection, no idle-gap trigger. | M | medium |
| ROL-004 | **PARTIAL** | `compactChannelHistory` re-reads the channel and extracts facts (tagger-like) — but it is opportunistic and triggered on channel activity, not a guaranteed pre-close sweep of the session block. | M | medium |
| ROL-005 | **MISSING** | Summary is free text (`carry` string). No structured `{decisions, open_loops, entities, tone, source_turn_range}`. | M | low |
| ROL-006 | **PARTIAL** | New block seeded with the carry summary (`openSession` sets `opened_carry`). But verbatim last ~6 turns are **not** carried into the new block; the turn runner reads `recentMessages` from the (empty) new block. Ledger/anchor not implemented. | M | medium |
| CMP-001 | **MISSING** | Single-level compaction (channel summary + block carry). No hierarchical block → day → epoch. | L | medium |

## 6. Delegation (section 8)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| DEL-001 | **CONFLICT** | `handoff` is **synchronous**: `handoff-tool.ts` `await handoff(...)` (`:144`); no `tasks` row created. The spec wants async with a `tasks` row and immediate return. Changing this is a significant redesign (parent turn must continue without the child's answer). | XL | high |
| DEL-002 | **EXISTS** | `handoff.ts:73` creates a new thread (`createThread`) for the child; the child runs with its own `TaskTurnRun`. | — | low |
| DEL-003 | **PARTIAL** | Brief is `{task, context}` (`handoff-tool.ts:126-132`), not `{goal, constraints, fact_ids, deadline, output_schema}`. Child receives `handoffSummary` + `carrySummary` (some EA context), not the full transcript — partially aligned. | M | medium |
| DEL-004 | **PARTIAL** | Result text is pushed as a channel message and returned as the tool result; the full text enters the EA's context. No `artifact_ref` reference storage; no "only summary enters" enforcement. | M | medium |
| DEL-005 | **MISSING** | `tasks` table has `owner_device_id`, no `owner_agent` or `origin` (`ea_delegated \| user_direct`). `stores/tasks.ts` `createTask` has no agent/origin params. | S | low |
| DEL-006 | **PARTIAL** | `handoff-tool.ts:120-123` emits a transient `status.update` "Waiting on X…" only. No policy for start/needs_input/done/failed, no per-agent visibility (RTE-004 unimplemented). | M | medium |
| DEL-007 | **PARTIAL** | `create-agent-tool.ts` sets persona + tools + color and inserts a DB row. Memory scope read-only for new agents is **not** implemented (no per-agent memory-scope enforcement; `agent_memories` has no read-only concept). | M | medium |

## 7. Evals (section 9)

| ID | Status | Evidence / gap | Effort | Risk |
|---|---|---|---|---|
| EVAL-001 | **MISSING** | No needle eval. Tests are unit/contract tests, not the specified 200+ turn recall eval. | M | low |
| EVAL-002 | **MISSING** | No gate-miss eval. | S | low |
| EVAL-003 | **MISSING** | No continuity eval. | S | low |
| EVAL-004 | **MISSING** | No leak eval. (DM isolation exists by design — see RTE-002 — but not tested as an eval.) | M | low |
| EVAL-005 | **MISSING** | No cost/latency eval harness. | M | low |
| EVAL-006 | **MISSING** | No drift eval. | M | low |

---

## 8. Summary (spec section 11)

**1. Status table (all IDs):**

| Status | Count | IDs |
|---|---|---|
| EXISTS | 14 | C-01, C-02, C-03, C-05, C-06, C-07, C-08, C-09, RTE-001, RTE-002, RTE-003, ROL-001, DEL-002 |
| PARTIAL | 14 | C-04, GATE-002, GATE-003, ASM-001, ASM-007, MEM-004, MEM-005, ROL-003, ROL-004, ROL-006, DEL-003, DEL-004, DEL-006, DEL-007 |
| MISSING | 24 | RTE-004, GATE-001, ASM-002, ASM-003, ASM-004, ASM-005, ASM-006, TAG-001..004, MEM-001, MEM-002, MEM-003, MEM-006, ROL-005, CMP-001, DEL-005, EVAL-001..006 |
| CONFLICT | 2 | ROL-002, DEL-001 |

**2. Claims verdict (C-01..C-09):** all confirmed except C-04, which is **partial** — handoff does **not** run in the same thread; it creates a new thread (`agent/handoff.ts:73`). The claim should be corrected to "spawns a child turn in a new thread."

**3. Recommended build order** (smallest set that delivers "no visible sessions" and direct DMs first):
1. **RTE-004** (per-agent visibility) + **DEL-006** (status policy) — small, unblocks DM isolation guarantees.
2. **GATE-001/002/003** (gate classifier) — enables ephemeral handling; prerequisite for TAG-004.
3. **MEM-001/002/003/004** (memory schema + FTS + supersession + scope/visibility enforcement) — the core of "super-efficient memory."
4. **ASM-001/002/003/004/005/006/007** (slot assembler, anchor, rewrite, hybrid retrieval, expand, fallback, configurable budgets).
5. **TAG-001..004** (tagger + schema validation + confidence + ephemeral).
6. **ROL-002/003/004/005/006** + **CMP-001** (background rollover, structured summaries, hierarchical compaction).
7. **DEL-001/003/004/005/007** (async handoff, brief schema, artifact_ref, tasks owner/origin, memory scope).
8. **EVAL-001..006** (acceptance harness).

**4. Top 5 blockers:**
1. **Same-thread synchronous handoff (DEL-001, ROL-002).** Handoff is currently synchronous and awaited; making it async requires the parent turn to continue without the child's answer, plus a task state machine. High effort, high risk.
2. **No FTS/vector infrastructure for transcripts or agent_memories (MEM-003, ASM-004).** Only legacy `memories`/`links` have FTS5. Embedding model/provider is undecided (D-02/D-03). XL effort.
3. **Memory schema migration (MEM-001).** Adding ~12 columns + temporal validity + supersession is a large migration with risk to existing data.
4. **No gate/tagger/anchor concepts exist at all.** GATE-001, ASM-002, TAG-001..004 are greenfield. Need a small-model provider decision (D-04).
5. **Hidden-agent routing vs. roster.** Hidden agents are addressable (RTE-003 ✓) but there's no visibility policy (RTE-004 MISSING) and no per-agent memory scope (DEL-007 PARTIAL).

**5. Infrastructure gaps:**
- **Embedding model/provider:** none configured; D-02 undecided (local vs hosted).
- **Vector store:** none; D-03 undecided (DB extension vs separate service). SQLite has no native vector search; would need `sqlite-vec` or a sidecar.
- **Background job runner:** exists but only polls `turn` and `brief` jobs (`index.ts` boot). No scheduler for compaction/tagging/consolidation jobs.
- **Small model for gate/rewrite/tagger:** none configured; D-04 undecided. The only provider is NIM (Nemotron). Need a fast/cheap model.
- **FTS for transcripts:** `channel_messages` has no FTS index; memories_fts covers legacy `memories` only.

**6. Estimated total effort:** The spec is roughly **XL across the board**. Incremental shippable slices:
- Slice 1 (S-M): RTE-004 + DEL-006 + GATE-002/003 + ASM-007 — DM isolation guarantees + status policy + budget config. ~1-2 weeks.
- Slice 2 (L-XL): MEM-001..005 (memory schema + FTS + supersession + scope/visibility + hard-delete). ~2-3 weeks.
- Slice 3 (L-XL): ASM-001..006 (slot assembler, anchor, rewrite, hybrid retrieval, expand, fallback). ~2-3 weeks.
- Slice 4 (L): TAG-001..004 + ROL-002..006 + CMP-001. ~2-3 weeks.
- Slice 5 (XL): DEL-001/003/004/005/007 (async handoff). ~3-4 weeks.
- Slice 6 (M): EVAL-001..006 harness. ~1-2 weeks.

Total: roughly 10-16 weeks for the full spec; ~3-4 weeks to ship "no visible sessions" + direct DMs (slices 1-2).

## 9. Open decisions (spec section 12)

All remain open; the agent flags which block implementation:

| ID | Decision | Default assumed | Blocks |
|---|---|---|---|
| D-01 | Default DM visibility to EA: private / summary / shared | summary | RTE-004, DEL-006 |
| D-02 | Embedding model: local vs hosted | undecided | MEM-003, ASM-004 |
| D-03 | Vector store: DB extension vs separate service | undecided | MEM-003, ASM-004 |
| D-04 | Small model for gate / rewrite / tagger | undecided | GATE-001, ASM-003, TAG-* |
| D-05 | Who may write scope=user facts besides the EA | user-stated only | TAG-002 |
| D-06 | Multi-device sync and multi-user scope | out of scope for v2 | — |
| D-07 | Retention and hard-delete guarantees for "forget" | hard delete | MEM-005 |

## 10. Assumptions recorded

1. "Hidden" agents are addressable via DM because `hidden` only filters `personaInfo` (sidebar), not `getPersona` or channel routing. Verified in `personas.ts` and `dispatch.ts:293-304`.
2. The `agent_memories` table (v12) is the current memory store; the legacy `memories`/`memories_fts` tables are not the active path for agent facts (the active path is `agent_memories` via `putAgentMemory`/`listAgentMemories`).
3. `rolloverIfNeeded` is invoked synchronously in `runUserMessage` (`dispatch.ts:335`), so rollover blocks the turn. (Confirmed.)
4. No embedding/vector infrastructure exists anywhere in the codebase (grep for `embedding`/`vector` returned nothing).
5. The instant lane (`agent/loop.ts`) does not use the slot assembler or retrieval; it only injects bounded facts + carry summary + last 16 messages.
6. `handoff` creates a **new** thread for the child (`agent/handoff.ts:73`), contrary to claim C-04's "same thread" wording. The doc should be corrected.
7. `create_agent` does not enforce memory scope read-only for new agents (DEL-007 partial).
8. The jobs runner only polls `turn` and `brief` job types; no consolidation/tagging/compaction background jobs.

---

## Verdict

The spec describes a **substantial upgrade** over the current Agni implementation. The foundation (conversations, session blocks, channels, handoff, memory stores, compaction, create_agent, hidden agents) is solid and matches claims C-01..C-03, C-05..C-09. But the spec's core innovations — **the slot-based context assembler, hybrid retrieval (vector + FTS), the memory schema with temporal validity/supersession, the gate/tagger, async handoff, and hierarchical compaction** — are largely **MISSING or PARTIAL**, and several (async handoff, vector store, embedding model, small model) are blocked on **open decisions** (D-02, D-03, D-04).

**Recommended first move:** resolve D-02/D-03/D-04 (embedding model, vector store, small model) and ship Slice 1 (RTE-004, DEL-006, GATE-002/003, ASM-007) for "no visible sessions" + direct DMs, then tackle the memory schema (Slice 2) which unblocks everything downstream.
