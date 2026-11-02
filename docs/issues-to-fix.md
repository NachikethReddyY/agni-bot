# Things to Fix / Think About

Notes captured from the conversation for later work. These are open items —
not yet implemented unless marked otherwise.

## 1. Composer placeholder: "Message [Bot Name]"

The composer placeholder should read `Message <current bot name>` (e.g.
"Message vision"), dynamically reflecting the selected agent. Currently it
already does this via `model.agent?.name`, but the wording/format should be
confirmed and consistent across all bots.

## 2. One conversation, never resets

The user-facing experience must be a single, continuous conversation that
never resets. The backend may rotate session blocks internally, but the user
should never perceive a reset or a new session boundary.

## 3. Every bot starts with "Hello …"

Every newly created bot should greet the user on first contact, introducing
itself and starting a clear onboarding flow.

## 4. Clear start point / onboarding for created bots

When a bot is created, it should:
- Introduce itself.
- Ask what the user wants to call it (name).
- Ask what it should own (its role/domain/scope).
- Let the user type in any restrictions (capabilities, limits, guardrails).

This is a new onboarding flow for created agents, analogous to the EA's
first-run name prompt.

## 5. "chatting with [bot name]" status

When the executive assistant delegates to another bot, the status strip
should say "chatting with <bot name>" (e.g. "chatting with Researcher")
instead of the current "Waiting on <bot>…". The user should see who the EA
is talking to in the background.

## 6. Context management research prompt

A research prompt (see `docs/research-context-management.md`) was drafted for
investigating how to manage context efficiently: one chat interface, multiple
backend threads, session rotation handled by the system, transparent
delegation. The user wants a research agent to execute it and return a
markdown + HTML artifact describing exactly how to do context management.

## 7. Roster: one executive assistant

The sidebar should show only the executive assistant (vision). Other
specialists are hidden from the sidebar but remain valid handoff targets,
so the EA can still delegate to them in the background. The user can also
create new agents on demand via `create_agent`.

## 8. Fix: URL requests treated as link captures

When the user asks to open, curl, or inspect a webpage, Agni should fetch and
explain the page. It must not treat that request as something to save for
later.

**Root cause:** `isCapture` in `apps/server/src/ws/dispatch.ts` matched any
message containing a URL, routing it to `captureMessage` (which saves the
link) instead of running a normal turn (which uses `web_fetch`).

**Fix (committed):** `isCapture` now only triggers for a bare URL drop with a
short note. Messages that ask to open/curl/inspect/fetch/explain/read a page
run as a normal turn. The EA prompt also now instructs it to fetch and
explain any URL the user asks about.

## 9. Window title not updating on rename

Renaming an agent does not update the window title, because `WindowChrome.retitle`
is only triggered by changes to `conversation.agentID` and `threadID`, not by
the agent's display name. The sidebar updates (via `agents.update`), but the
window title stays stale. Needs a fix: call `retitle` on `agent.updated`.

## 10. Window title / window chrome

Related to #9. The window title should follow the selected agent's name.

## 11. Save / backup everything to GitHub

All changes committed and pushed to `https://github.com/NachikethReddyY/agni-bot.git`.
Excluded (gitignored): `node_modules/`, `.evidence/`, `data/` (database, share
exports, logs), and the scratch dir. Included: source, tests, docs, and the
HTML artifacts in `artifacts/`.

## 12. Context management research (open)

See `docs/research-context-management.md` for the research brief and
`legacy/docs/audit-context-memory-spec.md` for the audit of the resulting spec against
the codebase. Many items (memory schema, vector/FTS retrieval, async handoff,
etc.) are MISSING or PARTIAL — see the audit for the full breakdown and build
order.
