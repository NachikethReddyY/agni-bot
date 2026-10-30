# Architecture

Two-minute orientation. The canonical plan is
[`blueprint-v3.html`](blueprint-v3.html); where this file and the blueprint
disagree, the blueprint wins for intent, and the code wins for current
behaviour.

## What the product is

**Agni Bot** is a messaging app for bots. The owner talks to named, specialised
bots, each with its own role and memory, in one continuous conversation per
bot. The app values performance over UI polish. The project is
source-available, not open source.

## Shape

```
Web app (React)  ───┐
Mac app (SwiftUI) ──┤
Tauri app (planned)─┼── WebSocket (typed frames, seq'd, resumable) ── over Tailscale
CLI (tools/cli) ────┘                                                │
                                                                     ▼
                                                      apps/server  (Bun + TypeScript)
                                                      ├─ ws: server / dispatch / frame log
                                                      ├─ agent: bots (personas), task lane,
                                                      │         creation, visibility
                                                      ├─ jobs: queue runner + turn kind
                                                      │        (daemon work while idle)
                                                      ├─ models: router → Groq · Cerebras ·
                                                      │           NIM · Gemini · OpenRouter ·
                                                      │           LM Studio, plus a ChatGPT
                                                      │           subscription source (free-first,
                                                      │           failover before first token)
                                                      ├─ plugins: catalog (Gmail, Calendar, Drive,
                                                      │           MCP connectors), OAuth, credentials
                                                      ├─ stores: SQLite (WAL) + FTS5 (see Stores)
                                                      └─ tools: registry (schema + timeout),
                                                                bounded memory, links, tasks, mail,
                                                                web, files, approvals
```

Planned, not built: an ACP bridge for coding jobs (P3), a Tauri client
(`apps/app`, README only), and messaging integrations such as Slack and Discord.

### Clients

- `apps/web` is a React + Vite client. It uses the transport-agnostic core in
  `packages/client` (frame codec, connection loop, resync, conversation reducer,
  settings, health).
- `apps/mac` is a SwiftUI client. `AgniKit` is its own Swift connection and
  conversation layer, and `AgniProtocol` mirrors the frames by hand.
- Both speak `packages/protocol` version **2**. A frame change lands in
  `packages/protocol` first, then flows to each client.

## Process lifecycle

`bun run serve` is the server entry point. `bun run daemon start` spawns that
same command detached (own session, stdio → the log file), writes a pid file,
and reports success once `/health` answers. `daemon stop` is SIGTERM (SIGKILL
only if the process refuses to die). `serve` handles both signals by stopping
the job runner, flushing the frame log, and closing SQLite. Log and pid
locations default to `~/.agni/` (see `apps/server/src/config.ts`). The
provider settings file is the exception and still lives under `data/`.

## Background jobs

The `jobs` table is the queue: `queued → running → done | failed`. Claims are
transactional, attempts are counted, and a job a dead process left `running` is
requeued at boot. One runner per daemon executes kinds sequentially so
background work cannot stampede a free-tier provider.

The `turn` kind runs one prompt in a thread. The daemon uses it for reminders
and scheduled briefs, and it streams results to any connected client. Completion
raises `notify`. A `turn` job with `everyMs` reschedules itself and keeps its
thread. Failures retry with backoff, then park as `failed` with a notification.

Background results land in the bot's conversation as a `background` session
block. They join the transcript without stealing the active chat block.

Live and background turns share a process-wide model stream limit
(`AGNI_MAX_CONCURRENT_TURNS`). Chat turns that arrive at capacity receive
`server_busy` and can retry. `/health` reports active and configured capacity.
Queue and replay state are process-local, and SQLite is the single-writer store,
so one daemon scales vertically. Horizontal replicas would need shared
coordination and a multi-writer database.

## The one contract

`packages/protocol` defines every frame, validated with zod. The server assigns
a monotonic `seq` to every outbound frame and keeps a bounded replay log.
Clients that reconnect send `resync {lastSeq}`. If they fall behind the log,
they get `resync_gap` and reload from the database. See [`protocol.md`](protocol.md).

## Speed rules (why this stays fast)

- **S1 constant prompt**: system + persona + the last 16 messages, hard cap.
  Nothing grows with history (`agent/task-loop.ts`).
