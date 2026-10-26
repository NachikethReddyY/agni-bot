# P2 plan: stores, capture, and daily brief

> **Historical plan. Partly stale as of 2026-10-26.** Tools are registered in
> `apps/server/src/tools/` (the bullet below about "no registered tools" is out
> of date). Check the code before relying on any "already exists" or "remains to
> be built" claim here.

P2 makes Agni useful between conversations: saved memories and links can be
retrieved, tasks can be captured and completed, and a short morning brief
surfaces what needs attention. The instant lane stays one model call with no
tools. Store operations run through the separate task/tool path.

## Starting point

- SQLite migrations already create `memories`, `links`, `tasks`, and the
  `memories_fts` / `links_fts` indexes.
- The durable job queue, recurring jobs, retry behavior, `turn` job handler,
  and `notify` frame already exist.
- The Mac app already renders notifications, approvals, forms, and routines.
- `apps/server/src/tools/registry.ts` has no registered tools yet. Store
  modules, capture/retrieval tools, task-specific actions, brief generation,
  and ntfy delivery remain to be built.

## Design rules

1. Keep the instant lane unchanged: one call, no tools, bounded prompt.
2. Capture writes are deterministic and cheap. Do not ask an LLM to save a
   memory, URL, or task when a small parser and store call are enough.
3. Update the base table and its FTS index in one SQLite transaction. Search
   must never see a partially indexed record.
4. Treat fetched page text and model output as untrusted data. Apply SSRF
   protections to URL fetching; never follow page instructions as commands.
5. Store timestamps in UTC. Render and schedule the 07:55 brief in the
   configured user timezone; default to the Mac's configured timezone until
   a server setting exists.
6. Make each scheduled brief idempotent for its local calendar date. A
   restart or retry must not create duplicate briefs or notifications.
7. Keep externally visible actions approval-gated. Completing or snoozing a
   task is a user action; sending email is outside P2.

## Work plan

### 1. Store layer and data contracts

Add `stores/memories.ts`, `stores/links.ts`, and `stores/tasks.ts` with typed
rows and small CRUD/search functions. Use the existing schema where it fits;
add an append-only migration only for missing fields or indexes. Do not edit
an applied migration.

- Memories: create, update, delete, and FTS search over text, summary, and
  tags. Preserve the raw memory; summaries are optional and must not replace
  it.
- Links: create, edit note/tags, remove, and FTS search over title, summary,
  note, and tags. Deduplicate by canonical URL while preserving the user's
  note.
- Tasks: create, list/filter, mark done/open, and snooze until a timestamp.
  Validate status, priority, and due dates at the store boundary.
- Use prepared statements and transactions for record/index updates.

**Done when:** store tests cover create/update/delete, FTS consistency,
deduplication, due-date ordering, and rollback on failed writes.

### 2. Fast deterministic capture

Add explicit capture paths for the three kinds of durable data. Natural
language may route into these paths, but the actual write must use validated,
typed arguments and return a confirmation with the created record.

- `remember: ...` writes a memory immediately; allow optional tags.
- A pasted URL is canonicalized, fetched with strict time/size limits, and
  saved with title and a short extracted summary. Preserve any accompanying
  user note. If fetching fails, keep the URL and note and report the failure.
- `add task: ...` parses a title, optional due date, and priority. Ask a form
  question when the date is ambiguous instead of guessing.
- Avoid model calls for simple memory/link/task persistence. Any model-assisted
  parsing must be a bounded task-lane call and must not make the capture appear
  successful until the store commit succeeds.

**Done when:** CLI and app captures create durable records, show exactly what
was saved, and remain available after daemon restart.

### 3. Retrieval tools and task-lane integration

Register narrow tools such as `memory.search`, `links.search`,
`links.save`, `tasks.create`, and `tasks.list`. Give each a strict argument
schema, timeout, result limit, and persona allowlist. Add these tools to a
separate task/tool runner; do not enable tools in `runInstantTurn`.

- Search returns short snippets, record IDs, and dates, with a capped result
  count and total text budget.
- Retrieval uses FTS5 with safe query handling and a deterministic fallback
  for empty/no-match searches.
- Tool output is explicitly marked as untrusted context in the agent prompt.
- Tool errors are visible in the conversation and do not claim a write worked.

**Done when:** asking for a saved memory or link returns the right record in a
task-lane conversation; quick factual questions still use the instant lane.

### 4. Task actions and one-tap UI

Add authenticated protocol actions to list and update tasks: complete, reopen,
and snooze. Validate ownership and action parameters on the daemon. Return the
updated task snapshot so the UI stays in sync.

- Render task title, due date, priority, and state in a compact task card.
- Provide **Done** and **Snooze** actions; snooze presets are explicit and
  timezone-aware. Add **Undo** or reopen for accidental completion.
- Persist every action before acknowledging it. Repeated actions should be
  idempotent.
- Ask for approval before any future action that affects external systems;
  P2 task state changes themselves are direct user-authorized operations.

**Done when:** a task due tomorrow appears in the list/brief, can be snoozed
or completed with one tap, and reflects the new state after relaunch.

### 5. 07:55 daily brief and notifications

Build the brief as an idempotent recurring job in the user's timezone. It
summarizes due/overdue tasks, recently saved links, and relevant memories; it
must not invent events or task state. Store the generated brief in a thread and
emit one notification pointing to that thread.

- If there is nothing actionable, send a short quiet brief rather than
  fabricating content.
- Keep generation bounded and use the task/deep lane, not the instant lane.
- Persist a date key/unique job outcome so retries and restarts cannot duplicate
  a day's brief.
- Add optional ntfy delivery behind explicit configuration. In-app
  notification remains the source of truth; delivery failure is surfaced and
  retried without rerunning or duplicating the brief.
- Notification actions open the brief and expose task **Done** / **Snooze**
  actions. If native push actions are unavailable on a target, the notification
  opens the relevant in-app task card.

**Done when:** a seeded task due tomorrow appears in the 07:55 brief; one
notification is delivered; task actions from the brief update SQLite.

## Proof and rollout

1. Unit tests for each store, FTS writes, parser boundaries, URL safety, task
   transitions, brief idempotency, and job retry behavior.
2. Protocol fixture tests for any new task frames; bump `PROTOCOL_VERSION` only
   if a change is breaking and update `docs/protocol.md` in the same change.
3. Integration proof using a temporary SQLite database and mock model/provider:
   - save a memory, then retrieve it by topic;
   - save a URL with a note, then retrieve the original URL and note;
   - create a task due tomorrow, see it in the brief, snooze it, then complete
     it;
   - restart the daemon and confirm records and the day's brief survive;
   - force a brief retry and confirm it produces no duplicate thread or push.
4. Human end-to-end proof: capture a link and task from the Mac app, receive
   the 07:55 brief, and use a task action from its notification/card.
5. Run `bun test` and `bun run typecheck` before calling P2 complete.

## Out of scope for P2

Email/calendar, ACP/MCP, Android, bb-1 deployment, and generic shell/file tools
remain later phases. P2 does not add public URL fetching without SSRF controls,
automatic task completion, or outbound email.
