---
doc: agni-context-memory-spec
version: 2.0
purpose: >
  Requirements spec for Agni context management, memory and delegation.
  Designed so an AI agent can check each requirement against the real codebase
  and report whether it is implementable, and at what cost.
status_values: [EXISTS, PARTIAL, MISSING, CONFLICT, UNKNOWN]
effort_values: [S, M, L, XL]
---

# 0. Instructions for the verifying agent

You are auditing a codebase against this spec. **Do not modify any code.** Read-only.

1. Locate the Agni repo root. Do not assume file paths: the paths in section 1 are *claims by the author*, verify each.
2. For every requirement ID in sections 3-9, search the code and fill in a result block (format in section 10).
3. Evidence must be `path:line` references or exact command output. If you cannot find evidence, status is `MISSING`, not `PARTIAL`.
4. Use `CONFLICT` when existing code does the opposite of the requirement or an existing design blocks it (explain in `blockers`).
5. Use `UNKNOWN` only if you could not search (state why). Never guess.
6. Record every assumption you make in `assumptions`.
7. Finish with the summary in section 11 and the open decisions in section 12 that block implementation.

Keyword conventions: MUST / SHOULD / MAY follow RFC 2119. `TUNABLE` values are starting guesses to be set by evals, not facts.

# 1. Claimed current state (VERIFY, do not trust)

| Claim ID | Claim | Verify by |
|---|---|---|
| C-01 | One conversation per agent; never resets | find conversation model/table; check for reset logic |
| C-02 | Session blocks rotate; a full block is closed into a carried summary | `rollover.ts`; block table/columns |
| C-03 | Channels: `main` (EA) and `dm:<agent>` (specialists); channel messages are the durable transcript | channel enum/table; message table |
| C-04 | `handoff` tool spawns a child turn **in the same thread** with a specialist persona; reply posts to the channel | tool definition and executor |
| C-05 | `create_agent` tool registers agents at runtime | tool definition; roster storage |
| C-06 | Specialists are hidden from the sidebar but valid handoff targets | roster/sidebar code |
| C-07 | Stores: `agent_memories` (scope/type/tags/importance), `links`, `tasks`; facts are recalled into the prompt prefix | schema/migrations; recall code |
| C-08 | `compactor.ts` compacts channel history | file and callers |
| C-09 | Roster is a static set of personas | roster definition |

# 2. Glossary

- **channel**: `main` or `dm:<agent_id>`. Carries the transcript.
- **block**: a bounded run of turns inside a channel; closed into a summary at rollover.
- **item**: one tagged unit of derived memory (fact, decision, task, etc.).
- **ephemeral turn**: a turn that derives no memory but is still stored in the transcript and the recent window.
- **anchor**: short, always-present note of the current topic, entities and last question.

# 3. Routing and channels

```yaml
- id: RTE-001
  level: MUST
  text: Every inbound message resolves to (agent_id, channel_id) from its channel. main -> EA. dm:<agent> -> that agent.
  verify: find the inbound message entrypoint; check whether the target agent is derived from the channel.
  accept: a message sent on dm:research is handled by the research agent with no EA invocation.
- id: RTE-002
  level: MUST
  text: A DM turn MUST NOT invoke the EA and MUST NOT put the DM transcript into any EA prompt.
  verify: grep for prompt assembly that reads other channels; check whether handoff/synthesis reads dm channels.
  accept: leak test EVAL-004 passes.
- id: RTE-003
  level: MUST
  text: Hidden specialists MUST be addressable via dm channel. "Hidden from sidebar" must not block DM access.
  verify: roster/sidebar code; channel creation path for hidden agents.
- id: RTE-004
  level: SHOULD
  text: Per-agent visibility enum private | summary | shared. Default summary (EA sees task status and one-line outcomes only). DECISION D-01.
  verify: agent config schema.
```

# 4. Gate (synchronous, cheap)

```yaml
- id: GATE-001
  level: MUST
  text: Classify each user turn as ephemeral | durable_candidate | task_intent | explicit_remember using rules plus a small/cheap model. No large-model call on this path.
  verify: where a turn is received before the main model call; any existing classifier.
  accept: p95 gate latency under TUNABLE 150 ms (excluding network to the small model if remote; report both).
- id: GATE-002
  level: MUST
  text: Ephemeral turns MUST still be persisted to the channel transcript and remain in the recent-turn window.
  accept: "weather today?" then "and tomorrow?" is answered correctly.
- id: GATE-003
  level: MUST
  text: explicit_remember and explicit forget bypass batching and are processed immediately.
```

# 5. Context assembler

Slot order (stable first, so prefix caching works). Budgets are TUNABLE.

