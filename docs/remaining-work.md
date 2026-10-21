---
doc: remaining-work
version: 2.0
status: active
source_spec: docs/agni-context-memory-spec.md
supersedes: docs/audit-context-memory-spec.md
---

# Remaining work — context, memory, delegation, secure input

The ordered plan for everything the context/memory/delegation work still
needs, and the spec gaps found while checking it against the code.

## Changelog

- **v2** — folded the spec-gap audit into the plan; PR 3 split into 3a/3b/3c;
  stale `docs/audit-context-memory-spec.md` superseded by this document.

---

## 0. How to use this document

- **One PR at a time.** Each PR below is independently shippable and must leave
  `main` green. Do not start PR *n+1* before PR *n* merges.
- **The spec is the requirement source.** `docs/agni-context-memory-spec.md` is
  the authoritative requirement list (copied verbatim from the original
  spec). This document is the *plan* against it, not a replacement.
- **The old audit is dead.** `docs/audit-context-memory-spec.md` was written
  against `eb56aac` and predates the memory/delegation/secure-input work. It
  is marked as superseded. Do not use it as a source of truth.
- **Every PR carries its own acceptance tests.** A PR without a test that
  fails before it and passes after it is not done.
- **Definition of done, every PR:**
  - [ ] `bun run typecheck` green
  - [ ] `bun run test` green
  - [ ] `bun run test:web` green
  - [ ] Protocol changes land in `packages/protocol` first, then
        `docs/protocol.md`
  - [ ] Numbered migration appended in `apps/server/src/db/migrations.ts`;
        never edit an applied migration
  - [ ] No secrets in diff, logs, tests, or fixtures
  - [ ] Canary scan green (see §4.1)
  - [ ] Manual QA note attached to the PR

---

## 1. Design principles (non-negotiable)

1. **The instant lane stays instant.** One model call, no tools, bounded
   prompt. No retrieval, no tagger, no model-based rewrite on that path.
   If a change makes quick questions slower, it is a bug.
2. **Secrets never enter model context, transcripts, `tool_calls`, logs, or the
   replay frame log.** They are process-local, one-time, command-bound, and
   expire.
3. **One caller-filter for `scope` and `visibility`.** Both are enforced in the
   query layer by the same filter, never by prompt wording, and never by two
   separate mechanisms that can drift.
4. **One redaction choke point.** Every path that can carry another agent's
   text — tool results, task frames, artifacts, FTS, summaries, `expand`,
   logs — resolves through `redactForCaller`. A new sink added without a
   choke point is a leak.
5. **Memory is untrusted data, not truth.** Recalled content is data. The
   agent reopens the source system for consequential decisions.
6. **Approval gates are policy, not a security boundary.** They reduce
   mistakes; they do not make an action safe by construction. Treat any
   "auto review" classifier the same way.
7. **No unlimited autonomous spend.** Every background path has a budget, and
   the owner can see what it cost.
8. **Tool and web output never becomes a fact about the user.** Only
   user-stated (or verified) content may create `scope=user` facts. This is a
   prompt-injection defence, not a nicety.
9. **Hard delete means hard delete.** "Forget" removes the fact, its version
   chain, its summary, its FTS rows and its embedding.
10. **No IDE features, ever.** Coding work is delegated through ACP when the
    bridge exists; Agni does not grow an LSP, an index, or an editor.

---

## 2. Decisions

Settled. Recorded so they are not relitigated.

