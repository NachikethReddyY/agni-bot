# Routines: build plan (for Haiku)

Status: BUILT on feat/agnibot-routines, not merged.

Written 2026-10-27 from a read of the code, so every "exists" claim below was
checked. Read `AGENTS.md` first.

A **Routine** is a recurring background job owned by a bot. Each run first
does a zero-token change check; only if something changed does it wake the bot
with the previous run's state, under a time and token budget. Reports land in
the bot's one continuous conversation, and the right-hand Inspector panel
lists every routine with its details. "Routines" is the feature name. Never
call a bot "AgniBot"; the product is Agni Bot, bots have their own names.

## 0. Decisions (the original brief conflicted with the repo)

| Brief said | Repo reality | Plan does this |
| --- | --- | --- |
| PostgreSQL, `FOR UPDATE SKIP LOCKED`, JSONB | SQLite via `bun:sqlite`; `claimDueJob` in `stores/jobs.ts` is already a transactional claim | SQLite. TEXT columns holding JSON. Reuse the job queue. No new scheduler. |
| New tick loop | `JobRunner` (`jobs/runner.ts`) already polls, claims, retries, supports recurring via `nextRunAt` | One job kind, `routine`, one job row per routine. |
| `maxTokenBudgetUsd` | `usage_ledger` stores tokens only; no price table | `maxTokens`. USD is out of scope. |
| Delivery to Telegram, Discord, Webhook, In-App | Discord/Slack are planned, not built (`AGENTS.md`). No Telegram. | v1 delivers **in-app only**. Webhook returns in PR 2 together with an owner-only way to set it. |
| Crystallize 3 successes into generated TS/Python | Executing generated code is shell/file-write: approval-gated by hard rule | **Split to PR 2.** v1 only records each run's tool-call trace. |
| `allowedDomains` enforced "in-process" | Only our own web tools can be gated; `bash` cannot | Routine runs get a read-only tool allowlist; web tools are domain-checked. |
| Shell pre-flight check | Shell is approval-gated | v1 pre-flight kinds: `http`, `sql`. `shell` deferred. |
| Competitor benchmark table | Checked against the cited pages 2026-10-27; several cells were wrong or unsupported | See section 7. |

Owner decisions:

1. Cron parsing: **`croner`** approved (2026-10-27). Checked 2026-10-27 in a
   scratch dir: v11.0.0 installs and runs under Bun; a daily 09:00 stays
   09:00 local across New York spring-forward; 01:30 on fall-back day fires
   once; a nonexistent 02:30 on spring-forward day fires at 03:00. It also
   **accepts 6-field (seconds) expressions**, so Agni must reject them.
2. Misfire policy default: **`run_once`**. The job queue already runs overdue
   jobs on claim, so this is zero extra code, and the Phase 0 gate makes
   catching up free when nothing changed. `skip` is a per-routine opt-in.
3. Owner-only settings: the `routine_create` tool always creates a routine
   with an empty `allowedDomains`. A bot that has read untrusted input must
   not widen its own egress. (Approved 2026-10-27.)
4. Minimum cron period: **5 minutes**, rejected below that at creation.
5. Reports go in the bot's **one continuous conversation**, and the
   Inspector's Routines section shows the list and details (approved
   2026-10-27, section 5).
6. Crystallization (PR 2): replay a recorded tool recipe as JSON, not generated code.

## 1. Orchestration rules

- Branch `feat/agnibot-routines`, one worktree. Do not create worktrees.
- Call `orchestrator_capabilities` once before dispatching. If a provider the
  brief names (opencode, codex, kilo) is unavailable, stop and tell the owner.
  Do not substitute silently.
- Haiku writes `apps/server/src/routines/types.ts` first (section 2), commits
  it, then dispatches. Workers never edit `types.ts`; they ask for a change.
- Each worker owns exactly the files listed for its wave. Two workers never
  touch the same file. Shared files (`migrations.ts`, `registry.ts`,
  `task-registry.ts`, `dispatch.ts`) are edited **only by Wave 3**.
