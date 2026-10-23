# Wire protocol v2

The contract between the server and every client (Mac app, Android app, CLI).
Machine version: [`packages/protocol/src/frames.ts`](../packages/protocol/src/frames.ts) —
if the two disagree, the code wins, then fix this doc.

## The conversation model (v2)

One **conversation** per agent is the user-facing chat: a single enduring
transcript, like texting a person. A **session block** is an invisible span of
context inside it — the model's working memory between boundaries. Blocks
close on `/new` (`manual`), when context pressure says so (`context`), or when
background work lands as its own block (`background`); each closing block is
compacted into a bounded carried summary that the next block opens with. The
`thread` frames stay for the CLI; clients built on the conversation model
never reason about thread ids.

## Envelope

- One WebSocket per client: `GET /ws` (HTTP upgrade). No auth on upgrade; the
  first frame must be `hello`.
- Frames are JSON text. Client frames carry no sequence number. **Every**
  server frame carries `seq`: a positive, monotonically increasing integer
  assigned by the server.
- A client that misses frames reconnects and sends `resync {lastSeq}`; the
  server replays every frame after `lastSeq`. If the gap is older than the
  bounded replay log, the client gets `error {code: "resync_gap"}` and reloads
  state from the server's durable storage.
- Handshake: connect → `hello {v, token, device}` → `hello.ok` +
  `agents.update`. `hello.ok` answers the connecting socket only and is not
  part of the replay log. The server closes connections that don't complete
  the handshake within `AGNI_HELLO_TIMEOUT_MS` (code 4001), on version mismatch
  (4002), or on a bad token (4003).
- `lastSeq` in `hello.ok` is the server's current sequence; a client whose own
  `lastSeq` is higher (server crash + restart) must treat the difference as a
  gap and reload.

## client → server