| ID | Decision | Status | Notes |
|---|---|---|---|
| D-01 | Default agent visibility to the EA: `summary` | settled | `private` = receipt only, `summary` = one line / 240 chars, `shared` = full text |
| D-02 | Embeddings: local model (LM Studio / Ollama) | settled | Embedder is optional; FTS-only fallback when it is down |
| D-03 | Vector store: SQLite `BLOB` + cosine in JS | settled | Personal scale; `sqlite-vec` only if measured latency demands it |
| D-04 | Small model for gate / rewrite / tagger | deferred | Rules first. A small model is added only if an eval shows rules are insufficient, and it must not run on the instant lane |
| D-05 | Who may write `scope=user` facts | settled | User-stated (or verified) content only |
| D-06 | Multi-device sync and multi-user scope | settled | Out of scope for v2 |
| D-07 | Retention and hard-delete guarantees | settled | Hard delete across facts, summaries, FTS and embeddings |
| D-08 | **ROL-001 block scope** | settled | Blocks are **per conversation**, not per channel. The code is right; the spec is corrected. Per-channel blocks would need a large migration for no user-visible gain |
| D-09 | **DEL-001 async path** | settled | `delegate_task` is the async path; `handoff` stays synchronous. The spec is corrected to say so |
| D-10 | **C-04 handoff thread** | settled | `handoff` spawns the child in **its own thread**, not the same thread. The spec's "same thread" wording is corrected |
| D-11 | GATE-001 latency budget enforcement | settled | p95 budget ~150 ms **warns on CI** (noisy machines) and **fails on the nightly eval run** |

---

## 3. Where we are today

Already shipped in the memory/delegation/secure-input work:

- Slot-based context assembler with budgets, and a per-turn topic anchor
  (`apps/server/src/context/compiler.ts`).
- Synchronous rule-based turn gate with salience; ephemeral turns stay in the
  transcript and are excluded from compaction
  (`apps/server/src/agent/gate.ts`).
- Memory schema columns (validity, supersession, provenance, ranking),
  supersession instead of silent overwrite, hard delete of the version chain
  (`apps/server/src/stores/agent-memories.ts`).
- Async delegation: `delegate_task`, `delegate_wait`, `task_status`,
  `task_cancel`, duplicate guard, cancellation, task rows with owner and
  origin.
- Mention routing, hidden roster, `@agni` special case.
- Per-agent `memory_scope`; new agents are read-only for user memory.
- One-time secret broker, `run_privileged`, web `SecretCard`, CLI `/secret`,
  output redaction, secret-free transcripts and logs.
- `say` for separate progress bubbles; background jobs and delegation.

Not yet done, and not yet enforced anywhere in code:

- `agents.visibility` and `agent_memories.visibility` exist as columns.
  **Nothing reads them.** `handoff` still returns the specialist's full text.
- `needs_input` exists as a state. **Nothing sets it.**
- Async completion raises a `notify`. It does not wake the parent thread.
- `recall_fact` is a `LIKE` substring search. There is no FTS and no vector
  index on `agent_memories` or `channel_messages`.

---

## 4. Sequenced PRs

### 4.1 PR 1 — Visibility choke point and leak gate

**Goal:** make `visibility` and `scope` real, in one place, and prove it.

**Checklist**

- [ ] Add `visibility` to `Persona`, `ResolvedPersona`, `AgentInfoSchema`,
      `loadRuntimeAgents`, `personaInfo`, `mentionRoster`, `create_agent`,
      `update_agent`.
- [ ] Add **one** `redactForCaller(text, ownerAgentID, callerAgentID)` helper
      and **one** `taskView` / `handoffView` serializer. Every surface that
      can carry another agent's text goes through it:
  - [ ] `handoff`, `delegate_task`, `delegate_wait`, `task_status`
  - [ ] `task.updated` frames and the parent wake payload
  - [ ] artifacts (`artifact_ref` resolution — designed in PR 2, filtered
        from day one)
  - [ ] FTS and `transcript_search` query filters
  - [ ] rollover and compactor summaries
  - [ ] `expand`
  - [ ] logs (IDs, counts and kinds only — never message text)
- [ ] Semantics: `private` → receipt only; `summary` → one line / 240 chars;
      `shared` → full text; the owner always gets full text.
- [ ] Add `TaskInfo.resultRedacted` (or `visibility`) so clients can explain
      why text is absent.
- [ ] **One caller-filter** for `scope` *and* `visibility`, used by
      `listAgentMemories`, `recall_fact`, FTS queries, `transcript_search`,
      `expand` and artifact resolution. `scope=agent` content is unreadable by
      other agents.
- [ ] Add `visibility` / `source` / `confidence` to `AgentMemoryInput` so
      writers stop hardcoding `shared` / `user`.
- [ ] EVAL-004 **moves here** (from PR 7), with canary strings in the
      fixture. Canaries must be checked in every sink above, including the
      artifact store and the logs.
