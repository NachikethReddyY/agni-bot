# Backend improvement plan: closing the gap with Duet, Grok Bot, Cue and Muse

Status: analysis, 2026-10-30. Nothing here is built yet. Paths are relative to
`apps/server/src` unless they say otherwise. Items marked **(verified)** were
re-read in code after the subagent reviews.

## TL;DR

Agni Bot already has the bones the four products share: named bots with memory,
a job queue, scheduled turns, proactive `notify`, approval gates, Gmail, and
vision input. The gap is not missing architecture. It is three things:

1. **It feels slower than it is.** Chat turns do not stream, and every message
   waits 800 ms before the bot starts. Fixing both is the biggest, cheapest win.
2. **Memory quietly misfires.** The search score is always 1, the tagger drops
   whole batches on a formatting slip, and the "profile" slot is never filled.
   Duet and Muse lead on memory, so this matters most for the product feel.
3. **Proactivity stops at the WebSocket.** Bots can message first, but with no
   push notifications the owner only sees it with the app open. Everything the
   competitors call "messages you first" depends on push.

After that come the bigger pieces: real Calendar/Drive/MCP tools, bot-to-bot
group threads, voice, and a sandboxed computer per bot.

---

## 1. What the four products do

All four are real products. Product facts come from web search results, not
from primary vendor pages, so treat dates and details as reported.