- **S2 memory is a tool**: FTS5 indexes (memories, links) are read by tools on
  demand, never injected into the prompt prefix.
- **S3 one lane**: every turn, chat or background job, runs the task lane
  (`runTaskTurn`). The separate one-call instant lane was removed.
- **S4 write-time work**: summaries and indexes are written when data lands,
  not at read time. Scheduled work lives in the job queue.
- **S5 warm path**: router health and cooldown avoid paying timeouts twice.
- **S6 perceived speed**: local echo and streaming deltas on the client.
- **S7 bounded everything**: per-turn timeout, first-token timeout, step budgets
  in the task runner, daily caps on the usage ledger.

## Task lane

Every turn runs through `agent/task-loop.ts`, including background jobs.
Each task step sends the same system prompt
and tool schemas first, then the compacted session and recent messages. That
keeps the request prefix stable for provider-side caching.

The loop has no tool-call or output-token budget (removed 2026-10-27); the
turn timeout and the chain step guardrail (24 model calls, 12 when delegated)
bound it. It persists its message log
and each tool result. An interrupted session restores saved tool results. Calls
with an uncertain outcome come back as errors and are never replayed
automatically. Approval decisions are stored in SQLite and resolve the active
loop through the approval broker.

A turn that runs out of budget still answers, naming the work that happened.
A turn that only reads the app's own source is told to act, then stopped with
the truth about what it can and cannot do.

Scheduling is a tool. `job_schedule` puts a prompt on the queue with a
wall-clock schedule, `job_list` shows what is queued, and `job_cancel` stops it.

Redefining a bot is also a tool. `update_agent` writes the owner's words into
the bot's role and prompt, and `create_agent` gives a new bot its own allowlist
and role. Both survive a restart: the roster is rebuilt from the `agents` rows at boot.

A handoff lands in the *asked* bot's conversation, so opening that bot shows the
delegated work.

## Failure honesty

- Failover happens only **before** the first token reaches the client. A stream
  that dies mid-flight ends the turn (`MidStreamError` → `turn.end{error}`)
  instead of duplicating text from a second provider.
- Partial output is persisted even when a turn is cancelled or times out. The
  `stop_reason` column records what happened.
- A client that falls behind the replay log gets `resync_gap` and reloads from
  the database, which always holds the durable message history.

## Stores

One SQLite database in WAL mode. Its location comes from `AGNI_DB_PATH`
(default in `config.ts`). Tables are created by numbered migrations in
`apps/server/src/db/migrations.ts`, which has 43 migrations. The schema holds
about 30 tables. Main groups:

- Conversations and turns: `conversations`, `threads`, `turns`, `messages`,
  `channels`, `channel_messages`, `summaries`, `attachments`, `artifacts`
- Bots and memory: `agents`, `agent_memories`, `memories`, `memory_conflicts`,
  `links`, plus FTS5 indexes
- Work: `tasks`, `task_lists`, `task_activity`, `jobs`, `forms`, `approvals`,
  `peer_chains`
- Usage and plugins: `usage_ledger`, `plugin_connections`
- Devices and appearance: `devices`, `appearance_*`

A conversation is the one chat with a bot, never reset. Every `threads` row is
a session block inside it. A session block is an invisible context span that
opens with the carried summary and closes into it (`closed_by`: `manual`,
`context`, or `background`). Compaction is write-time: one bounded model call per
closing block (`agent/rollover.ts`). A failed summary carries the previous
summary forward and never blocks a turn.

## Plugins

The catalog in `apps/server/src/plugins/catalog.ts` lists what can be connected,
per account, with the scopes it asks for and the capability policy:
`free` (runs without asking), `approval` (asks first), or `off` (refused).
Current entries are Agni's Gmail, the owner's Gmail, Agni's Calendar, the
owner's Calendar, the owner's Drive, and the connectors Granola, Firecrawl,
and Notion.
See [`plugins.md`](plugins.md).

## Home

This Mac now; bb-1 later (systemd or compose, Tailscale, same image, SQLite
backup). The server binds to `AGNI_HOST` only. Loopback in dev, the Tailscale
interface on bb-1. Nothing listens on the public internet.