- [ ] Canary scan script (`bun run scan:canary`) that greps the DB, the frame
      log and the artifacts table for the fixture canaries after a run.

**Acceptance tests**

- [ ] A private specialist's text is absent from: parent tool results, task
      frames, FTS, `transcript_search`, `expand`, rollover/compactor
      summaries, artifacts, and logs.
- [ ] `summary` returns at most one line / 240 chars; `shared` returns full
      text; the owner always gets full text.
- [ ] `scope=agent` memory is unreadable by another agent (canary).
- [ ] EVAL-004 runs in CI.

**Risk:** medium. This changes tool-result shapes, so prompt wording in
`agent/prompts.ts` and `agent/task-loop.ts` needs a pass.

---

### 4.2 PR 2 — Delegation lifecycle

**Goal:** a delegated task can ask a question and be answered, and the parent
is woken exactly once with the result.

**Checklist**

- [ ] Migration: `tasks.child_thread_id`, `pending_question`,
      `pending_question_id`, `parent_thread_id`, `parent_channel_id`,
      `result_delivered_at`.
- [ ] New client frame `task.answer` (`{ taskID, questionID, text }`) and a
      server reply (`task.answer.ok` / `task.updated`).
  - [ ] Accepted only when `delegate_state='needs_input'` and `questionID`
        matches.
  - [ ] Idempotent on `(taskID, questionID)`; the answer is accepted once.
  - [ ] `msg.send` is **not** overloaded: a normal message must never resume
        a task.
- [ ] `request_owner_input` tool, available only in delegated turns:
  - [ ] sets `needs_input`, persists the question, posts `msg.new` with
        `uiHint: "needs_input"` plus `taskID` and `questionID`, and ends the
        turn without marking the task failed.
- [ ] Resume path: the answer is appended to the child thread, the pending
      question is cleared, and a resume job is enqueued.
- [ ] **Parent wake**, with the claim and the enqueue in one transaction:
  - [ ] `UPDATE tasks SET result_delivered_at=? WHERE id=? AND
        result_delivered_at IS NULL`
  - [ ] the wake job is inserted in the same transaction, so a crash cannot
        leave a claimed-but-never-woken task.
  - [ ] completions that land close together are **coalesced** into one wake
        turn per parent thread.
  - [ ] if the parent turn is still running, the wake waits rather than
        racing it.
  - [ ] visibility applies: a `private` task wakes with a receipt, not the
        result.
- [ ] **`artifact_ref`** (DEL-004): a new table holds the full result; the
      task row keeps a short summary.
  - [ ] artifacts resolve **only** through `redactForCaller`.
  - [ ] artifacts are in the PR 1 canary scan.
  - [ ] only the summary enters the EA context.
- [ ] Status policy (DEL-006): start (if the work is long), `needs_input`,
      done, failed — each filtered by visibility.
- [ ] Remove `fact_ids` from `DelegationBrief`; it returns in PR 3c with
      `get_fact`.
- [ ] `bind_direct`: a dedicated frame plus client routing state, so a client
      can pin a conversation to an agent DM.

**Acceptance tests**

- [ ] An answer that arrives before the question is rejected.
- [ ] A duplicate answer is a no-op.
- [ ] A normal `msg.send` does not resume a task.
- [ ] A crash between claim and wake still wakes the parent exactly once.
- [ ] Three completions in quick succession produce one wake turn.
- [ ] A `private` task's wake contains no specialist text.
- [ ] The full result is retrievable by the owner and invisible to the parent
      for a `private` task.

**Risk:** medium-high. Touches the job runner, the task store and the
protocol.

---

### 4.3 PR 3a — FTS, ranking, and the no-inject rule

**Goal:** real retrieval over facts and transcripts, with ranking that
actually moves, and a hard floor on what gets injected.

**Checklist**

- [ ] FTS5 tables and triggers for `agent_memories` and `channel_messages`,
      with `agent_id` / `visibility` columns available to the caller-filter.
- [ ] `recall_fact` uses FTS + `bm25()`; `LIKE` survives only as a fallback
      for very short queries.
- [ ] `markMemoryUsed` updates `last_used_at` and `use_count` whenever a
      memory is recalled — otherwise the ranking formula is dead code.