- After each wave, Haiku runs `bun run typecheck` and
  `bun test apps/server packages/protocol`. After Wave 4 also
  `bun run test:web` (client and web Vitest). Do
  not start the next wave on red.
- Commit per wave, Conventional Commits, body wrapped at 72, ending with the
  Co-Authored-By line from the session.
- A final `sonnet` thread reviews and writes the PR. Haiku does not write
  implementation code beyond `types.ts`.

## 2. Shared contract: `apps/server/src/routines/types.ts`

The job row is the single source of truth for **enabled** and **next run**
(`jobs.enabled`, `jobs.run_at`). The existing `job.set` (pause, resume, run
now) and `job.delete` frames already act on it, so the routine row stores
neither.

```ts
export type MisfirePolicy = "skip" | "run_once";
export type Preflight =
  | { kind: "http"; url: string }                 // compares ETag, else status+body hash
  | { kind: "sql"; query: string }                // read-only SELECT on the Agni DB
  | { kind: "none" };                             // always counts as changed
export type RunOutcome = "ran" | "skipped_no_delta" | "failed" | "timed_out" | "budget_exceeded";

export interface Routine {
  id: string; jobID: string; agentID: string; name: string; prompt: string;
  cron: string; timezone: string; misfire: MisfirePolicy; // default "run_once"
  preflight: Preflight;
  maxTokens: number; maxExecutionMs: number; allowedDomains: string[];
  threadID: string | null;   // the session block reports land in, created on first run
  lastStateHash: string | null; stateContext: unknown; // JSON text on disk
  successStreak: number; failureStreak: number;
  createdAt: string; updatedAt: string;
}
export interface RoutineRun {
  id: string; routineID: string; startedAt: string; finishedAt: string | null;
  outcome: RunOutcome; tokens: number;
  summary: string | null; toolTrace: string | null; error: string | null;
}
```

Defaults: `maxTokens` **16 000** (the task loop's own `MAX_TOKENS`; a larger
value would be silently capped), `maxExecutionMs` 120 000, `allowedDomains`
empty (= web tools refuse everything). All validated at the tool boundary
(positive, capped).

## 3. Wave 1: pure logic and contract (parallel, no shared files)

| Worker | Owns | Does |
| --- | --- | --- |
| A | `routines/cron.ts`, `test/routines-cron.test.ts` | `nextRun(cron, tz, after: Date): Date` using `croner`, and `validateCron(cron, tz)`. Reject anything that is not exactly 5 fields (croner accepts 6). Enforce the 5-minute minimum by checking the gap between the next 10 runs, not just the first two (`0,2 * * * *` has a 2-minute gap). Tests, with the values already observed: `30 2 * * *` after `2026-03-08T00:00Z` in `America/New_York` → `2026-03-08T07:00Z`; `30 1 * * *` after `2026-10-31T12:00Z` → `2026-11-01T05:30Z` then `2026-11-02T06:30Z` (once, not twice); `*/5`; weekday list; invalid input throws; 6-field rejected; `*/2 * * * *` rejected. If `croner` behaves differently, stop and report; do not hand-roll around it. |
| B | `routines/preflight.ts`, `test/routines-preflight.test.ts` | `runPreflight(p, db, lastHash): {changed: boolean; hash: string}`. `http`: reuse the host safety checks in `tools/fetch-url.ts` (export `assertPublicHost`, nothing else changes), 5 s timeout, hash `etag` if present else SHA-256 of status + first 1 MB. `sql`: open a **separate read-only** connection to the same DB file, accept a single `SELECT` only (reject `;`, `PRAGMA`, `ATTACH`, writes), SHA-256 of `JSON.stringify(rows)`. Hash with `Bun.CryptoHasher("sha256")`. Tests: unchanged hash → `changed:false`; a write statement is rejected. |
| C | `routines/egress.ts`, `test/routines-egress.test.ts` | `domainAllowed(url, allowed[])`: exact host or subdomain match, https/http only. Tests: `evil.com` vs `a.evil.com.attacker.net`, empty list denies all. |
| F | `packages/protocol/src/frames.ts`, `docs/protocol.md`, a protocol test | Additive only: give `JobInfoSchema` (line 158) an optional `routine` field, exactly like `task.list.ok` carries optional `lists`. Shape: `{ name, cron, timezone, misfire, preflight: "http"\|"sql"\|"none", maxTokens, maxExecutionMs, allowedDomains: string[], successStreak, failureStreak, recentRuns: { at, outcome, tokens, summary? }[] }` (last 5 runs). **No new frame, no `PROTOCOL_VERSION` bump** (`docs/protocol.md` §Versioning: optional fields are additive). Add a short "Routines (additive v2 extension)" note to the doc. Test: a frame with and without `routine` both parse. The Swift client ignores unknown fields, so `apps/mac` is untouched. |