| Product | What it is | Signature |
|---|---|---|
| **Claude Duet** (Anthropic, preview 2026-10-21) | Proactive personal agent on web, iOS and Android | Messages you first: morning brief, checks connected apps every few hours, own cloud VM and browser, reuses Claude memory and connectors, asks before send/pay/sign/delete |
| **Grok Bot** (xAI, beta 2026-08-11) | Always-on agents, each with its own cloud computer | A *roster* of agents with a "Primary Bot"; logs into your tools and works while you are away; Grok memory, tasks, voice and vision |
| **Cue** (name is ambiguous; closest is Shared Context Lab's Cue) | Assistant that lives in iMessage, WhatsApp and group chats | Messaging-native, starts conversations with tunable frequency, works in group chats; a related Cue coordinates with friends' Cues (agent-to-agent) |
| **Meta Muse** (agent announced 2026-09-08, on the Muse Spark model) | Personal agent in the Meta AI app and WhatsApp | Memory files the user can read and edit, tasks that run after the app closes, a separate "Sentinel" agent that gates internet access |

### What they share (the target list)

1. Long-term memory per user and per bot that the user can see, edit and delete.
2. A scheduler: briefs, polling connected apps, event triggers.
3. A proactive outbound path with tunable frequency and quiet hours.
4. Durable background work that reports back when done or blocked.
5. A sandboxed computer or browser per bot.
6. Approval gates that pause a job and resume on the owner's answer.
7. Scoped connectors where the model never sees credentials.
8. Delivery beyond the app (push; for Cue and Muse, messaging channels).
9. Guardrails: injection handling, leak checks, a gatekeeper agent.
10. Low-latency realtime: streaming, interruptible voice, multi-party threads.

---

## 2. Where Agni stands today

| Capability | Agni today | Gap |
|---|---|---|
| Per-bot memory | `agent_memories` with scope, supersession, salience, FTS5, optional vectors (`stores/agent-memories.ts`) | Broken ranking, lossy writes, no profile, no edit UI (§3, §4.2) |
| Scheduler | Job queue, `everyMs`/`dailyAt`, routines with cron and preflight (`jobs/`, `routines/`) | No event triggers (mail arrives, calendar changes) |
| Proactive messages | `say` tool, morning brief, task reminders, routines all emit `notify` | WebSocket only, no push, `sound` always false |
| Background work | `delegate_task` → `turn` jobs, 200 per bot per day | Runner is serial, one job at a time |
| Approvals | Durable `approvals` rows, survive restart (`agent/approval-broker.ts`) | Dropped inside handoffs (bug, §3) |
| Connectors | Gmail works (IMAP/SMTP) | Calendar/Drive: OAuth only, no tools. MCP: "not wired yet". Firecrawl key from the UI is ignored |
| Multi-agent | `handoff` (sync) and `delegate_task` (async), loop guards | No shared thread, no blackboard, no parallel fan-out |
| Vision / files | Images, text, PDF text (`attachments/`) | Images re-sent on every turn for 16 messages |
| Voice | None | Not found anywhere in the server |
| Sandbox / computer | `bash` on the host, cwd = scratch | Policy-only containment; no browser automation |
| Push / channels | None | No APNs, web push, WhatsApp or iMessage |
| Per-bot model | `agents.model` column exists | Router ignores it; every bot uses one model list |

---

## 3. Bugs to fix first

These are correctness problems found by the deep review. The first five were
re-read in code.

| # | Bug | Where | Effect |
|---|---|---|---|
| B1 | **Memory relevance is always 1** (verified). bm25 rank is negative, and `1 / (1 + Math.max(0, rank))` turns every rank into 1 | `stores/agent-memories.ts:322` | Retrieval ranks by recency × salience only; the 0.15 floor lets weak hits in on most turns, and `markMemoryUsed` then boosts them |
| B2 | **Tagger loses a whole batch on a JSON slip** (verified). A bare `JSON.parse` fails on ```` ```json ```` fences, returns `ephemeral: true`, and the caller marks all messages tagged | `agent/tagger.ts:82`, `jobs/tagger.ts:143-146` | Facts from up to 40 messages are never extracted |
| B3 | **Channel turns do not stream** (verified). Deltas are held when `channelBacked`, then sent as one token at the end | `agent/task-loop.ts:556-582` | Time-to-first-token equals full generation time on web and Mac |
| B4 | **Handoff drops approvals and forms** (verified). The child's `emit` passes only `status.update` | `agent/handoff.ts:111-113` | A gated tool in a handed-off bot hangs until the parent times out |
| B5 | **Parent's summary leaks to the child bot** (verified). `carrySummary` is passed into the child's prefix | `agent/handoff.ts:108` | One bot's conversation summary reaches another bot, against the rule at `task-loop.ts:463` |
| B6 | Compactor retries a failed parse after every turn, and runs can overlap (no lock) | `agent/compactor.ts:47,75`, `task-loop.ts:720` | Repeated model calls of up to 1,500 tokens |
| B7 | Depth caps disagree: handoff 5, delegate 3 | `agent/guardrails.ts:18`, `tools/delegate-task-tool.ts:33` | Prompt tells the model "of 5" when delegate stops at 3 |
| B8 | 429 retries the same provider 3 times before failover | `models/router.ts:234-239` | 4–6 s lost before trying a healthy provider |
| B9 | Background work shares the 4 chat slots | `models/router.ts:150`, `index.ts:93` | Tagger or compaction can make a chat turn fail with `server_busy` |
| B10 | `searchAgentMemories` ignores `scope` for non-agent scopes | `stores/agent-memories.ts:335-347` | Wider recall than asked for |
| B11 | Pinned facts pick by `updated_at`, so "promote" (salience 1.0) has no effect, and no-op rewrites reshuffle the pins | `tools/facts.ts:105`, `jobs/memory.ts:161` | The "always know this" set is effectively random recent edits |
| B12 | Tagger `ttl` parsed, never stored | `agent/tagger.ts:57` vs `:175-189` | Temporary facts never expire |

---

## 4. The plan

Ordered by impact over effort. Each phase ships on its own.

### Phase 0: speed (days)

The product values speed over polish, and the competitors' feel starts here.

1. **Stream channel answers (B3).** Emit deltas once the step's first chunk is
   content; if a tool call follows, turn the bubble into a progress bubble.
   Files: `agent/task-loop.ts:512-584`, the conversation reducer in
   `packages/client`. Biggest perceived-speed win in the repo.
2. **Cut the debounce for single messages.** Send right away when the owner is
   not typing and the message looks complete; keep the 800 ms batch for bursts.
   Files: `ws/dispatch.ts:583-611`.
3. **Fail over fast (B8, B9).** On 429 or timeout, cool the provider with
   `retryAfterMs` and move on. Give background callers their own slot pool or a
   lower priority so they never take chat capacity. Files: `models/router.ts`.
4. **Run the embedding call in parallel with FTS** and with prompt assembly.
   Run read-only tool calls from one step in parallel (`web_fetch`,
   `memory_search`, `transcript_search`). Files: `agent/retrieval.ts:104-124`,
   `agent/task-loop.ts:592-639`.
5. **Send image bytes once.** Only the current message carries the image;
   history keeps a text stub. Files: `agent/task-loop.ts:285`,
   `attachments/store.ts:114-138`.
6. **Make the prompt prefix cache-friendly.** Put stable parts first (persona,
   lane, peer rule, team, tool hints), per-turn recall and anchor last. Add
   `prompt_cache_key` per bot where the provider supports it. Files:
   `context/compiler.ts:112-161`, `agent/prompts.ts:60-92`, `models/client.ts`.
7. **Replace the raw `agent_sessions.summary` dump** (up to 8k chars of
   `user:`/`assistant:` lines re-sent every turn) with the real block summary.
   Files: `agent/task-loop.ts:322,543,971`.

**Measure it:** add first-token and turn latency to EVAL-005, and track p50/p95
time-to-first-token for "hi" before and after.

### Phase 1: memory that feels like Duet and Muse (1–2 weeks)

1. **Fix ranking (B1).** Normalise bm25 (`-rank / (1 - rank)` or min-max over
   the result set), add stopwords to the OR fallback, re-tune the 0.15 floor.
2. **Make writes reliable (B2, B6).** Reuse the fence-stripping parser that
   `rollover.ts:351` already has; send `response_format: json_object` where
   supported; never mark a batch tagged when parsing failed.
3. **One extractor, stable keys.** Merge the compactor's fact extraction into
   the tagger. Send the existing keys to the tagger (the compactor already does,
   `compactor.ts:28`) so "I live in NYC" and "I live in SF" share a key and
   supersede instead of coexisting. Store `ttl` as `valid_to` (B12).
4. **A real profile.** Fill the empty `profile` and `ledger` slots
   (`context/compiler.ts:69-74`): pin by salience and use count (B11), inject
   open tasks as the ledger.
5. **Editable memory (Muse's signature).** Add `memory.update`, `memory.pin`
   and `memory.forget` frames next to `memory.list` (`ws/dispatch.ts:969`), and
   a frame that lists `memory_conflicts` so the owner can resolve them. Protocol
   change: lands in `packages/protocol` first, mirrored in
   `apps/mac/Sources/AgniProtocol/Frames.swift`.
6. **Embed on write**, not in the 5-minute job, so new facts are findable at
   once. Keep the brute-force cosine scan; at 2,000 rows it is fine. Revisit
   `sqlite-vec` only if memory grows past ~50k rows.
7. **Episodic recall.** Store tagger `episode` items as episodes, and read
   epoch summaries (written today, never read) when the question is about the
   past ("what did we decide in August?").

**Measure it:** EVAL-001 (needle recall) and EVAL-006 (drift) should improve;
add a case for conflicting facts and one for a fenced-JSON tagger response.

### Phase 2: proactive delivery (1–2 weeks)

Duet, Cue and Muse are defined by messaging first. Agni can already decide to
message; it cannot reach a closed app.

1. **Push notifications.** Web Push (VAPID) for the web client, APNs for the
   Mac app. Store device push tokens in `devices` (server-side only, per the
   secrets rule). Send on `notify` when no client is connected. Respect the
   Tailscale-only rule: the server calls out to Apple/browser push services, so
   nothing new listens publicly.
2. **Quiet hours and frequency per bot.** A small per-agent setting that the
   `say` tool, brief and routines check before sending. Cue and Muse both let
   the user tune how often the bot reaches out.
3. **Event triggers.** Let routines fire on events, not only cron: new mail in
   Agni's or the owner's inbox (IMAP IDLE or a cheap poll), a calendar event in
   N minutes. `remaining-work.md` §5 already lists event-driven routines.
4. **"Check my apps" brief, like Duet.** A default routine that scans mail and
   calendar every few hours and only messages when something needs a decision.
   Mostly a prompt plus the Phase 3 tools.
5. **Parallel background runner.** The runner is serial. Allow a small pool (2–3)
   with a per-provider cap, so one slow job does not delay every reminder.

### Phase 3: connectors that work (1–2 weeks)

1. **Calendar and Drive tools.** OAuth works, but `accessTokenFor`
   (`plugins/service.ts:377`) has no callers. Add `calendar_list`,
   `calendar_create` (approval-gated on the owner's calendar) and
   `drive_search`, `drive_read`.
2. **MCP client.** `plugins/service.ts:283-288` says "not wired yet". Add one
   generic MCP client (stdio and streamable HTTP) so Granola, Notion and any
   future connector come through one path, with each MCP tool's capability mode
   (`free` / `approval` / `off`) taken from the catalog. This is the route to
   Duet-scale connector reach without building each one.
3. **Use the Firecrawl key from the UI.** `tools/web.ts:9-11` reads only env
   vars; read the plugin credential too.
4. **Fix catalog drift.** Catalog `toolNames` (`mail.draft`, `mail.labels`) do
   not match the registered tools (`mail_search`, `mail_read`, `mail_send`).

### Phase 4: bots working together (2–3 weeks)

Grok Bot's roster and Cue's agent-to-agent coordination are the model here.

1. **Fix handoff first (B4, B5, B7).** Forward `approval.request` and `form.*`
   frames from the child, stop passing the parent's carry summary, and use one
   depth constant.
2. **Group threads.** The schema already supports channels with members
   (`channel_members`); only `ensureDMChannel` is used. Add group channels where
   the owner and two or more bots talk, with a simple floor rule: a bot answers
   when addressed (`@name`) or when the primary bot routes to it. The tagger's
   one-agent-per-channel assumption (`jobs/tagger.ts:115-117`) needs to change.
3. **Shared scratchpad per task.** A task-scoped notes table (or artifacts with a
   task key) that delegated bots read and append to, instead of passing
   everything through tool results.
4. **Parallel fan-out.** Let one turn delegate to several bots at once and wait
   on all of them (`delegate_wait` already exists; the loop just runs tool calls
   in series).
5. **Critic pass, opt-in.** For drafts that go out (email), a second bot reviews
   before the approval prompt. Cheap version of Muse's Sentinel.
6. **Per-bot model.** Honour `agents.model` in the router, so a quick
   assistant bot can use a fast 8B model and a research bot a larger one.

### Phase 5: voice and richer input (2–3 weeks)

1. **Voice notes first.** Accept audio attachments, transcribe with a free API
   (Groq Whisper fits the "free providers by API" rule), and reply in text.
   Optional TTS for replies. This covers most of the value with no realtime
   stack.
2. **Realtime voice later.** Interruptible streaming voice (Grok, Muse) needs a
   new frame family and an audio stream; do it only after push and streaming
   text are solid.
3. **PDF OCR** for scanned PDFs (today text-only, `attachments/pdf-worker.ts`).

### Phase 6: a computer per bot (larger, later)

Duet and Grok Bot give each agent a cloud VM with a browser. Agni runs `bash`
on the host with policy-only containment.

1. **Real sandbox for `bash` and file work.** A container or macOS sandbox
   profile per bot, scratch mounted, network off by default. This also hardens
   today's setup.
2. **Headless browser tool.** Playwright in that sandbox, for sites that need
   JavaScript or a login. Approval-gated, credentials through the existing
   `run_privileged`-style prompt, never shown to the model.
3. **A gatekeeper for network egress** (Muse's Sentinel idea): outbound requests
   from the sandbox go through an allowlist the owner controls.

### Ongoing: data hygiene

These tables grow with no pruning: `messages`, `turns`, `usage_ledger`,
`channel_messages`, `tool_calls`, `task_activity`, `artifacts`, `summaries`,
done `jobs`. Messages are the product (never delete them), but `tool_calls`,
done `jobs` and `usage_ledger` can roll up or expire. Add the missing indexes
the review found: `messages.turn_id`, `approvals(turn_id, call_id)`,
`threads.agent_id`. Each is a new numbered migration (46+); never edit old ones.

---

## 5. What not to copy

- **Paid, app-locked models.** Duet runs on Opus and Muse on Muse Spark. Agni's
  rule is free capacity from API providers. Keep it; use per-bot model choice to
  put the best free model where it matters.
- **Public cloud hosting.** The server stays on the Mac or bb-1 over Tailscale.
  Push notifications are outbound calls, so they fit.
- **Ungated actions.** Competitors gate send/pay/sign/delete; Agni already does,
  plus shell. Keep the gates when adding Calendar writes, MCP tools and browser.
- **Slack/Discord/WhatsApp channels.** Cue and Muse live in WhatsApp. That is
  planned, not built, for Agni; do it after push, and do not advertise it yet.

---

## 6. Suggested order

| Order | Work | Why first |
|---|---|---|
| 1 | Phase 0 items 1–3 (streaming, debounce, failover) | Largest felt change, smallest diff |
| 2 | Bugs B1, B2, B4, B5 | Memory and handoff correctness |
| 3 | Phase 1 (memory) | Core of the Duet/Muse experience |
| 4 | Phase 2 item 1 (push) | Unlocks every proactive feature |
| 5 | Phase 3 (Calendar, Drive, MCP) | Gives the proactive brief something to read |
| 6 | Phase 2 items 2–5, Phase 4 | Bots that check in and work together |
| 7 | Phase 5, Phase 6 | Voice and sandboxed computer |

---

## How this was made

- Five subagents ran in parallel: three Haiku code mappers (WebSocket and jobs;
  tools and plugins; database, stores and tests), one Sonnet web researcher (the
  four products), one Opus deep reviewer (task loop, memory, routing, handoff).
- Bugs B1–B5, the plugin gaps (no `accessTokenFor` callers, MCP "not wired yet",
  Firecrawl env-only) and the 429 retry logic were re-read in code afterwards.
  B6–B12 rest on the Opus review's citations and were not re-read.
- Not done: no tests run, no latency measured, no client code reviewed. Product
  research used search-result snippets, not vendor pages.