- [ ] Ranking per spec:
      `score = relevance * recency_decay(last_used_at) * salience * (1 +
      log(1 + use_count))`
- [ ] `transcript_search` (task lane only) with the caller-filter applied.
- [ ] **ASM-004 no-inject rule:** a retrieval whose best score is below the
      confidence threshold injects **nothing**. No partial, no "best effort".
- [ ] Confidence threshold is configurable.
- [ ] Slot budgets (ASM-007) become configuration, with validation against the
      model context window.
- [ ] Gate latency benchmark (GATE-001) added: p50/p95, rules-only. Warns on
      CI, fails on the nightly run (D-11).

**Acceptance tests**

- [ ] A planted fact is retrievable by paraphrase, not only exact substring.
- [ ] `last_used_at` and `use_count` change after a recall.
- [ ] A plausible but under-threshold match injects **nothing** (the specific
      case, not just an empty corpus).
- [ ] A `scope=agent` fact never appears in another agent's recall.
- [ ] Instant-lane latency is unchanged.

**Risk:** low-medium. Mostly additive; the ranking change is visible in
recall quality.

---

### 4.4 PR 3b — Tagger, source policy, confidence, conflict flag

**Goal:** memory is written by a validated, scheduled tagger that cannot turn
tool output into facts about the user.

**Checklist**

- [ ] Strict Zod schema for a tagged item
      (`kind`, `text`, `scope`, `visibility`, `source`, `salience`,
      `confidence`, `entities`, `ttl`, `source_turn_ids`).
  - [ ] Invalid items are dropped **and logged**, never stored, never
        silently skipped.
- [ ] **Async schedule** (spec §6): micro-batches every K turns or on idle;
      immediate only for `explicit_remember` and task creation. Never on the
      instant lane.
- [ ] **TAG-002 source policy (security item).** Only `source=user` or
      verified content may create `scope=user` facts. Tool, web and email
      content must not become facts about the owner.
- [ ] Confidence threshold (TUNABLE 0.6): items below it stay in the
      transcript only and are not promoted.
- [ ] Calibration check: a small labelled fixture set, with a precision /
      recall report and a justified threshold. A threshold that promotes
      everything or nothing is not shipped.
- [ ] Ephemeral turns produce zero items.
- [ ] **Conflict flag.** Newest user-stated fact wins, the old one is closed,
      and the conflict is recorded and surfaced for review instead of being
      resolved silently.
- [ ] Writers populate `source`, `source_block_id`, `source_turn_ids`,
      `confidence` instead of hardcoding.
- [ ] Tagger spend is metered (feeds EVAL-005).

**Acceptance tests**

- [ ] A web page that says "the user prefers X" never becomes a user fact.
- [ ] A malformed tagger item is logged and not stored.
- [ ] A low-confidence item is not promoted but is still retrievable by id.
- [ ] The calibration report exists and the threshold is justified.
- [ ] A conflicting user statement closes the old fact and raises a flag.

**Risk:** medium. This is the memory-poisoning defence; it deserves the
tests above more than anything else in the plan.

---

### 4.5 PR 3c — Embeddings, consolidation, `expand`, `get_fact`

**Goal:** hybrid retrieval and memory hygiene — after 3a and 3b, never
before, so the consolidator cannot launder bad facts.

**Checklist**

- [ ] Optional embedder (LM Studio / Ollama), local only.
  - [ ] If the embedder is down, recall falls back to FTS-only and does not
        fail.
  - [ ] `embedding_model` / `embedding_dim` metadata; a model change triggers
        re-embedding so vector spaces are never mixed.
- [ ] Cosine similarity over `Float32Array` in JS; hybrid fusion with FTS
      (RRF).
- [ ] Transcript chunks indexed (MEM-003) with turn ids.
- [ ] Consolidation job (MEM-006): dedupe, close superseded facts, archive
      unused low-salience items, promote high-use facts to the pinned
      profile.
  - [ ] Idempotent and bounded.
  - [ ] It cannot resurrect or archive anything a hard delete removed.
- [ ] `expand(channel, turn_from, turn_to)` returning verbatim turns, with the
      caller-filter applied.