## 4. Wave 2: persistence and execution (2 workers)

| Worker | Owns | Does |
| --- | --- | --- |
| D | `stores/routines.ts`, `test/routines-store.test.ts` | CRUD, `recordRun` (prunes to the newest **50** runs per routine), `listRuns(routineID, limit)`, `setState(...)`. `newID("rtn")` / `newID("run")` and `nowISO()` from `util/ids.ts`. Parameterised SQL only. Tests create tables from the migration SQL, so **D waits for step 5.1**. |
| E | `routines/run.ts`, `routines/prompt.ts`, `test/routines-run.test.ts`, and the additive edit to `agent/task-loop.ts` | `executeRoutine(deps, routine): RoutineRun` implementing the phases below. |

`executeRoutine`, in order:

1. **Phase 0.** `runPreflight`. If `!changed` → run row `skipped_no_delta`,
   tokens 0, **no model call**, **nothing posted to the conversation**,
   streaks unchanged. This is the headline guarantee; the test asserts the
   router is never called. Silent skips are also what keeps the chat quiet.
2. **Phase 1.** Call `runTaskTurn` (`agent/task-loop.ts:240`).
   - Thread: on first run create the routine's session block exactly as
     `jobs/turn.ts:148-160` does (`ensureConversation` at 152,
     `backgroundSession` at 153), save it as `routine.threadID`, and reuse it
     on every later run, so reports stay in the bot's conversation. Copy how
     `turn.ts` builds `persona` (line 139) and how it passes
     `conversationID`, `carrySummary` and `channelID` to `runTaskTurn`
     (line 345).
   - Prompt = routine prompt + `stateContext` as a fenced JSON block labelled
     data. Web/tool output is data, never instructions; `stateContext` is
     never concatenated into the instruction part.
   - `runTaskTurn` builds its own tool registry (`task-loop.ts:297`) and the
     model's tools come from `effectiveTools` (line 306): `persona.tools`
     **plus `say`, `ask` and `run_privileged` added for every agent**. `ask`
     waits for the owner, so an unattended routine would hang on it. E makes a
     small, additive edit to `task-loop.ts` (only E touches it) adding three
     optional fields to `TaskTurnRun`: `toolAllowlist?: string[]`, which when
     set makes `effectiveTools` exactly `toolAllowlist ∩ persona.tools` (least
     privilege: a routine never gets a tool its bot lacks) and skips the
     universal additions. `executeTool` (line 867) also refuses any name not
     in `effectiveTools`, so a prompt-injected call to `mail_send` is
     rejected even if the model names it. Other fields: `maxTokens?: number` (replaces the
     `MAX_TOKENS` constant in the loop condition at line 504 when set,
     capped at the constant, so the budget is a real in-loop cap), and
     `allowedDomains?: string[]` (applied to `web_fetch` and `web_search` via
     `domainAllowed`). With none set, behaviour must be unchanged; existing
     task-loop tests stay green.
   - Time: `signal = AbortSignal.timeout(maxExecutionMs)`; the loop's own
     `turnTimeoutMs` (line 451) still applies, so the smaller wins.
   - **Tool allowlist (not a denylist):** `memory_search`,
     `transcript_search`, `links_search`, `tasks_list`, `grep`, `glob`,
     `read_file`, `web_search`, `web_fetch`, `mail_search`, `mail_read`,
     `recall_fact`, `skills_list`, `skills_load`, `skills_resource`. Out on
     purpose: `mail_send` (Agni's own mailbox sends are ungated and a routine
     reads untrusted mail), `bash`/`secure_exec`/`write_file`, `handoff`,
     `job_schedule`/`routine_*` (a routine must not create routines),
     `deep_research` (its fetches would bypass the allowlist).
   - Over budget → `budget_exceeded`; abort → `timed_out`.