```yaml
slots:
  - {name: pinned_core,   source: persona + bounded user profile,        budget_tokens: 1500}
  - {name: anchor,        source: topic anchor,                           budget_tokens: 200}
  - {name: ledger,        source: open tasks / open loops for this agent, budget_tokens: 800}
  - {name: summaries,     source: relevant block/day summaries,          budget_tokens: 1500}
  - {name: recall,        source: retrieved items + transcript chunks,    budget_tokens: 1500}
  - {name: recent_turns,  source: last N verbatim turns,                  budget_tokens: remainder}
```

```yaml
- id: ASM-001
  level: MUST
  text: Prompt is assembled per (agent, channel) from the slots above, in that order, each capped by its budget.
  verify: find current prompt builder; check ordering, per-channel scoping, and where facts are injected today (C-07).
- id: ASM-002
  level: MUST
  text: Anchor is updated every turn (or every K turns) and always included.
- id: ASM-003
  level: SHOULD
  text: If the user message is not self-contained (deictic words, very short, pronouns without referent), rewrite it using anchor + last turns before retrieval. Skip rewrite when self-contained.
  accept: "explain this" retrieves the same items as the explicit rewrite.
- id: ASM-004
  level: MUST
  text: Retrieval is hybrid (vector + FTS/BM25) over transcript chunks AND facts. Inject nothing if confidence is below threshold (TUNABLE).
  verify: existing search/embedding infrastructure; DB support for FTS and vectors.
- id: ASM-005
  level: MUST
  text: Provide an expand(channel, turn_from, turn_to) tool returning verbatim turns. Summaries and recalled items MUST carry source turn ranges.
- id: ASM-006
  level: SHOULD
  text: On low retrieval confidence, fall back to the tail of the previous block.
- id: ASM-007
  level: SHOULD
  text: Slot budgets are configuration, not constants.
```

Retrieval rank (TUNABLE): `score = relevance * recency_decay(last_used_at) * salience * (1 + log(1 + use_count))`.

# 6. Tagging and memory

Tagger runs **asynchronously** in micro-batches (every K turns or on idle; immediate only for explicit_remember and task creation).

```json
{
  "item": {
    "kind": "fact|preference|decision|task|open_loop|artifact_ref|episode|skill_candidate",
    "text": "string",
    "scope": "user|agent|task",
    "visibility": "private|summary|shared",
    "source": "user|agent|tool|web",
    "salience": 0.0,
    "confidence": 0.0,
    "entities": ["string"],
    "ttl": "ISO-8601 duration|null",
    "source_turn_ids": ["string"]
  },
  "tagger_output": {"items": ["item"], "ephemeral": true}
}
```

```yaml
- id: TAG-001
  level: MUST
  text: Tagger output is validated against the schema; invalid items are dropped and logged, never stored.
- id: TAG-002
  level: MUST
  text: Only source=user (or verified) may create scope=user facts. tool/web content MUST NOT become facts about the user.
- id: TAG-003
  level: MUST
  text: Items below confidence threshold (TUNABLE 0.6) stay in the transcript only and are not promoted.
- id: TAG-004
  level: MUST
  text: ephemeral turns produce no items.
- id: MEM-001
  level: MUST
  text: "Migrate agent_memories with: kind, valid_from, valid_to, supersedes_id, source_block_id, source_turn_ids, last_used_at, use_count, embedding, confidence, salience, visibility, source."
  verify: current schema/migration tooling; ORM constraints; size of existing data.
- id: MEM-002
  level: MUST
  text: A changed fact supersedes the old one (set valid_to, link supersedes_id). No silent overwrite.
- id: MEM-003
  level: MUST
  text: Transcript chunks are indexed (vector + FTS) with turn ids.
- id: MEM-004
  level: MUST
  text: Scope and visibility are enforced in the query layer, not in prompts. scope=agent items are unreadable by other agents.
  accept: EVAL-004.
- id: MEM-005
  level: MUST
  text: "Forget" hard-deletes across facts, summaries, and the search index.
- id: MEM-006
  level: SHOULD
  text: Nightly consolidation - dedupe, close superseded facts, archive unused low-salience items, promote high-use facts to pinned profile.
```

Conflict rule: newest user-stated fact wins; the old one is closed; the conflict is flagged for review.

# 7. Rollover and compaction