- [ ] Summaries and recalled items carry `source_turn_range` (ASM-005).
- [ ] `get_fact` tool; `fact_ids` returns to the brief with it (DEL-003).
- [ ] ASM-003 deictic rewrite: applied only when the message is not
      self-contained, using anchor + last turns, and used for retrieval only
      — the user's words are never rewritten in the transcript.
- [ ] ASM-006 fallback: on low retrieval confidence, use the tail of the
      previous block.

**Acceptance tests**

- [ ] FTS-only recall works with the embedder stopped.
- [ ] Changing the embedding model re-embeds; no mixed vector spaces.
- [ ] A hard-deleted fact is absent from facts, summaries, FTS and vectors.
- [ ] `expand` returns verbatim turns with correct ranges and never crosses
      a visibility boundary.
- [ ] "explain this" retrieves what the explicit rewrite retrieves.

**Risk:** medium. The embedder is optional, so the failure mode is degraded
recall, not an outage.

---

### 4.6 PR 4 — Rollover and continuity

**Goal:** a block never waits for a summary, and never thrashes.

**Checklist**

- [ ] Split `rotate` into `rotateNow` (close and open immediately) and
      `rollover.summarize` (an async job).
  - [ ] `rotateNow` opens the new block with the previous carry plus the
        verbatim tail.
  - [ ] A user turn arriving mid-rollover is served from the old block plus
        any in-flight summary. No user-visible wait (ROL-002).
- [ ] **ROL-004 sweep runs inside `rollover.summarize`**, after `rotateNow` —
      never as a precondition of rotation. A synchronous pre-close re-read
      would put the tagger's latency on the boundary, which the acceptance
      test forbids.
- [ ] ROL-003 trigger: 65% of budget, plus idle gap + topic shift.
  - [ ] **Hysteresis / minimum-gap rule** so a block hovering near the
        threshold cannot thrash. Rotate on crossing; do not rotate again
        until the gap is cleared.
- [ ] Structured summary (ROL-005):
      `{decisions, open_loops, entities, tone, source_turn_range}`, with the
      text summary kept as a fallback.
- [ ] ROL-006 seeding: summary + last ~6 verbatim turns + ledger + anchor.
- [ ] `temp` turns are excluded from summary input; the verbatim tail keeps
      the immediate conversational context.
- [ ] `rollover.summarize` is idempotent on `(closed_thread_id,
      summary_version)`.
- [ ] A second rotation arriving before the first summary lands is handled
      without losing carry.
- [ ] CMP-001 (hierarchical block → day → epoch) is a follow-up, after the
      above is stable.

**Acceptance tests**

- [ ] The new block has the tail immediately after rotation, before any
      summary exists.
- [ ] A second rotation before the first summary does not lose carry.
- [ ] p50 turn latency does not regress at the rollover boundary.
- [ ] A block hovering at the threshold does not rotate repeatedly.
- [ ] Continuity eval (EVAL-003 / EVAL-006) passes after rotation.

**Risk:** medium-high. Rollover is on the critical path of every turn.

---

### 4.7 PR 5 — Secure input hardening

**Goal:** native auth on the computer, and no new leak surface.

**Checklist**

- [ ] `run_privileged` gains an auth mode: `auto | password | os`.
- [ ] macOS `os` path uses `osascript` (`do shell script … with
      administrator privileges`):
  - [ ] the command is written into a **private `mkdtemp` directory** (0700),
        not a bare temp file.
  - [ ] the script is 0700 and is deleted immediately after the run.
  - [ ] the dialog shows the command being authorized, because the approval
        covers the whole script.
  - [ ] no shell interpolation of secrets; the script path is quoted.
  - [ ] `pam_tid.so` is **not** used: it changes system-wide sudo behaviour,
        persists, and does not help over SSH or Tailscale.
- [ ] The askpass path stays for `ssh`, `git` and anything that needs stdin.
- [ ] Keychain (macOS) stores device tokens and provider keys only — never the
      owner's sudo password.
- [ ] Remote/Tailscale: `secret.request` broadcasts to authenticated clients,
      first reply wins, and the `requestID` prevents two clients racing.
- [ ] General human takeover (CAPTCHA, 2FA, payment screens) is **deferred**,
      not in this PR. It widens the secret-handling surface and needs its own
      design pass (see §5).