3. **Phase 2.** The bot is told to end with a fenced `json` block holding
   `{ "stateContext": ... }`. Parse it; if absent or invalid, keep the old
   state and mark the run `ran` with a warning, never lose prior state.
   Persist state, `lastStateHash` from the Phase 0 hash, `successStreak` +1 on
   success (`failureStreak` 0), the reverse on failure. Save `toolTrace`
   (tool names + args) for PR 2, and a 200-char `summary`. Emit a `notify`
   frame with `threadID` (`frames.ts:628`).
4. **Auto-pause (borrowed from Grok Bot's pause-after-absence):** after **5**
   consecutive failures set `jobs.enabled = 0` via `setJobEnabled`, emit a
   `notify` ("Routine <name> paused after 5 failures"), so a broken routine
   cannot burn tokens forever.

Known risk, decided: the state block will appear in the chat message.
`runTaskTurn` streams and logs the assistant text itself, and the code has no
function that edits a message's content (only flag updates such as
`compacted`, `tagged_at`). Stripping it would need a new `UPDATE` on the
`messages` table and would still not hide the text already streamed live. So
v1 leaves it visible: tell the bot to label it `Routine state (used next
run)` and keep it under 1 KB. Do not add a tool or a protocol frame to hide
it. The owner can decide later.

## 5. Wave 3: integration (Haiku or one worker; sole owner of shared files)

5.1 `db/migrations.ts`: append **migration 41**: `routines` and
`routine_runs` tables (columns match `types.ts`; JSON as TEXT; unique index
on `routines(job_id)`; index on `routine_runs(routine_id, started_at)`).
Never edit applied migrations. Update "currently 40" in `AGENTS.md` to 41.

5.2 `jobs/routine.ts`: `registerRoutineJob(runner, deps)`. The handler loads
the routine by `payload.routineID`; if it is gone, return with no
`nextRunAt` (the job finishes). Misfire: only `skip` needs code: if
`job.run_at` is older than one cron period, record nothing and just advance.
Call `executeRoutine`, return `{ nextRunAt: nextRun(...) }` so the existing
recurring path re-queues it. Register in `jobs/registry.ts`
(`test/jobs-registry.test.ts` fails on any enqueued kind with no handler).

5.3 `tools/routines-tool.ts`: `routine_create`, `routine_list`,
`routine_pause`, `routine_delete`, modelled on `tools/jobs-tool.ts` (same
`objectSchema`, same `ctx.peerInput` refusal). `routine_create` leaves
`allowedDomains` empty (decision 3), validates cron (5-minute minimum),
timezone (`Intl.supportedValuesOf("timeZone")`), URL and SQL via the Wave 1
validators, inserts the row, then `enqueueJob({kind:"routine",
payload:{routineID}, runAt})`. Register in `tools/task-registry.ts`
(`TASK_TOOL_NAMES` and the builder).

5.4 `ws/dispatch.ts` (this is what feeds the panel):
- `jobInfo()` (line 1458) and `turnPayload()` only understand `kind ===
  "turn"`. Add a `routine` branch: `title` = routine name, `threadID`, and the
  new optional `routine` object with the last 5 runs.