| Frame | Payload | Notes |
| --- | --- | --- |
| `hello` | `{v, token, device}` | First frame. `v` is the protocol version. |
| `resync` | `{lastSeq}` | Replay everything after `lastSeq`. |
| `msg.send` | `{threadID?, text, files?, conversationID?, channelId?, toAgentId?, texts?}` | Channel clients target a channel (default `main`) and may address an agent. `texts` batches multiple bodies; legacy clients continue to send `text`. A message sent while its thread is mid-turn is queued and runs when the turn ends; `stop` (or `cancel`, `never mind`) is a control message that interrupts that turn instead. |
| `user.typing` | `{channelId?, isTyping}` | Extends server-side message coalescing while the user is typing. |
| `agent.rename` | `{agentId, name}` | Renames an agent and completes primary-agent onboarding. |
| `agent.profile` | `{agentId, role?, visibility?}` | Edits an agent's profile from the app: `role` is the tag the roster shows ("chief of staff"), `visibility` is what other agents may see of its work (`private \| summary \| shared`). At least one field is required. The answer is an `agent.updated` carrying the new `role` and `visibility`; the same change the `update_agent` chat tool makes, so the two cannot drift apart. |
| `agent.create` | `{name, prompt, role?, id?, color?}` | Creates an agent from the app's roster — the "+" button. `prompt` is its system prompt, `role` its tag. The same creation the `create_agent` chat tool performs, so a bot made here and a bot made in chat are the same kind of thing; the roster comes back in an `agents.update`. |
| `form.answer` | `{requestID, answer}` | The owner answered a question the agent asked — the option they chose, or their own words if they typed instead of choosing. The answer lands on the `forms` row and the turn waiting on it carries on with it. |
| `msg.cancel` | `{turnID}` | Interrupts the turn: providers abort, partial output is kept. |
| `approve.reply` | `{requestID, decision}` | `decision`: `once \| always \| reject`. |
| `secret.reply` | `{requestID, value}` | The owner's one-time password for a `secret.request`. Consumed server-side; never persisted, replayed, logged, or sent to the model. |
| `secret.cancel` | `{requestID}` | Dismisses a pending secret prompt; the waiting tool fails as cancelled. |
| `agent.select` | `{agentID}` | Sets the persona for subsequent `msg.send` on this connection. |
| `conversation.open` | `{conversationID, agentID?}` | Resolves (creating when missing) the agent's conversation. Empty `conversationID` + `agentID` selects that agent's. Answer: `conversation.ok`. |
| `session.new` | `{conversationID}` | Closes the active session block (`manual`), compacts it into the carried summary, continues in a fresh block; emits `session.start`. |
| `conversation.history` | `{conversationID, limit?}` | The full transcript across blocks, last N chronological (default 50, max 500); each message carries its `sessionID`. |
| `thread.open` | `{threadID}` | Pins the session's active thread (CLI). Silent; history comes via `resync`. |
| `thread.export` | `{conversationID, title?}` | Render the conversation to one self-contained HTML file and answer with `thread.export.ok`. The daemon renders, not the client, so the artifact is identical everywhere; the file holds messages, tool calls, model reasoning, and approval decisions. |
| `thread.list` | `{limit?}` | Recent threads, newest first (default 20, max 200). |
| `thread.history` | `{threadID, limit?}` | Durable messages, last N chronological (default 50, max 500). |
| `job.list` | `{limit?}` | Tasks and routines, newest/next due first. |
| `job.set` | `{jobID, action}` | `action`: `pause \| resume \| run`. |
| `job.delete` | `{jobID}` | Deletes a task unless it is running; replies with a refreshed `job.list.ok`. |
| `task.list` | `{status?, limit?}` | Lists durable tasks and task lists; status is `open \| done \| snoozed \| all`. |
| `task.create` | `{title, description?, dueAt?, deadlineAt?, reminderAt?, labels?, repeatRule?, priority?, listID?, parentTaskID?, attachmentIDs?}` | Creates a task or subtask, optionally with a schedule, deadline, labels, repeat cadence and uploaded files. |
| `task.list.create` | `{name}` | Creates a task list and returns the current list navigation data. |
| `task.activity` | `{taskID}` | Reads the task's recent edit and status history. |
| `task.update` | `{taskID, action, until?, title?, description?, dueAt?, deadlineAt?, reminderAt?, labels?, repeatRule?, priority?, listID?}` | Completes, reopens, snoozes, or edits a task. |
| `task.answer` | `{taskID, questionID, text}` | Answers a question a delegated task asked. Its own frame, not a `msg.send`: the task must be in `needs_input`, the answer belongs to one question, and it is accepted exactly once. |
| `bind.direct` | `{agentID}` | Pins this client to an agent: the server resolves that agent's conversation, its active session block and its DM channel, and answers with them. |
| `provider.add` | `{providerID, apiKey, model?, baseUrl?, label?}` | Adds a supported API provider over the authenticated socket. `providerID: "custom"` adds an endpoint of the owner's own: `baseUrl` is an OpenAI-compatible base (`https://host/v1`), `label` names it in the list. The daemon stores the key in its mode-600 `.env` and the endpoint in `data/providers.json`; neither is ever returned. |
| `provider.model.set` | `{providerID, model}` | Changes a configured provider's model ID on the daemon and updates the live router. |
| `provider.auth.status` | `{providerID: "chatgpt"}` | Reads public ChatGPT connection/account metadata. Requires device authentication. |
| `provider.auth.start` | `{providerID: "chatgpt", accountID?}` | Starts official OAuth on the daemon host with a loopback callback, fresh PKCE/state/nonce. A saved account ID reuses its registration. Requires a local authenticated connection. |
| `provider.auth.cancel` | `{providerID: "chatgpt", loginID}` | Cancels the initiating device's pending login. |
| `provider.auth.select` | `{providerID: "chatgpt", accountID}` | Selects a saved connected account after loading its eligible model catalog. |
| `provider.auth.acknowledge` | `{providerID: "chatgpt", accountID}` | Persists dismissal of the first-sign-in ChatGPT plan notice for the selected registration. |
| `provider.auth.disconnect` | `{providerID: "chatgpt", accountID}` | Aborts active ChatGPT requests, clears local tokens, and attempts remote revocation. Keeps registration metadata for later sign-in. |
| `plugin.list` | `{}` | The plugin catalog bound to accounts (see below); answer: `plugin.list.ok`. |
| `appearance.list` | `{}` | Read the owner's named appearance profiles and active profile. |
| `appearance.save` | `{profile, activate?}` | Validate and upsert a versioned appearance profile; activates it unless `activate` is false. |
| `appearance.activate` | `{id}` | Select an existing profile for every connected client. |
| `appearance.delete` | `{id}` | Delete a named profile. |
| `plugin.connect` | `{pluginID, account}` | Begin connecting `pluginID` to `account` (`agent` = Agni's own, `owner` = the user's). OAuth kinds answer `plugin.connect.ok` with an authorize URL to open in the system browser; MCP kinds are not connectable until their server pass lands. |
| `plugin.configure` | `{pluginID, account, user?, pass?, key?, url?, clientID?, clientSecret?}` | Gives a plugin its credentials and connects it in one step. `app-password` kinds take `user` + `pass`; `api-key` kinds take `key` and/or `url`; `oauth` kinds take the Google `clientID` + `clientSecret`. The daemon writes them to its mode-600 `plugins.json` and answers `plugin.connect.ok` (with an authorize URL for OAuth). |
| `plugin.disconnect` | `{connectionID}` | Revokes the connection (server-side tokens deleted, Google revoke called); answers and fans out the refreshed snapshot. |