**Acceptance tests**

- [ ] The temp directory and script are gone after the run.
- [ ] The authorization dialog shows the command.
- [ ] No secret appears in frames, logs, transcripts or tool results.
- [ ] The PTY test still shows no echo.
- [ ] `ssh` / `git` over HTTPS still work through the askpass path.

**Risk:** medium. macOS-specific, so CI cannot cover it — the manual QA note
matters more here than usual.

---

### 4.8 PR 6 — Presence, progress, rich transcript

**Goal:** the UI shows what is happening without the model having to narrate
it.

**Checklist**

- [ ] Surface `tool.start` / `tool.end` as an automatic activity strip in web
      and Mac. Progress should not depend on the model calling `say`.
- [ ] `say` stays for semantic milestones ("fetched the invoice, now
      reconciling"), not for every tool call.
- [ ] A `task_result` / `final` UI hint so the final answer is visually
      separate from progress.
- [ ] Presence states on the agent avatar: idle, working, waiting, blocked.
- [ ] Interrupt handling: a user message takes priority over queued
      background updates for the same agent.
- [ ] Rich transcript: drafts, approvals, files and cards inline.
- [ ] If a long final answer arrives with no `say` at all, split it at
      paragraph boundaries — presentation only; the model's content is not
      rewritten.

**Acceptance tests**

- [ ] A long tool-heavy task shows automatic activity plus `say` updates.
- [ ] The final answer is visually separate, not one wall of text.
- [ ] A user message during a busy turn is answered before queued background
      work.

---

### 4.9 PR 7 — Evals

**Goal:** the numbers that the TUNABLE values in the spec are guessing at.

**Checklist**

- [ ] Eval harness under `evals/`, deterministic with the mock provider;
      optional real-provider run at night.
- [ ] **EVAL-001 (needle):** plant facts early in a 200+ turn channel, force
      2–3 rollovers, ask vague follow-ups ("explain this", "what did we decide
      earlier?"). Report recall rate.
- [ ] **EVAL-002 (gate):** measure durable facts the gate misses and the
      rollover sweep catches.
- [ ] **EVAL-003 (continuity):** ephemeral follow-ups ("and tomorrow?")
      succeed.
- [ ] **EVAL-004 (leak):** private DM and `scope=agent` content never appear
      in EA answers or EA prompts. **Landed in PR 1**; PR 7 grows it into the
      full regression suite.
- [ ] **EVAL-005 (cost):** tokens per turn, tagger spend per 100 turns, p95
      reply latency with and without retrieval/rewrite.
- [ ] **EVAL-006 (drift):** answer quality from summary versus from source
      after N rollovers.
- [ ] Nightly run; cost and latency reported, not just pass/fail.
- [ ] GATE-001 latency budget: **warn on CI, fail on the nightly run**
      (D-11).

**Acceptance tests**

- [ ] The harness runs green on a clean checkout.
- [ ] A regression that breaks a published metric fails the nightly run.

---

### 4.10 PR 8 — Memory transparency UI

**Goal:** let the owner see what Agni has remembered, and eventually correct
it. Pulled forward directly after PR 3a, because it is the second consumer
of the caller-filter and needs the same visibility rules.

**Checklist**

- [ ] Read-only memory view: list items with scope, visibility, source,
      confidence, salience, `last_used_at` — filtered by the **same**
      caller-filter as retrieval.
- [ ] No canary may appear in a view the caller is not allowed to see.
- [ ] Edit and delete are a later increment; the read view ships first.
- [ ] Export in a stable, documented format.

**Acceptance tests**

- [ ] A `scope=agent` item is not listed to another agent.
- [ ] The view shows exactly what retrieval can use.

---

## 5. Backlog / product direction (unscheduled)

**Not scheduled. Not in the plan above.** These came from a description of
another product, not from the spec or from a stated need. Adopt them one at a
time, deliberately, when the feature is actually wanted.

Two of them need design **before** they are scheduled, because they widen a
security surface that PR 1 and PR 5 are hardening:

- **Per-agent browser / workspace isolation.** If Agni ever drives a browser
  or a computer, isolation has to be per agent. The product this came from
  shares one machine across all of its agents and says so; that is a
  concentration of risk, not a pattern to copy. Visibility is a filter, not
  a boundary.
- **General human takeover (CAPTCHA, 2FA, payment screens).** Agni's secret
  broker is the narrow, safe version. Takeover means handing over a live
  session, which is a much larger surface than handing over one string.

Unscheduled ideas:

- [ ] Event-driven routines: webhooks, GitHub, Slack, email — today only
      `job_schedule` (clocks) exists.
- [ ] Group chats / project rooms: several agents in one room with shared
      project context, while each keeps its own memory.
- [ ] Skills learned by demonstration, with versioning and failure detection
      (a routine whose assumptions broke should say so).
- [ ] Cost controls: per-task and per-agent budgets, spend dashboard,
      forecasts, itemized usage. The usage ledger exists; the surface does
      not.
- [ ] Per-agent model choice, exposed from the existing router.
- [ ] Audit log / action recording for sensitive actions and who approved
      them.
- [ ] Voice input, richer artifacts (slides, images), native calendar and
      reminders integrations.
- [ ] Android / mobile surface (P5 in the blueprint).
- [ ] Multi-user team memory (out of scope under D-06).

---

## 6. Spec coverage map

Spec IDs from `docs/agni-context-memory-spec.md`, and where each lands.

| ID | Status today | Lands in |
|---|---|---|
| RTE-001 | EXISTS | — |
| RTE-002 | PARTIAL (no leak test) | PR 1 |
| RTE-003 | EXISTS | — |
| RTE-004 | schema only, unenforced | PR 1 |
| GATE-001 | rules-only, no benchmark | PR 3a (benchmark), PR 7 (enforcement) |
| GATE-002 | EXISTS | — |
| GATE-003 | EXISTS | — |
| ASM-001 | EXISTS | — |
| ASM-002 | EXISTS | — |
| ASM-003 | MISSING | PR 3c |
| ASM-004 | MISSING (no retrieval) | PR 3a (no-inject), PR 3c (hybrid) |
| ASM-005 | MISSING | PR 3c |
| ASM-006 | MISSING | PR 3c |
| ASM-007 | constants | PR 3a |
| TAG-001 | loose JSON | PR 3b |
| TAG-002 | MISSING (security) | PR 3b |
| TAG-003 | MISSING | PR 3b |
| TAG-004 | partial (compaction only) | PR 3b |
| MEM-001 | EXISTS | — |
| MEM-002 | partial (no conflict flag) | PR 3b |
| MEM-003 | MISSING | PR 3a (FTS), PR 3c (vectors) |
| MEM-004 | scope only, no visibility | PR 1 |
| MEM-005 | facts only | PR 3c |
| MEM-006 | MISSING | PR 3c |
| ROL-001 | per conversation (by D-08) | spec corrected |
| ROL-002 | synchronous | PR 4 |
| ROL-003 | char count | PR 4 |
| ROL-004 | opportunistic | PR 4 (inside `rollover.summarize`) |
| ROL-005 | free text | PR 4 |
| ROL-006 | summary only | PR 4 |
| CMP-001 | MISSING | PR 4 follow-up |
| DEL-001 | `delegate_task` async (by D-09) | spec corrected |
| DEL-002 | EXISTS | — |
| DEL-003 | no `fact_ids` | PR 3c |
| DEL-004 | MISSING | PR 2 |
| DEL-005 | EXISTS | — |
| DEL-006 | partial | PR 2 |
| DEL-007 | EXISTS | — |
| EVAL-001..003 | MISSING | PR 7 |
| EVAL-004 | MISSING | PR 1, extended in PR 7 |
| EVAL-005..006 | MISSING | PR 7 |

---

## 7. Process notes

- This document is committed **before PR 1** starts.
- Every PR updates the changelog at the top of this file and the coverage map
  in §6 as it lands.
- `docs/audit-context-memory-spec.md` is marked as superseded. It stays for
  history and for the reasoning behind the early build order, but it is not a
  source of truth and must not be used to size remaining work.
- The spec itself is not edited in place; changes to requirements are made
  here as a decision row in §2, and the spec is corrected separately when the
  decision is D-08, D-09 or D-10 shaped.