- `handleJobDelete` (`ws/dispatch.ts`, ~line 1286) deletes only the job row. For
  `kind === "routine"` it must also delete the `routines` row and its runs,
  or they are orphaned.
- `job.set` pause/resume/run already works on the job row; no change.

5.5 Boot: confirm `requeueStuckJobs` already covers a routine running when the
daemon died. No new code expected; add one test.

5.6 `docs/routines.md` (what it does, defaults, limits, what is not built)
and set the `docs/README.md` row to CURRENT once merged.

## 6. Wave 4: right-panel UI (one worker)

Owns `apps/web/src/components/InspectorView.tsx`, the `.routine-row` styles in
`apps/web/src/styles/app.css`, and a new vitest file in `apps/web/test/`
(existing tests there: `app.test.tsx`, `message-row.test.tsx`, ...). The "Routines" section (InspectorView
lines 98-125) and `RoutineRow` (line 319) already render `job.list.ok`, with
pause/resume/run-now wired through `job.set`. Routines are jobs, so they
appear there with no new plumbing. This wave adds the details:

- Routine rows (jobs with `routine` set) show: name, human cadence from the
  cron expression and timezone, next run, last outcome, and a streak.
- Clicking a row expands it: status of the last 5 runs (outcome, time,
  tokens, 200-char summary), config (pre-flight kind, `maxTokens`,
  `maxExecutionMs`, allowed domains or "none"), and Pause/Resume, Run now,
  Delete using the existing `job.set` / `job.delete`. Full reports are in
  the conversation, so the row links to `threadID`.
- Show "N of last M runs skipped, 0 tokens", computed client-side from
  `recentRuns`. It is the visible proof of the Phase 0 gate.
- Performance over polish (`AGENTS.md`): no new store or fetch, no animation
  library. Reuse `format.*` helpers and existing classes.
- The empty-note text mentions only the CLI; add "or ask your bot to create
  one".

Tests: render a routine job with and without `recentRuns`; a non-routine job
renders exactly as before.

## 7. Benchmark table (verified 2026-10-27)

Checked by fetching the cited pages. "(summary)" means the fetch tool only
saw a model-extracted summary of that part of the page, so re-check against
the live page. Cells nobody verified are dropped.

| Dimension | Grok Bot (xAI) | Hermes Agent (Nous) | NemoClaw (NVIDIA) | OpenClaw | **Agni Routines (v1)** |
| --- | --- | --- | --- | --- | --- |
| **Routine logic** | A routine runs a saved skill on a schedule or, "where supported", on an event. Skill drafts can be learned from a recorded browser demo of up to 10 minutes ("Teach a task"), still a draft you review. | Agent-written skills in `~/.hermes/skills/<name>/SKILL.md`, agentskills.io-compatible. | Not described: the CSA note says nothing about scheduling. | Cron jobs run an isolated agent turn in session `cron:<jobId>` (summary). | Prompt plus typed state. Crystallized replay is **PR 2, not built**. |
| **Unchanged-state cost** | No change-detection gate documented. | Each due job starts a fresh agent session, **but** a pre-check script can print `{"wakeAgent": false}` to skip the agent for that tick (summary), and `no_agent` script-only jobs use no tokens. Skipping needs a script you write. | Not stated. | Isolated cron runs an agent turn; no skip-if-unchanged stated. | **Built-in** hash gate for `http` (ETag/body) and `sql` pre-flights: 0 model calls when unchanged, no script to write. |
| **State across runs** | Keeps the 20 most recent run records per routine; cross-run state is not stated. | `MEMORY.md` (2,200 char cap) and `USER.md` (1,375 char cap) in `~/.hermes/memories/`; FTS5 session search. | CSA lists "no persistent agent identity... or cross-session continuity" as a gap. | "Each run starts a fresh session id (no prior conversation carry-over)" (summary). | `stateContext` JSON (TEXT in SQLite) passed into the next run. |
| **Safety** | Approval is configurable ("Ask first" rules, sensitive actions "can stop for approval"). Routines auto-pause after a long absence. | MIT licence. Isolation model not checked. | Landlock, seccomp, network namespaces; outbound only to allowlisted hosts. | 135,000+ exposed instances found by SecurityScorecard (early Feb 2026, via the CSA note). Malicious ClawHub skills: CSA cites 1,184 (attributed to a Cisco blog in its background); other researchers report different counts, so say "figures differ". | Read-only tool allowlist, domain allowlist on our web tools, token and time caps, auto-pause after 5 failures. **No kernel sandbox.** |