## Plugins

A plugin row binds one catalog entry to one account role. `capabilities` is
the owner's policy grid — `free` (no approval), `approval` (asks first), or
`off` (refuses) — and lives entirely server-side in plugin capability
policies; OAuth **scopes** (what Google granted) are separate from what the
server then allows the agent to do with them. Wrapped-form actions opened in a
browser complete back at the daemon's loopback redirect
(`/oauth/callback`):

| Frame | Payload | Notes |
| --- | --- | --- |
| `plugin.list.ok` | `{plugins: [PluginInfo]}` | Answer to `plugin.list` / `plugin.disconnect`; addressed to the requester, not replayed. |
| `appearance.list.ok` | `{profiles, activeID}` | Requester-only answer containing the current appearance library. |
| `appearance.updated` | `{profiles, activeID}` | Replayable appearance-library change broadcast to paired clients. |
| `plugin.connect.ok` | `{pluginID, account, authorizeURL}` | Open `authorizeURL` in the system browser; `null` when nothing is needed. |
| `plugin.state` | `{plugins: [PluginInfo]}` | Replayable snapshot emitted whenever a connection changes (browser callback landed, expired, errored, disconnected). |

`PluginInfo`: `{id, name, category: "google"\|"mcp", description,
authKind: "oauth"\|"mcp", account, scopes, capabilities,
available, connectionID?, status?: "disconnected"\|"pending"\|"connected"\|"error",
accountLabel?, error?, connectedAt?}`.

## server → client