```yaml
- id: ROL-001
  level: MUST
  text: Blocks are per channel. Each channel runs its own rollover.
- id: ROL-002
  level: MUST
  text: Rollover is a background job. A user turn arriving mid-rollover is served from the old block plus any in-flight summary. No user-visible wait.
- id: ROL-003
  level: MUST
  text: Trigger when block tokens exceed TUNABLE 65% of budget, or idle gap plus topic shift. Never wait until full.
- id: ROL-004
  level: MUST
  text: Before closing, a sweep re-reads the whole block and runs the tagger to catch what the gate missed.
- id: ROL-005
  level: MUST
  text: "Summary is structured: {decisions, open_loops, entities, tone, source_turn_range}."
- id: ROL-006
  level: MUST
  text: New block is seeded with the summary, last ~6 verbatim turns (TUNABLE), the ledger and the anchor.
- id: CMP-001
  level: SHOULD
  text: Hierarchical compaction block -> day -> epoch, with source ranges preserved.
  verify: compactor.ts behavior today (C-08).
```

# 8. Delegation

```yaml
- id: DEL-001
  level: MUST
  text: handoff is asynchronous - creates a tasks row and returns immediately. Task states queued | running | needs_input | done | failed.
  verify: current handoff is synchronous and same-thread (C-04); report the blockers to changing that.
- id: DEL-002
  level: MUST
  text: Child agent runs in its own thread/context, not the EA's.
- id: DEL-003
  level: MUST
  text: "Brief schema: {goal, constraints, fact_ids, deadline, output_schema}. Child does not receive the EA transcript."
- id: DEL-004
  level: MUST
  text: Result stored by reference (artifact_ref) plus a short summary; only the summary enters the EA context.
- id: DEL-005
  level: MUST
  text: tasks carry owner and origin (ea_delegated | user_direct). Direct DM tasks are owned by the specialist.
- id: DEL-006
  level: MUST
  text: Status updates to the user follow a policy (start if long, needs_input, done, failed) and respect per-agent visibility (RTE-004).
- id: DEL-007
  level: SHOULD
  text: create_agent sets persona, tool allowlist and memory scope. New agents get user-scope memory read-only.
```

# 9. Evals (acceptance tests)

```yaml
- id: EVAL-001  # needle
  text: Plant N facts early in a 200+ turn channel, force 2-3 rollovers, ask vague follow-ups ("explain this", "what did we decide earlier?"). Report recall rate.
- id: EVAL-002  # gate
  text: Measure durable facts the gate misses that the rollover sweep catches.
- id: EVAL-003  # continuity
  text: Ephemeral follow-ups ("and tomorrow?") succeed.
- id: EVAL-004  # leak
  text: Private DM and scope=agent content never appears in EA answers or EA prompts.
- id: EVAL-005  # cost
  text: Tokens per turn, tagger spend per 100 turns, p95 reply latency with and without retrieval/rewrite.
- id: EVAL-006  # drift
  text: Answer quality from summary vs from source after N rollovers.
```

# 10. Result block (one per requirement)

```yaml
id: RTE-001
status: EXISTS|PARTIAL|MISSING|CONFLICT|UNKNOWN
evidence: ["path:line - what it shows"]
gap: "what is missing or different"
blockers: ["design or dependency issues"]
assumptions: ["..."]
effort: S|M|L|XL
touches: ["files/modules to change"]
risk: low|medium|high
notes: ""
```

# 11. Final summary the agent must produce

1. Table of all IDs with status and effort.
2. Verdict on C-01..C-09: confirmed / false / partial, with evidence.
3. Recommended build order (smallest set that delivers "no visible sessions" and direct DMs first).
4. Top 5 blockers (especially same-thread synchronous handoff, hidden-agent routing, absence of FTS/vector support, schema migration risk).
5. Infrastructure gaps: embedding model/provider, vector store, background job runner, small-model access.
6. Estimated total effort and what can ship incrementally.

# 12. Open decisions for the human (agent must flag which block implementation)

| ID | Decision | Default assumed |
|---|---|---|
| D-01 | Default DM visibility to EA: private / summary / shared | summary |
| D-02 | Embedding model: local vs hosted | undecided |
| D-03 | Vector store: existing DB extension vs separate service | undecided |
| D-04 | Small model for gate / rewrite / tagger | undecided |
| D-05 | Who may write scope=user facts besides the EA | user-stated only |
| D-06 | Multi-device sync and multi-user scope | out of scope for v2 |
| D-07 | Retention and hard-delete guarantees for "forget" | hard delete |

# 13. Provenance of design choices

Compaction, just-in-time retrieval, note-taking outside context, and sub-agent context isolation follow Anthropic's context-engineering guidance (read via secondary summaries). Temporal fact validity (Zep), ADD/UPDATE/NOOP extraction (Mem0), and recency x importance x relevance ranking (Generative Agents) are from background knowledge and were not re-verified. Competitor notes (OpenClaw, Hermes) came from secondary web sources. Crockpot was not verified. All TUNABLE numbers are unvalidated guesses.