Corrections to the table the owner supplied:
- Hermes does **not** always wake the LLM. It has a pre-check gate and a
  script-only mode. Agni's edge is that the gate is built in; do not claim
  uniqueness.
- "Stateless kernel sandbox per execution" for NemoClaw is not in the CSA
  note. Dropped.
- "Closed xAI cloud" for Grok Bot and "Self-hosted MIT process (host/container
  permissions)" for Hermes were not confirmed beyond "MIT". Dropped.
- The OpenClaw "official docs" URL, `openclawcn.com`, looks like a
  third-party site. Confirm the official docs domain and cite that.
- The Hermes version `v0.18.2`, the "E. van de Blaak" article and the
  Developers Digest article were not fetched. Unverified.
- Ours: JSON text in SQLite, not JSONB; `maxTokens`, not USD; in-app
  delivery only; crystallization is PR 2.

The PR description states what is tested (unchanged state = 0 model calls,
citing the Wave 2 test) and what v1 omits (crystallization, webhook,
Telegram/Discord, shell pre-flight, USD budgets, kernel sandbox).

## 8. Acceptance checklist (Haiku pastes real output for each)

- [ ] `bun run typecheck` clean.
- [ ] `bun test apps/server packages/protocol` green, including `jobs-registry.test.ts`.
- [ ] `bun run test:web` (client and web Vitest) green.
- [ ] Test: unchanged hash → `skipped_no_delta`, router call count 0, nothing posted to the conversation.
- [ ] Test: changed hash → model called once, `stateContext` saved, streak 1.
- [ ] Test: `maxExecutionMs` abort → `timed_out`, prior state kept.
- [ ] Test: 5 consecutive failures → job `enabled = 0` and a notify.
- [ ] Test: SQL pre-flight rejects `DELETE`, `ATTACH`, `;`-chained statements.
- [ ] Test: a routine cannot be created from a peer-originated turn.
- [ ] Test: web tool call to a non-allowlisted domain is refused.
- [ ] Test: a routine turn cannot see `mail_send`, `bash`, `write_file`, `handoff` or `routine_create` (assert the tool specs sent to the model).
- [ ] Test: a model call naming `mail_send` or `ask` during a routine turn returns "not available" from `executeTool`.
- [ ] Test: `toolAllowlist` never grants a tool the persona lacks.
- [ ] Test: `maxTokens` below the loop cap stops the loop early.
- [ ] Test: `runTaskTurn` with no new fields behaves exactly as before.
- [ ] Test: deleting a routine job via `job.delete` also removes its `routines` and `routine_runs` rows.
- [ ] Test: `job.list.ok` includes `routine` with at most 5 runs; non-routine jobs are unchanged.
- [ ] Test: the cron values listed under Worker A pass, including both DST cases and 6-field rejection.
- [ ] Instant lane untouched (`runInstantTurn` has no diff).
- [ ] No secrets; **no new frame; `PROTOCOL_VERSION` still 2** in both TypeScript and Swift.

## 9. PR 2 (not this plan): crystallization and webhook

After 3 consecutive `ran` outcomes with an identical tool-name sequence,
store a JSON recipe of the tool calls and replay it with no model call; any
tool error falls back to the LLM path and resets the streak. Replayed steps
with side effects stay approval-gated (hard rule). Webhook delivery ships
with an owner-only way to set it.
