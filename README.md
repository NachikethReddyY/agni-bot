# Agni

Speed-first personal assistant. Our own harness, our own server, our own apps.
No walled gardens: free model tiers called by API, a Gmail mailbox, and clients
we control. Full plan: [`docs/blueprint-v3.html`](docs/blueprint-v3.html).

## Layout

| Path | What it is |
| --- | --- |
| `apps/server` | Bun + TypeScript core: WebSocket protocol, agent loop, model router, SQLite stores, daemon lifecycle, job queue. Runs on this Mac now, bb-1 later. |
| `apps/web` | React + Vite web client, a faithful port of the native Mac UI. Shares `@agni/client` with future shells. |
| `apps/mac` | Native SwiftUI macOS client (`AgniApp` + `AgniKit`). Token in Keychain, resumable streaming. |
| `apps/app` | Tauri 2 clients (macOS + Android) from one codebase. P1 — Rust toolchain not installed yet. |
| `packages/client` | Client core: frame decoding, connection loop, conversation reducer, settings, formatting. Used by the web app; the reference for the Swift port. |
| `packages/protocol` | Wire protocol v2: typed frames shared by server and every client. This is the contract. |
| `tools/cli` | Protocol client: `chat` (interactive), `ask`, `bench`, `ping`. The P0 proof gate lives here. |
| `docs` | Blueprint v3 (canonical), architecture notes, protocol spec. |

## Quickstart

```sh
bun install
cp .env.example .env        # add at least GROQ_API_KEY and/or NVIDIA_API_KEY
bun run migrate
bun run daemon start        # run the server detached in the background
bun run pair --name Mac     # prints a device token once — save it
export AGNI_TOKEN=agni_…
bun run chat                # talk to it; /help lists commands
bun run daemon status       # pid, uptime, provider health, usage today
```

Foreground alternative while hacking: `bun run dev` (watch mode). Both modes are
the same process; the daemon just detaches it, writes `data/agni.pid`, appends
to `data/agni.log`, and waits for `/health` before reporting success.

### Web app

`apps/web` is the React port of the SwiftUI client. It runs on pnpm + Turborepo
alongside the Bun server; the workspace still uses Bun for the server, CLI, and
tests.

```sh
pnpm install
bun run daemon start
bun run pair --name Web     # copy the one-time token
pnpm web                    # http://127.0.0.1:5173
```

Enter the daemon address (`127.0.0.1:8787`, or its Tailscale address) and the
token in the browser. The token is kept in `localStorage`; **Forget this
device** clears it. The page checks `/health` before connecting, so a daemon on
another origin needs CORS, which `/health` already sends.

Useful commands:

```sh
pnpm check                  # typecheck + web/client Vitest + Bun server tests
pnpm web:build              # production bundle in apps/web/dist
pnpm --filter @agni/client smoke   # headless client core against a live daemon
pnpm --filter @agni/web smoke:ui   # Playwright smoke (needs AGNI_URL/AGNI_TOKEN
                                   # and a running Vite dev server)
```

### Background work (the daemon doing things on its own)

```sh
bun run job add "Draft my morning brief from yesterday's notes" --at 07:55 --every 1d
bun run job add "In one line: what should I not forget today?" --in 2h
bun run job list --all      # state, next run, last result
bun run job run <id>        # make a job due now
bun run job rm <id>         # cancel
```

Jobs run in the daemon's `turn` lane: the model call streams into its thread
(so any client sees it live) and completion raises a `notify` frame. Failures
retry with backoff, then land as `failed` with a notification.

### Passwords and other secrets

When a command needs the owner's password (`sudo`, `ssh`, `ssh-add`, git over
HTTPS), the agent calls `run_privileged`. It shows the exact command and a
one-line purpose; the owner types the password into the web app's secure card
or the CLI's hidden prompt. The value goes straight to that one command and is
never returned to the model, written to the transcript, or logged.

- **Web app:** the card appears above the composer. `Authorize` sends it once.
- **SSH / terminal:** `bun run chat` prints a `[secret …]` line; enter it with
  `/secret <requestID>` (input is hidden). Run the CLI on the Mac (or reach the
  daemon over Tailscale) — the daemon binds loopback by default.
- **Expiry:** a prompt lasts two minutes. Cancelling it, stopping the turn, or
  restarting the daemon drops it.
- **No chat pasting:** the agent is instructed never to ask for a password in
  prose. If it does, refuse and use the card.