| Frame | Payload | Notes |
| --- | --- | --- |
| `hello.ok` | `{v, serverTime, lastSeq}` | `lastSeq` = seq of this frame. |
| `token` | `{turnID, threadID, delta}` | One streaming chunk. |
| `turn.start` | `{turnID, threadID, agentID, conversationID?}` | Turn accepted; called before any `token`. |
| `turn.end` | `{turnID, threadID, stopReason, usage?, conversationID?}` | `stopReason`: `end \| cancelled \| error \| timeout \| budget`; `usage`: `{provider, model, inputTokens?, outputTokens?, latencyMs?}` (latencyMs is server-measured model call time). |
| `tool.start` | `{callID, name, preview?}` | Tool activity strip. |
| `tool.update` | `{callID, preview?}` | |
| `tool.end` | `{callID, ok, preview?}` | |
| `approval.request` | `{requestID, action, preview, buttons}` | `buttons`: subset of `once \| always \| reject`. |
| `secret.request` | `{requestID, purpose, command, kind, expiresAt, threadID?, conversationID?}` | A command needs the owner's password. The frame carries no secret; the owner types it into a secure field. Replayable on reconnect; expires after two minutes. |
| `secret.cancel` | `{requestID, reason}` | The prompt was resolved, expired, cancelled, or its turn stopped. Replayable. |
| `form.request` | `{requestID, question, options?, multiple?, kind?, email?}` | A question the agent put to the owner. `kind` is `choice` (a list of options) or `email` (a draft to approve: `email` carries `from`, `to`, `subject`, `body`). `multiple` means more than one option may be chosen. The owner answers on the `form.answer` frame — or types instead of choosing, which dismisses the question and steers the work with their message. |
| `notify` | `{title, body, sound?, threadID?}` | Push-worthy event; Mac opens the referenced thread when clicked. |
| `agents.update` | `{agents: [{id, name, color?, model?, role?, tools?, onboarded?, visibility?}]}` | Roster snapshot. `onboarded` is set once the agent has been named, which settles the "what should I call you?" prompt. `role` is what the agent is for, in the owner's words ("inbox manager"). `visibility` is what other agents may see of that agent's work: `private` (a receipt only), `summary` (one line) or `shared` (full text). |
| `thread.list.ok` | `{threads: [{id, agentID, title?, updatedAt}]}` | Answer to `thread.list`; addressed to the requester. |
| `thread.history.ok` | `{threadID, title?, messages: [{id, role, text, createdAt, turnID?}]}` | Answer to `thread.history`; addressed to the requester. |
| `conversation.ok` | `{conversationID, agentID, sessionID}` | Answer to `conversation.open`; `sessionID`: the active block, `""` before the first block. Addressed, not replayed. |
| `session.start` | `{conversationID, sessionID, reason}` | A block boundary inside the conversation; `reason`: `manual \| context \| background`. Replayable. |
| `conversation.history.ok` | `{conversationID, messages: [{id, role, text, createdAt, turnID?, sessionID?}]}` | Answer to `conversation.history`; addressed to the requester. Clients render a session divider wherever consecutive `sessionID`s differ. |
| `thread.export.ok` | `{conversationID, url, token, records, createdAt}` | Answer to `thread.export`; addressed to the requester, not replayed. `url` is absolute and served by this daemon at `GET /share/<token>`; the token is the only access control on the file, so it is never logged or replayed. |
| `job.list.ok` | `{jobs: [...]}` | Answer to `job.list`, `job.set`, or `job.delete`; addressed to the requester. |
| `task.list.ok` | `{tasks: [...], lists: [...]}` | Task snapshots include due date, deadline, priority, workflow status (`not_started`, `in_progress`, `ai_review`), current progress note, list/collection, labels, optional parent, notes, reminder time, repeat cadence and attachment IDs. Lists include open task counts. A delegation task also carries `ownerAgentId`, `origin`, `delegateState`, `jobId`, `result` and `resultRedacted`. The owner sees every result; `resultRedacted` is true when a result exists that this viewer may not see. |
| `task.create.ok` | `{task: {...}}` | Newly persisted task. |
| `task.list.create.ok` | `{lists: [...]}` | Updated task list navigation. |
| `task.activity.ok` | `{taskID, activity: [...]}` | Recent task activity, newest first. |
| `task.update.ok` | `{task: {...}}` | Updated task snapshot after a persisted state change. |
| `task.updated` | `{task: {...}}` | A delegated task changed state (queued, running, needs_input, done, failed). Replayable. |
| `task.answer.ok` | `{task: {...}}` | The answer was accepted; the task is running again. |
| `bind.direct.ok` | `{agentID, conversationID, sessionID, channelID}` | The client is bound to that agent's conversation; `sessionID` is the active block, `""` before the first one. Addressed, not replayed. |
| `provider.add.ok` | `{providers: [...]}` | Provider metadata after adding a key; contains no credentials. |
| `provider.auth.started` | `{providerID: "chatgpt", loginID, authorizeURL, expiresAt}` | Requester-only, never replayed. Opens OpenAI's authorization page. Contains no access, refresh, or ID token. |
| `provider.auth.state` | `{providerID: "chatgpt", connection}` | Public state: `status`, saved `accounts [{id,label,connected}]`, `activeAccountID`, selected `model`, eligible `models [{id,label}]`, optional safe `message` and first-sign-in `showWelcome`. Never includes credentials. |
| `presence` | `{state}` | `online \| offline`. |
| `status.update` | `{channelId, agentId?, text, transient}` | Activity text; transient updates clear on the next message. |
| `msg.new` | `{id, channelId, fromType, fromId, senderName, senderColor?, text, internal, uiHint?, toAgentId?, taskId?, questionId?, createdAt}` | Durable channel message; `uiHint` can be `onboarding_name_prompt`, `handoff_notice`, `progress`, `needs_input`, or `normal`. `toAgentId` names the agent a handoff notice is about, so the client can render the name as a link to that agent's chat. `taskId` + `questionId` mark a question from a delegated task: the client renders an answer field that sends `task.answer`. |
| `agent.updated` | `{agentId, displayName, onboarded, role?, visibility?}` | Agent rename/onboarding state changed. `role` and `visibility` are present when the change touched them (an `agent.profile` edit). |
| `error` | `{code, message, retryAfter?}` | See codes below. |

A task turn speaks in messages, not one growing reply: each completed assistant
message is published as its own ordinary `msg.new` after that message's `token`
chunks. Clients seal the streaming bubble under the durable `msg.new` id and
open a fresh bubble for the next chunks. `uiHint: "progress"` rows (`say`) are
separate messages and never seal the answer.