The secret is injected via stdin and a short-lived 0600 askpass file in a 0700
temp directory; it is removed when the command exits. Output is scrubbed of the
exact value before it reaches the model.

### Agent visibility

Every agent has a visibility that says what *other* agents may see of its
work:

- `private` — nothing leaves the agent. Another agent gets a receipt: the
  task, the state, and the fact that it finished. The work stays in that
  agent's own conversation, which the owner can open directly.
- `summary` — the caller gets one bounded line: enough to report an outcome,
  not the working.
- `shared` — the caller gets the full text. The shipped team is `shared`
  (the executive assistant is the owner's proxy), and a new agent created in
  chat starts at `summary`.

One rule holds it together: every path that can carry another agent's text
goes through the same redaction helper — tool results, task rows, recall, and
the logs. A fact is scoped the same way: `scope=agent` memory is unreadable
by other agents, and a private fact is readable by its owner alone.

Change it with `update_agent` (`visibility: private | summary | shared`) or
in the app.

### Search and memory

Facts and the conversation transcript are indexed with SQLite FTS5, so
recall is a real search rather than a substring match. A search is ranked
with

```
score = relevance * recency_decay(last_used_at) * salience * (1 + log(1 + use_count))
```

and a recall moves `last_used_at` and `use_count`, so the formula reflects
what actually gets used. Below the confidence floor (`AGNI_MIN_RECALL_SCORE`,
default `0.15`) nothing is injected — a plausible match that is not good
enough is still nothing.

The agent can search the transcript itself with `transcript_search`; the
search respects the same visibility rules as everything else, so a private
agent's conversation is not searchable from outside.

The slot budgets of the context assembler are configuration:
`AGNI_SLOT_PINNED_CORE`, `AGNI_SLOT_ANCHOR`, `AGNI_SLOT_LEDGER`,
`AGNI_SLOT_SUMMARIES`, `AGNI_SLOT_RECALL` (tokens).

### Smoke test without any keys

```sh
bun run mock &              # healthy provider on :9911
MOCK_PORT=9912 MOCK_FAIL=1 bun run mock &          # 429s — failover fixture
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:9912/v1 \
LMSTUDIO_BASE_URL=http://127.0.0.1:9911/v1 LMSTUDIO_MODEL=mock \
  bun run serve &                                   # answers via LM Studio after Groq 429s
```

With the mock running, the daemon and chat also work keyless:

```sh
GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:9911/v1 bun run daemon start
AGNI_TOKEN=… bun run ask "what is 2+2"    # → mock(mock-model): what is 2+2
```

## Environment

All configuration lives in `.env` at the repo root (Bun loads it automatically;
it is gitignored). See [`.env.example`](.env.example) for the full list —
providers are enabled by the presence of their key, everything else has a
working default.

Model choices changed in the Mac app are stored on the daemon in
`data/providers.json` (mode 600). Provider API keys remain in the daemon's
mode-600 `.env`; the JSON file contains model IDs only.

## Phases

| Phase | Scope | Proof |
| --- | --- | --- |
| P0 | Server + instant lane, CLI test client | p50 ≤ 1.5 s over the socket, streaming deltas, failover on 429 |
| P0.5 | Daemon lifecycle, chat REPL, background jobs | `daemon start`, `chat` streams, scheduled job lands in a thread + notify |
| P1 | Mac app (Tauri): pairing, threads, streaming, resync | Kill app mid-turn, reopen, turn resumes |
| P2 | Memory/links/tasks stores + 07:55 brief via ntfy | Capture → retrieve → approve from a notification |
| P3 | ACP (codex-acp) + MCP (REA) | Repo task streams from Codex into the same thread UI |
| P4 | Gmail (IMAP/SMTP app password) + calendar ICS | Approved draft sends; brief shows a real event |
| P5 | Android + bb-1 + polish | Phone over Tailscale; server survives a reboot |

P0–P2 is the "faster than Hermes and usable daily" milestone.

## Rules

- `packages/protocol` is the contract. Change frames there; bump
  `PROTOCOL_VERSION` on breaking changes and update `docs/protocol.md`.
- Free-first routing. Provider keys live server-side only — never in the repo,
  never in the apps.
- Anything that shells out, writes files outside scratch, sends mail, or pays
  money is approval-gated before it is implemented.
- No IDE features, ever. Repo-shaped work is delegated through ACP harnesses.
- `bun test` and `bun run typecheck` pass before every commit.