In the task lane the narration a model writes *between* its tool calls stays in
the model's own context: it is never published as a message and never streamed
to clients. Only `say` progress rows and the final answer become messages. A
turn that is backed by a channel (the web and Mac clients) buffers the answer's
deltas and emits it as one `token` frame before the `msg.new` that seals it, so
a channel client shows one bubble per answer; a direct client (the CLI) keeps
live streaming.

## Error codes (v2)

`bad_frame`, `unauthorized`, `version_mismatch`, `unknown_thread`, `unknown_conversation`,
`unknown_agent`, `unknown_request`, `unknown_job`, `unknown_task`,
`bad_task_action`, `capture_failed`, `job_running`, `no_provider`, `provider_failed`,
`unknown_provider`, `invalid_key`, `provider_exists`, `provider_storage`, `provider_auth`,
`unknown_plugin`, `unknown_connection`, `plugin_not_configured`, `plugin_unavailable`,
`plugin_connect_failed`, `unknown_background`, `resync_gap`, `internal`.

## Versioning

`PROTOCOL_VERSION` bumps on any breaking change (removed/renamed frame or
field, changed semantics). Additive optional fields do not bump the version;
clients must ignore unknown fields. The server rejects `hello` with an
unsupported `v` instead of guessing.

## Replay log (v1 bounds)

The server keeps the last `AGNI_FRAME_LOG_CAPACITY` outbound frames (default
1000) for `resync`. Deltas are frames too, so a client offline through a long
turn will likely reload rather than replay — by design: messages are durable
in SQLite, replay is a latency optimization, not a storage layer.

`hello.ok` and the `thread.list.ok` / `thread.history.ok` answers are for one
connection, not the shared stream: they consume a `seq` like every frame but
are skipped on replay. A client never "missed" a reply addressed to someone
else. Everything else — turns, tokens, tool strips, approvals, notifications —
is replayable.

### Attachments (additive v2 extension)

`msg.send.files` now carries up to five opaque uploaded attachment IDs, rather
than client filesystem paths. No existing shipped client sent paths before this
change: the Mac app sends `nil` and the CLI omits the field. Files must have
been uploaded by the sending device. Text remains required; the web app
uses "Please review the attached files." for an attachment-only message.
`msg.new` and history `MessageInfo` objects optionally include `attachments`:
`{ id, name, mimeType, size, kind: "image" | "text" | "pdf" }[]`.
Existing text-only clients remain compatible; no version bump is required.

File bytes use HTTP with `Authorization: Bearer <device-token>` (never a token
in a URL). `POST /attachments` accepts one multipart `file` and returns
`{attachment}`; `POST /attachments/validate` accepts `{ids}` and checks ownership
and vision availability before sending. `GET /attachments/:id` downloads a file;
`DELETE /attachments/:id` removes an unlinked draft owned by that device.
`GET /attachments` reports limits and whether a vision model is configured.
Paired devices share sent attachments; unlinked uploads remain private to their
uploading device. Unlinked files expire after 24 hours and are pruned on upload.

Limits: five files per message, 10 MB each, 500 MB total stored attachments;
images at most 8192 pixels on either side and 20 megapixels; UTF-8 text and PDF
extraction at most 60,000 characters per file; PDFs at most 100 pages with a
15-second extraction timeout. Model requests include at most five recent files
and 24,000 characters of extracted text, with explicit truncation notices.
Scanned PDFs, Office documents, audio, and video are not supported.
Image-capable configured model IDs are explicitly listed in `AGNI_VISION_MODELS`.
Provider failover for images only uses that allowlist. File contents are treated
as untrusted user data. Binary image content is expanded at the provider boundary,
not stored as base64 in session logs.

### Appearance profiles (additive v2 extension)

Appearance profiles are versioned semantic settings rather than CSS. Version 1
contains a name, light/dark/system mode, a built-in surface preset, an accent,
background settings, text scale, density, corner style, motion preference, and
agent-colour strength. The daemon stores named profiles and broadcasts the
active selection so web and Mac clients stay aligned. Clients may cache the
last active profile to avoid painting the default theme while reconnecting.

Background bytes use authenticated HTTP and are never conversation
attachments. `POST /backgrounds` accepts one PNG, JPEG, or WebP image up to
10 MB and returns `{id}`. `GET /backgrounds/:id` requires a paired-device
Bearer token. `DELETE /backgrounds/:id` refuses to remove an image referenced
by a saved profile. Paths are generated server-side, bytes are content-sniffed,
and the assets are never sent to a model. Theme JSON exports omit image bytes.
