/**
 * Client frame dispatch. One session per WebSocket connection:
 * connect → `hello` (token) → `hello.ok` + `agents.update` → frames.
 *
 * `msg.send` returns immediately and runs the turn detached, so `msg.cancel`
 * (and other frames) are processed while a turn streams.
 */
import type { Database } from "bun:sqlite";
import {
  PROTOCOL_VERSION,
  decodeText,
  isSupportedVersion,
  parseClientFrame,
  type ClientFrame,
  type JobInfo,
  type JobState,
  type ServerFrame,
  type ServerFrameBody,
  type TaskInfo,
} from "@agni/protocol";
import { defaultPersona, getPersona, personaInfo, mentionRoster, defaultResolvedPersona, resolvePersona, canonicalAgentID } from "../agent/personas";
import { renameAgent } from "../agent/identity";
import { resolveAgentMention } from "../agent/mentions";
import { runTaskTurn } from "../agent/task-loop";
import { resolveApprovalWaiter } from "../agent/approval-broker";
import { cancelSecret, listPendingSecrets, resolveSecret } from "../agent/secret-broker";
import { verifyToken } from "../auth/tokens";
import type { Config } from "../config";
import { log } from "../log";
import type { Router } from "../models/router";
import { addProviderCredential, setProviderModel } from "../models/provider-settings";
import {
  getJobByPrefix,
  listFinishedJobs,
  listJobs,
  parseJobPayload,
  deleteJob,
  setJobEnabled,
  wakeJob,
  type JobRow,
} from "../stores/jobs";
import { appendMessage, createThread, createTurn, finishTurn, getThread, listThreadsWithPreview, recentMessages, titleThreadFromFirstMessage, touchThread, type ThreadRow } from "../stores/threads";
import {
  activeSession,
  backgroundSession,
  conversationTranscript,
  ensureConversation,
  getConversation,
  type ConversationRow,
} from "../stores/conversations";
import { rolloverIfNeeded, rotate, rotateById } from "../agent/rollover";
import { bypassesBatch, classifyTurn } from "../agent/gate";
import type { TurnJobPayload } from "../jobs/turn";
import { newID, nowISO } from "../util/ids";
import { putAgentMemory, listAgentMemories, type AgentMemoryRow } from "../stores/agent-memories";
import { appendChannelMessage, ensureDMChannel, getChannel } from "../stores/channels";
import { canonicalURL, saveLink, searchLinks } from "../stores/links";
import { buildShareDocument, publishShare, shareBaseURL } from "../share/document";
import { createTask, getTask, listTasks, setTaskStatus, snoozeTask, cancelDelegation } from "../stores/tasks";
import { fetchPage } from "../tools/fetch-url";
import type { PluginService } from "../plugins/service";
import { pluginMailResolver } from "../plugins/credentials";
import type { FrameLog } from "./frame-log";

export interface Session {
  id: string;
  authed: boolean;
  device?: { id: string; name: string };
  agentID: string;
  openThreadID?: string;
  /** In-flight turns owned by this connection, cancellable via msg.cancel. */
  aborts: Map<string, AbortController>;
  helloTimer?: ReturnType<typeof setTimeout>;
}

export function newSession(): Session {
  return {
    id: newID("conn"),
    authed: false,
    agentID: defaultPersona().id,
    aborts: new Map(),
  };
}

export interface DispatchDeps {
  config: Config;
  db: Database;
  router: Router;
  frameLog: FrameLog;
  /** Assign a seq, record in the frame log, fan out to every authed session. */
  emit: (body: ServerFrameBody) => ServerFrame;
  /** Answer the connection that produced the current message (not replayed). */
  reply: (body: ServerFrameBody) => ServerFrame;
  /** Send one frame to the connection that produced the current message. */
  send: (frame: ServerFrame) => void;
  /** Close the connection that produced the current message. */
  close: (code: number, reason: string) => void;
  /** Plugin connections (catalog, connect flows, OAuth callbacks). */
  plugins?: PluginService;
}

export async function dispatch(deps: DispatchDeps, session: Session, raw: string): Promise<void> {
  const decoded = decodeText(raw);
  if (!decoded.ok) return sendError(deps, session, "bad_frame", decoded.error);
  const parsed = parseClientFrame(decoded.value);
  if (!parsed.ok) return sendError(deps, session, "bad_frame", parsed.error);

  const frame = parsed.frame;
  switch (frame.type) {
    case "hello":
      return handleHello(deps, session, frame);
    case "resync":
      return handleResync(deps, session, frame);
    case "msg.send":
      return handleMsgSend(deps, session, frame);
    case "msg.cancel":
      return handleMsgCancel(deps, session, frame);
    case "approve.reply":
      return handleApproveReply(deps, session, frame);
    case "secret.reply":
      return handleSecretReply(deps, session, frame);
    case "secret.cancel":
      return handleSecretCancel(deps, session, frame);
    case "agent.select":
      return handleAgentSelect(deps, session, frame);
    case "conversation.open":
      return handleConversationOpen(deps, session, frame);
    case "session.new":
      return void handleSessionNew(deps, session, frame);
    case "conversation.history":
      return handleConversationHistory(deps, session, frame);
    case "thread.open":
      return handleThreadOpen(deps, session, frame);
    case "thread.export":
      return handleThreadExport(deps, session, frame);
    case "thread.list":
      return handleThreadList(deps, session, frame);
    case "thread.history":
      return handleThreadHistory(deps, session, frame);
    case "job.list":
      return handleJobList(deps, session, frame);
    case "job.set":
      return handleJobSet(deps, session, frame);
    case "job.delete":
      return handleJobDelete(deps, session, frame);
    case "task.list":
      return handleTaskList(deps, session, frame);
    case "task.update":
      return handleTaskUpdate(deps, session, frame);
    case "provider.add":
      return await handleProviderAdd(deps, session, frame);
    case "provider.model.set":
      return await handleProviderModelSet(deps, session, frame);
    case "provider.models.list":
      return await handleProviderModelsList(deps, session, frame);
    case "plugin.list":
      return handlePluginList(deps, session);
    case "plugin.connect":
      return await handlePluginConnect(deps, session, frame);
    case "plugin.configure":
      return await handlePluginConfigure(deps, session, frame);
    case "plugin.disconnect":
      return await handlePluginDisconnect(deps, session, frame);
    case "user.typing":
      return handleUserTyping(deps, session, frame);
    case "agent.rename":
      return handleAgentRename(deps, session, frame);
  }
}

// ---------------------------------------------------------------------------

function handleHello(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "hello" }>): void {
  if (session.authed) return sendError(deps, session, "bad_frame", "hello already received");
  if (!isSupportedVersion(frame.v)) {
    sendError(deps, session, "version_mismatch", `server speaks protocol v${PROTOCOL_VERSION}`);
    deps.close(4002, "version mismatch");
    return;
  }
  void verifyToken(deps.db, frame.token).then((device) => {
    if (!device) {
      sendError(deps, session, "unauthorized", "unknown or revoked token — pair a device first");
      deps.close(4003, "unauthorized");
      return;
    }
    session.authed = true;
    session.device = { id: device.id, name: device.name };
    if (session.helloTimer !== undefined) {
      clearTimeout(session.helloTimer);
      session.helloTimer = undefined;
    }
    log.info(`hello from "${device.name}" (${device.id}) as agent ${session.agentID}`);
    // lastSeq must equal the seq this very frame is about to receive; no
    // await can interleave between the read and the reply, so this is exact.
    // The handshake answer goes only to this connection and stays out of the
    // replay log — other clients never see it, and it is not stream state.
    deps.reply({
      type: "hello.ok",
      v: PROTOCOL_VERSION,
      serverTime: nowISO(),
      lastSeq: deps.frameLog.seq + 1,
    });
    deps.emit({ type: "agents.update", agents: personaInfo(deps.db), mentions: mentionRoster(deps.db) });
    // A reconnect must not lose a password prompt that is still waiting.
    for (const pendingSecret of listPendingSecrets()) {
      deps.reply({
        type: "secret.request",
        requestID: pendingSecret.id,
        purpose: pendingSecret.purpose,
        command: pendingSecret.command,
        kind: pendingSecret.kind,
        expiresAt: pendingSecret.expiresAt,
        ...(pendingSecret.threadID ? { threadID: pendingSecret.threadID } : {}),
        ...(pendingSecret.conversationID ? { conversationID: pendingSecret.conversationID } : {}),
      });
    }
    emitOnboardingIfNeeded(deps);
  });
}

function handleResync(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "resync" }>): void {
  if (!requireAuth(deps, session)) return;
  const { frames, gap, oldest } = deps.frameLog.since(frame.lastSeq);
  if (gap) {
    sendError(deps, session, "resync_gap", `cannot replay from ${frame.lastSeq}; oldest replayed frame is ${oldest}`);
    return;
  }
  for (const replay of frames) deps.send(replay);
}

interface PendingMessageBatch {
  texts: string[];
  frame: Extract<ClientFrame, { type: "msg.send" }>;
  session: Session;
  firstAt: number;
  typing: boolean;
  timer: ReturnType<typeof setTimeout>;
}

const messageBatches = new WeakMap<DispatchDeps, Map<string, PendingMessageBatch>>();

function batchKey(frame: Extract<ClientFrame, { type: "msg.send" }>, session: Session): string {
  return `${frame.channelId ?? frame.conversationID ?? frame.threadID ?? session.agentID}:${frame.toAgentId ?? session.agentID}`;
}

function handleMsgSend(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "msg.send" }>): void {
  if (!requireAuth(deps, session)) return;

  const parts = frame.texts?.length ? frame.texts : (frame.text.trim() ? [frame.text] : []);
  if (parts.length === 0) return sendError(deps, session, "bad_frame", "msg.send needs text or a non-empty texts array");
  // GATE-003: explicit remember/task commands are processed immediately — the
  // debounce exists to merge a burst of chat, not to delay a direct command.
  const gate = classifyTurn(parts.join("\n\n"));
  if (bypassesBatch(gate.category)) {
    void runUserMessage(deps, session, frame, parts.join("\n\n"));
    return;
  }
  const batches = messageBatches.get(deps) ?? new Map<string, PendingMessageBatch>();
  messageBatches.set(deps, batches);
  const key = batchKey(frame, session);
  const existing = batches.get(key);
  if (existing) {
    existing.texts.push(...parts);
    existing.frame = frame;
    existing.session = session;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushMessageBatch(deps, key), 800);
    return;
  }

  const pending: PendingMessageBatch = {
    texts: [...parts],
    frame,
    session,
    firstAt: Date.now(),
    typing: false,
    timer: setTimeout(() => flushMessageBatch(deps, key), 800),
  };
  batches.set(key, pending);
  deps.emit({
    type: "status.update",
    channelId: frame.channelId ?? "main",
    agentId: frame.toAgentId,
    text: "Got it, looking into this…",
    transient: true,
  });
}

function handleUserTyping(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "user.typing" }>): void {
  if (!requireAuth(deps, session)) return;
  const batches = messageBatches.get(deps);
  if (!batches) return;
  const prefix = `${frame.channelId ?? session.agentID}:`;
  for (const [key, batch] of batches) {
    if (!key.startsWith(prefix)) continue;
    batch.typing = frame.isTyping;
    if (!frame.isTyping) {
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => flushMessageBatch(deps, key), 0);
    }
  }
}

function flushMessageBatch(deps: DispatchDeps, key: string): void {
  const batches = messageBatches.get(deps);
  const batch = batches?.get(key);
  if (!batches || !batch) return;
  const elapsed = Date.now() - batch.firstAt;
  if (batch.typing && elapsed < 2_000) {
    batch.timer = setTimeout(() => flushMessageBatch(deps, key), Math.min(800, 2_000 - elapsed));
    return;
  }
  batches.delete(key);
  void runUserMessage(deps, batch.session, batch.frame, batch.texts.join("\n\n"));
}

async function runUserMessage(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "msg.send" }>,
  text: string,
): Promise<void> {

  // `@friday write the email` is a message to Friday, not to whatever chat
  // is open. Routing happens before the turn starts: the text is appended to
  // that agent's DM and the executive assistant never sees it.
  const mention = resolveAgentMention(deps.db, text);
  const routedText = mention?.text ?? text;
  // The executive assistant's surface is `main`, not a DM channel; an
  // `@agni` mention must not create a second, invisible room.
  const mentionChannelID = mention
    ? canonicalAgentID(mention.agentID) === "ea"
      ? "main"
      : `dm:${mention.agentID}`
    : null;
  const channelID = mentionChannelID ?? frame.channelId ?? "main";
  const channelAgentID = mention && mentionChannelID !== "main" ? mention.agentID : frame.toAgentId;
  let channel = getChannel(deps.db, channelID);
  if (!channel && channelAgentID && channelID === `dm:${channelAgentID}`) {
    channel = ensureDMChannel(deps.db, channelAgentID);
  }
  if (frame.channelId && !channel && !mention) return sendError(deps, session, "unknown_channel", `no channel ${frame.channelId}`);
  const requestedAgentID = mention?.agentID ?? frame.toAgentId ?? (frame.channelId ? channel?.agent_id : session.agentID) ?? session.agentID;

  // While the primary assistant is waiting for its first name, an ordinary
  // main-channel message is treated as the answer to the inline prompt.
  const onboardingPrompt = deps.db.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM channel_messages WHERE channel_id = 'main' AND ui_hint = 'onboarding_name_prompt'",
  ).get()?.count ?? 0;
  const primary = deps.db.query<{ onboarded: number }, []>("SELECT onboarded FROM agents WHERE id = 'ea'").get();
  if (!mention && frame.channelId === "main" && channelID === "main" && primary?.onboarded === 0 && onboardingPrompt > 0) {
    completeAgentRename(deps, "ea", text);
    return;
  }

  let thread;
  let conversationID: string | undefined;
  let carrySummary: string | null = null;
  if (mention || frame.channelId || frame.toAgentId) {
    const conversation = ensureConversation(deps.db, requestedAgentID);
    const result = await rolloverIfNeeded(rolloverDeps(deps), conversation);
    thread = getThread(deps.db, result.threadID);
    if (!thread) return sendError(deps, session, "internal", "channel conversation has no active session");
    conversationID = conversation.id;
    carrySummary = result.carry;
    if (result.rolledOver && result.reason !== "none") {
      deps.emit({ type: "session.start", conversationID: conversation.id, sessionID: thread.id, reason: result.reason });
    }
  } else if (frame.conversationID) {
    // v2 path: send into the conversation's active session block, rolling a
    // context-pressure block over first when needed.
    const conversation = getConversation(deps.db, frame.conversationID);
    if (!conversation) return sendError(deps, session, "unknown_conversation", `no conversation ${frame.conversationID}`);
    const result = await rolloverIfNeeded(rolloverDeps(deps), conversation);
    thread = getThread(deps.db, result.threadID);
    if (!thread) return sendError(deps, session, "internal", "session rotation produced no thread");
    conversationID = conversation.id;
    carrySummary = result.carry;
    if (result.rolledOver && result.reason !== "none") {
      deps.emit({ type: "session.start", conversationID: conversation.id, sessionID: thread.id, reason: result.reason });
    }
  } else if (frame.threadID) {
    thread = getThread(deps.db, frame.threadID);
    if (!thread) return sendError(deps, session, "unknown_thread", `no thread ${frame.threadID}`);
    // The CLI path still binds: a block carries its conversation along.
    if (thread.conversation_id) {
      conversationID = thread.conversation_id;
      carrySummary = getConversation(deps.db, conversationID)?.summary ?? null;
    }
  } else {
    // Empty threadID is the CLI's "/new": rotate the agent's conversation —
    // same seam the Mac app gets from session.new.
    const result = await rotate(rolloverDeps(deps), session.agentID, "manual");
    thread = getThread(deps.db, result.threadID);
    if (!thread) return sendError(deps, session, "internal", "conversation rotation failed");
    conversationID = result.conversationID;
    carrySummary = result.carry;
    deps.emit({ type: "session.start", conversationID: result.conversationID, sessionID: thread.id, reason: "manual" });
  }

  const persona = resolvePersona(deps.db, requestedAgentID) ?? resolvePersona(deps.db, thread.agent_id) ?? defaultResolvedPersona(deps.db);
  // GATE-001: classify before the turn runs so the durable row carries its
  // salience. Temp turns stay visible in the transcript and the recent window
  // but are skipped by compaction (GATE-002, MEM/TAG).
  const gate = classifyTurn(routedText);
  if (channel) {
    const userMessage = appendChannelMessage(deps.db, {
      channelID,
      fromType: "user",
      fromID: session.device?.id ?? "user",
      toAgentID: mention?.agentID ?? frame.toAgentId ?? null,
      text: routedText,
      salience: gate.salience,
    });
    deps.emit({
      type: "msg.new", id: userMessage.id, channelId: channelID, fromType: "user",
      fromId: userMessage.from_id, senderName: session.device?.name ?? "You", text: routedText,
      internal: false, uiHint: "normal", createdAt: userMessage.created_at,
    });
  }
  if (isCapture(routedText) || isStoreQuery(routedText)) {
    void captureMessage(deps, session, thread, persona.id, routedText);
    return;
  }
  const turnID = newID("trn");
  const controller = new AbortController();
  session.aborts.set(turnID, controller);
  const turnSettings = {
    firstTokenTimeoutMs: deps.config.firstTokenTimeoutMs,
    turnTimeoutMs: deps.config.turnTimeoutMs,
    // Mailboxes the owner connected in Settings → Plugins.
    mailAccounts: pluginMailResolver(deps.config.pluginsPath),
  };
  const turn = runTaskTurn(deps.db, deps.router, turnSettings, {
    turnID,
    threadID: thread.id,
    text: routedText,
    persona,
    conversationID,
    carrySummary,
    emit: deps.emit,
    signal: controller.signal,
    channelID: channel ? channelID : undefined,
  });

  void turn
    .catch((error: unknown) => {
      // The turn runner reports its own failures through frames; landing here
      // means something unexpected (e.g. the database) failed.
      log.error("turn crashed", error);
      deps.emit({ type: "error", code: "internal", message: error instanceof Error ? error.message : String(error) });
    })
    .finally(() => {
      session.aborts.delete(turnID);
    });
}

function isCapture(text: string): boolean {
  // `remember:` / `add task:` are explicit capture commands.
  if (/^\s*(remember\s*:|add task\s*:)/i.test(text)) return true;
  // A bare URL drop (with at most a short note) is captured for later.
  // A message that asks to open/fetch/inspect/explain/curl/read a page is
  // NOT a capture: it must run as a normal turn so the agent can fetch and
  // explain the page instead of saving it and saying "saved for later".
  if (!/https?:\/\/\S+/i.test(text)) return false;
  if (/\b(open|curl|inspect|fetch|explain|read|look\s+at|view|describe|summarize|analy[sz]e|check\s+out|browse|visit|show\s+me|what\s+is|tell\s+me|how\s+does|summarise)\b/i.test(text)) return false;
  const withoutUrl = text.replace(/https?:\/\/\S+/i, "").trim();
  return withoutUrl.length <= 60;
}

function isStoreQuery(text: string): boolean {
  return /^\s*(search memory|search memories|search links|find saved links|what do you remember|list tasks|what tasks)\s*:?/i.test(text);
}

async function captureMessage(deps: DispatchDeps, session: Session, thread: ThreadRow, agentID: string, text: string): Promise<void> {
  const threadID = thread.id;
  const conversationID = thread.conversation_id ?? undefined;
  const turnID = newID("trn");
  try {
    createTurn(deps.db, { id: turnID, threadID, agentID });
    appendMessage(deps.db, { threadID, turnID, role: "user", text });
    titleThreadFromFirstMessage(deps.db, threadID, text);
    deps.emit({ type: "turn.start", turnID, threadID, agentID, ...(conversationID ? { conversationID } : {}) });
    let confirmation: string;
    const memory = text.match(/^\s*remember\s*:\s*([\s\S]+)$/i);
    const task = text.match(/^\s*add task\s*:\s*([\s\S]+)$/i);
    if (isStoreQuery(text)) {
      const query = text.replace(/^\s*(?:search memories?|search links|find saved links|what do you remember|list tasks|what tasks)\s*:?\s*/i, "").trim();
      if (/^(list tasks|what tasks)/i.test(text)) {
        const rows = listTasks(deps.db, { status: "open", limit: 10, includeSnoozed: true });
        confirmation = rows.length ? `Open tasks:\n${rows.map((row) => `• ${row.title}${row.due_at ? ` — due ${row.due_at.slice(0,10)}` : ""} · ${row.priority} · ${row.status}`).join("\n")}` : "You have no open tasks.";
      } else {
        const linksQuery = /^\s*(search links|find saved links)/i.test(text);
        if (linksQuery) {
          const rows = searchLinks(deps.db, query, 8);
          confirmation = rows.length ? `Saved links:\n${rows.map((row) => `• ${row.title ?? row.url} — ${row.url}${row.note ? ` · ${row.note}` : ""} [${row.id}]`).join("\n")}` : `No saved links matched${query ? ` “${query}”` : ""}.`;
        } else {
          const matching = listAgentMemories(deps.db, { scope: "global_user", limit: 8, query });
          confirmation = matching.length ? `Saved memories:\n${matching.map((row) => `• ${row.content} [${row.id}]`).join("\n")}` : `No saved memories matched${query ? ` “${query}”` : ""}.`;
        }
      }
    } else if (memory) {
      const body = memory[1]!.trim();
      const parsed = body.match(/^(.*?)(?:\s+#tags?\s+(.+))?$/i);
      const record = putAgentMemory(deps.db, {
        scope: "global_user",
        agentID: null,
        keySlug: `memory-${parsed?.[1]?.trim().slice(0, 40) || body.slice(0, 40)}`,
        type: "fact",
        content: parsed?.[1]?.trim() || body,
        tags: parsed?.[2] ? parsed[2].split(/[ ,]+/) : undefined,
      });
      confirmation = `Noted — ${record.content.replace(/[.!?]+$/, "")}.`;
    } else if (task) {
      const parsed = parseTaskCapture(task[1]!);
      const record = createTask(deps.db, { ...parsed, ownerDeviceID: session.device?.id });
      // Speak like a person confirming, not a database receipt: no ids, no
      // priority recital unless it deviates from normal.
      confirmation = `On the list: “${record.title}”`;
      if (record.due_at) confirmation += ` — due ${record.due_at.slice(0, 10)}`;
      if (record.priority === "high") confirmation += ", marked high priority";
      confirmation += ".";
    } else {
      const urlMatch = text.match(/https?:\/\/[^\s<>]+/i);
      if (!urlMatch) throw new Error("no supported capture found");
      const rawURL = urlMatch[0].replace(/[),.;!?]+$/, "");
      const url = canonicalURL(rawURL);
      const note = text.replace(urlMatch[0], "").trim() || null;
      let page: { title: string|null; summary: string|null } = { title: null, summary: null };
      let fetchError: string | undefined;
      try { page = await fetchPage(url); } catch (error) { fetchError = error instanceof Error ? error.message : String(error); }
      const record = saveLink(deps.db, { url, ...page, note, ownerDeviceID: session.device?.id });
      const label = record.title ? `“${record.title}”` : "the link";
      // The note is the user's own words — kept with the link, recited back
      // only when it is short enough to read naturally.
      const notePart = note
        ? note.length <= 60 ? ` and your note — “${note}”` : " and your note"
        : "";
      confirmation = fetchError
        ? `Saved ${label}${notePart}. I couldn't read the page details this time — the link is kept, so it should still open.`
        : `Saved ${label}${notePart} for later.`;
    }
    appendMessage(deps.db, { threadID, turnID, role: "assistant", text: confirmation });
    finishTurn(deps.db, { id: turnID, stopReason: "end" });
    touchThread(deps.db, threadID);
    deps.emit({ type: "token", turnID, threadID, delta: confirmation });
    deps.emit({ type: "turn.end", turnID, threadID, stopReason: "end", ...(conversationID ? { conversationID } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { finishTurn(deps.db, { id: turnID, stopReason: "error" }); } catch { /* turn may not have been created */ }
    deps.emit({ type: "error", code: "capture_failed", message });
    deps.emit({ type: "turn.end", turnID, threadID, stopReason: "error" });
  }
}

function parseTaskCapture(value: string): { title: string; dueAt?: string; priority?: "low"|"normal"|"high" } {
  let title = value.trim(), dueAt: string | undefined, priority: "low"|"normal"|"high" = "normal";
  const p = title.match(/\s+priority\s*:\s*(low|normal|high)\s*$/i);
  if (p) { priority = p[1]!.toLowerCase() as typeof priority; title = title.slice(0,p.index).trim(); }
  const due = title.match(/\s+by\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s*$/i);
  if (due) {
    const date = due[1]!;
    const parsed = new Date(`${date}T${due[2] ?? "23:59"}:00`);
    const [year, month, day] = date.split("-").map(Number);
    if (!Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) throw new Error("that due date is invalid; use YYYY-MM-DD");
    dueAt = parsed.toISOString();
    title = title.slice(0,due.index).trim();
  } else if (/\bby\s+\S+/i.test(title)) {
    throw new Error("the due date is ambiguous; use `by YYYY-MM-DD` so it is saved accurately");
  }
  if (!title) throw new Error("task title is required");
  return { title, ...(dueAt ? { dueAt } : {}), priority };
}

function handleTaskList(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame,{type:"task.list"}>): void {
  if (!requireAuth(deps,session)) return;
  const status = frame.status ?? "open";
  deps.reply({ type:"task.list.ok", tasks:listTasks(deps.db,{status,limit:frame.limit,includeSnoozed:status==="open"}).map(taskSnapshot) });
}

function handleTaskUpdate(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame,{type:"task.update"}>): void {
  if (!requireAuth(deps,session)) return;
  const old=getTask(deps.db,frame.taskID);
  if(!old)return sendError(deps,session,"unknown_task",`no task ${frame.taskID}`);
  try {
    if (frame.action === "cancel") {
      const cancelled = cancelDelegation(deps.db, old.id);
      if (!cancelled) return sendError(deps, session, "unknown_task", `no task ${frame.taskID}`);
      deps.reply({ type: "task.update.ok", task: taskSnapshot(cancelled) });
      return;
    }
    const updated=frame.action==="done"?setTaskStatus(deps.db,old.id,"done"):
      frame.action==="reopen"?setTaskStatus(deps.db,old.id,"open"):
      frame.until?snoozeTask(deps.db,old.id,frame.until):null;
    if(!updated)return sendError(deps,session,"bad_task_action","snooze requires an ISO timestamp in the future");
    deps.reply({type:"task.update.ok",task:taskSnapshot(updated)});
  } catch(error) { sendError(deps,session,"bad_task_action",error instanceof Error?error.message:String(error)); }
}

function taskSnapshot(task: ReturnType<typeof listTasks>[number]): TaskInfo {
  const delegateState = (["none", "queued", "running", "needs_input", "done", "failed"] as const).includes(
    task.delegate_state as "none",
  )
    ? (task.delegate_state as TaskInfo["delegateState"])
    : "none";
  return {
    id: task.id, title: task.title, dueAt: task.due_at, priority: task.priority, status: task.status,
    snoozedUntil: task.snoozed_until, createdAt: task.created_at, updatedAt: task.updated_at,
    ownerAgentId: task.owner_agent_id,
    origin: task.origin === "ea_delegated" ? "ea_delegated" : "user_direct",
    delegateState,
    jobId: task.job_id,
    result: task.result,
  };
}

/** Model-call deps for the conversation seam (summary generation, rollovers). */
function rolloverDeps(deps: DispatchDeps): { db: Database; router: Router; firstTokenTimeoutMs: number } {
  return { db: deps.db, router: deps.router, firstTokenTimeoutMs: deps.config.firstTokenTimeoutMs };
}

/**
 * Conversation model (v2). `conversationID` empty + `agentID` selects or
 * creates the agent's one conversation; the answer binds the client to it
 * for later `msg.send { conversationID }` turns.
 */
function handleConversationOpen(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "conversation.open" }>,
): void {
  if (!requireAuth(deps, session)) return;
  let conversation: ConversationRow | null;
  if (frame.conversationID) {
    conversation = getConversation(deps.db, frame.conversationID);
    if (!conversation) return sendError(deps, session, "unknown_conversation", `no conversation ${frame.conversationID}`);
  } else {
    conversation = ensureConversation(deps.db, frame.agentID ?? session.agentID);
  }
  const active = activeSession(deps.db, conversation);
  deps.reply({
    type: "conversation.ok",
    conversationID: conversation.id,
    agentID: conversation.agent_id,
    sessionID: active?.id ?? "",
  });
}

/** Pressing /new: close the active block into the carry, continue fresh. */
async function handleSessionNew(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "session.new" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  const conversation = getConversation(deps.db, frame.conversationID);
  if (!conversation) return sendError(deps, session, "unknown_conversation", `no conversation ${frame.conversationID}`);
  const result = await rotateById(rolloverDeps(deps), conversation.id, "manual");
  // Stream state, not a reply: every client renders the same boundary.
  deps.emit({ type: "session.start", conversationID: result.conversationID, sessionID: result.threadID, reason: "manual" });
}

/** The durable transcript across session blocks, for the one chat surface. */
function handleConversationHistory(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "conversation.history" }>,
): void {
  if (!requireAuth(deps, session)) return;
  if (!getConversation(deps.db, frame.conversationID)) {
    return sendError(deps, session, "unknown_conversation", `no conversation ${frame.conversationID}`);
  }
  const messages: Array<{
    id: string; role: string; text: string; createdAt: string; turnID?: string; sessionID?: string;
    senderName?: string; senderColor?: string; uiHint?: string;
  }> = conversationTranscript(deps.db, frame.conversationID, frame.limit ?? 200).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.created_at,
    sessionID: message.sessionID,
  }));
  const conversation = getConversation(deps.db, frame.conversationID)!;
  {
    // `agni` is the legacy id for the same assistant as `ea`; both read and
    // write the main channel, so normalize before choosing the surface.
    const channelID = canonicalAgentID(conversation.agent_id) === "ea" ? "main" : `dm:${conversation.agent_id}`;
    const channelRows = deps.db.query<{
      id: string; text: string; created_at: string; turn_id: string | null;
      from_id: string; from_type: string; sender_name: string | null; sender_color: string | null;
      device_name: string | null; ui_hint: string | null; sender_onboarded: number | null;
      to_agent_id: string | null;
    }, [string]>(`SELECT cm.id, cm.text, cm.created_at, cm.turn_id, cm.from_id, cm.from_type,
      a.display_name AS sender_name, a.avatar_color AS sender_color, d.name AS device_name, cm.ui_hint,
      a.onboarded AS sender_onboarded, cm.to_agent_id
      FROM channel_messages cm
      LEFT JOIN agents a ON a.id = cm.from_id
      LEFT JOIN devices d ON d.id = cm.from_id
      WHERE cm.channel_id = ? AND cm.internal = 0 ORDER BY cm.created_at, cm.rowid`).all(channelID);
    for (const row of channelRows) {
      // Role comes from `from_type`, not from comparing `from_id` to "user":
      // a client message stores the *device* id, which made reloaded user
      // messages render as agent messages named after the device.
      const role = row.from_type === "user" ? "user" : row.from_type === "system" ? "system" : "assistant";
      // The name prompt is settled once the agent has a name: the field must
      // not come back every time the thread is loaded.
      const uiHint =
        row.ui_hint === "onboarding_name_prompt" && row.sender_onboarded === 1
          ? "onboarding_completed"
          : row.ui_hint ?? undefined;
      const messageData = {
        id: row.id, role, text: row.text, createdAt: row.created_at, turnID: row.turn_id ?? undefined,
        senderName: role === "user"
          ? row.device_name ?? "You"
          : row.sender_name ?? row.from_id,
        senderColor: row.sender_color ?? undefined, uiHint,
        // A handoff notice names the agent it is about, so the client can
        // make that name a link to that agent's chat.
        ...(row.to_agent_id ? { toAgentId: row.to_agent_id } : {}),
      };
      const duplicateIndex = messages.findIndex((message) =>
        message.role === role && message.text === row.text
          && Math.abs(Date.parse(message.createdAt) - Date.parse(row.created_at)) < 30_000,
      );
      if (duplicateIndex >= 0) messages[duplicateIndex] = { ...messages[duplicateIndex], ...messageData };
      else messages.push(messageData);
    }
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  deps.reply({ type: "conversation.history.ok", conversationID: frame.conversationID, messages });
}

/**
 * Render the conversation to a shareable HTML file and answer with the link.
 *
 * The daemon renders rather than the client so the artifact is the same
 * everywhere, and so a link can be handed to someone who has never installed
 * the app. The file is written next to the database; the token in the URL is
 * the only thing keeping it from being world-readable on this host.
 */
function handleThreadExport(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.export" }>,
): void {
  if (!requireAuth(deps, session)) return;
  try {
    const doc = buildShareDocument(deps.db, {
      conversationID: frame.conversationID,
      ...(frame.title ? { title: frame.title } : {}),
    });
    const published = publishShare(doc, {
      // Prefer the address the daemon was configured with over a re-read of
      // the environment — it knows what it bound to.
      baseURL: shareBaseURL({ AGNI_HOST: deps.config.host, AGNI_PORT: String(deps.config.port) }),
    });
    deps.reply({
      type: "thread.export.ok",
      conversationID: frame.conversationID,
      url: published.url,
      token: published.token,
      records: doc.records.length,
      createdAt: doc.createdAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(deps, session, message.startsWith("unknown conversation") ? "unknown_conversation" : "export_failed", message);
  }
}

function handleMsgCancel(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "msg.cancel" }>): void {
  if (!requireAuth(deps, session)) return;
  const controller = session.aborts.get(frame.turnID);
  if (!controller) {
    log.debug(`cancel for unknown/complete turn ${frame.turnID}`);
    return;
  }
  controller.abort();
}

function handleApproveReply(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "approve.reply" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const result = deps.db.run(
    "UPDATE approvals SET status = 'decided', decision = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    [frame.decision, nowISO(), frame.requestID],
  );
  if (result.changes === 0) {
    sendError(deps, session, "unknown_request", `no pending approval ${frame.requestID}`);
  }
  resolveApprovalWaiter(frame.requestID, frame.decision);
}

/**
 * The secret is consumed here and handed straight to the waiting tool. It is
 * deliberately not logged, persisted, or echoed back in any frame.
 */
function handleSecretReply(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "secret.reply" }>,
): void {
  if (!requireAuth(deps, session)) return;
  if (!resolveSecret(frame.requestID, frame.value)) {
    sendError(deps, session, "unknown_request", `no pending secret request ${frame.requestID}`);
  }
}

function handleSecretCancel(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "secret.cancel" }>,
): void {
  if (!requireAuth(deps, session)) return;
  if (!cancelSecret(frame.requestID, "cancelled by owner")) {
    sendError(deps, session, "unknown_request", `no pending secret request ${frame.requestID}`);
  }
}

function handleAgentSelect(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "agent.select" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const persona = getPersona(frame.agentID);
  if (!persona) return sendError(deps, session, "unknown_agent", `no agent ${frame.agentID}`);
  session.agentID = persona.id;
}

function handleThreadOpen(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.open" }>,
): void {  if (!requireAuth(deps, session)) return;
  const thread = getThread(deps.db, frame.threadID);
  if (!thread) return sendError(deps, session, "unknown_thread", `no thread ${frame.threadID}`);
  // No frames in response: history arrives through resync replay, live
  // activity through the normal stream. This just pins the session's thread.
  session.openThreadID = thread.id;
}

function handleThreadList(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.list" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const threads = listThreadsWithPreview(deps.db, frame.limit ?? 20).map((thread) => {
    return {
      id: thread.id,
      agentID: thread.agent_id,
      ...(thread.title ? { title: thread.title } : {}),
      updatedAt: thread.updated_at,
      ...(thread.preview ? { preview: thread.preview } : {}),
    };
  });
  deps.reply({ type: "thread.list.ok", threads });
}

function handleThreadHistory(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "thread.history" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const thread = getThread(deps.db, frame.threadID);
  if (!thread) return sendError(deps, session, "unknown_thread", `no thread ${frame.threadID}`);
  const messages = recentMessages(deps.db, thread.id, frame.limit ?? 50).map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.created_at,
    ...(message.turn_id ? { turnID: message.turn_id } : {}),
  }));
  deps.reply({
    type: "thread.history.ok",
    threadID: thread.id,
    ...(thread.title ? { title: thread.title } : {}),
    messages,
  });
}

/**
 * The routine list the Mac app's inspector shows: everything queued or
 * running, then the last handful of finished jobs so "what did it last do"
 * has an answer. A paused routine is listed too — pausing hides nothing.
 */
function handleJobList(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "job.list" }>,
): void {
  if (!requireAuth(deps, session)) return;
  deps.reply({ type: "job.list.ok", jobs: jobSnapshot(deps.db, frame.limit ?? 50) });
}

function handleJobSet(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "job.set" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const job = getJobByPrefix(deps.db, frame.jobID);
  if (!job) return sendError(deps, session, "unknown_job", `no job ${frame.jobID}`);

  switch (frame.action) {
    case "pause":
      setJobEnabled(deps.db, job.id, false);
      break;
    case "resume":
      setJobEnabled(deps.db, job.id, true);
      break;
    case "run":
      // "Run now" resumes a paused job: a claim would skip it otherwise.
      wakeJob(deps.db, job.id);
      break;
  }
  // The write answers with the fresh list, so toggles never drift from truth.
  deps.reply({ type: "job.list.ok", jobs: jobSnapshot(deps.db, 50) });
}

function handleJobDelete(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "job.delete" }>,
): void {
  if (!requireAuth(deps, session)) return;
  const job = getJobByPrefix(deps.db, frame.jobID);
  if (!job) return sendError(deps, session, "unknown_job", `no job ${frame.jobID}`);
  if (!deleteJob(deps.db, job.id)) {
    return sendError(deps, session, "job_running", `task ${job.id} is running and cannot be deleted yet`);
  }
  deps.reply({ type: "job.list.ok", jobs: jobSnapshot(deps.db, 50) });
}

async function handleProviderAdd(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "provider.add" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  const result = await addProviderCredential(deps.router, frame.providerID, frame.apiKey, frame.model, {
    baseUrl: frame.baseUrl,
    label: frame.label,
  });
  if (!result.ok) {
    sendError(deps, session, result.code, result.message);
    return;
  }
  deps.reply({ type: "provider.add.ok", providers: result.providers });
}

async function handleProviderModelSet(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "provider.model.set" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  const result = await setProviderModel(deps.router, frame.providerID, frame.model);
  if (!result.ok) {
    sendError(deps, session, result.code, result.message);
    return;
  }
  deps.reply({ type: "provider.add.ok", providers: result.providers });
}

async function handleProviderModelsList(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "provider.models.list" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  try {
    const models = await deps.router.listModels(frame.providerID);
    deps.reply({ type: "provider.models.ok", providerID: frame.providerID, models });
  } catch (error) {
    sendError(deps, session, "provider_models", error instanceof Error ? error.message : "Could not load provider models.");
  }
}

// --- plugins -----------------------------------------------------------------

function handlePluginList(deps: DispatchDeps, session: Session): void {
  if (!requireAuth(deps, session)) return;
  if (!deps.plugins) return sendError(deps, session, "internal", "plugin service unavailable");
  deps.reply({ type: "plugin.list.ok", plugins: deps.plugins.list() });
}

async function handlePluginConnect(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "plugin.connect" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  if (!deps.plugins) return sendError(deps, session, "internal", "plugin service unavailable");
  const result = deps.plugins.connect(frame.pluginID, frame.account);
  if (result.error) {
    sendError(deps, session, result.error.code, result.error.message);
    return;
  }
  deps.reply({
    type: "plugin.connect.ok",
    pluginID: frame.pluginID,
    account: frame.account,
    authorizeURL: result.authorizeURL ?? null,
  });
}

async function handlePluginConfigure(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "plugin.configure" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  if (!deps.plugins) return sendError(deps, session, "internal", "plugin service unavailable");
  const result = deps.plugins.configure(frame.pluginID, frame.account, {
    user: frame.user,
    pass: frame.pass,
    key: frame.key,
    url: frame.url,
    clientID: frame.clientID,
    clientSecret: frame.clientSecret,
  });
  if (result.error) {
    sendError(deps, session, result.error.code, result.error.message);
    return;
  }
  deps.reply({
    type: "plugin.connect.ok",
    pluginID: frame.pluginID,
    account: frame.account,
    authorizeURL: result.authorizeURL ?? null,
  });
}

async function handlePluginDisconnect(
  deps: DispatchDeps,
  session: Session,
  frame: Extract<ClientFrame, { type: "plugin.disconnect" }>,
): Promise<void> {
  if (!requireAuth(deps, session)) return;
  if (!deps.plugins) return sendError(deps, session, "internal", "plugin service unavailable");
  const result = await deps.plugins.disconnect(frame.connectionID);
  if (result.error) {
    sendError(deps, session, result.error.code, result.error.message);
    return;
  }
  deps.reply({ type: "plugin.list.ok", plugins: deps.plugins.list() });
}

function jobSnapshot(db: Database, limit: number): JobInfo[] {
  const seen = new Set<string>();
  const jobs: JobInfo[] = [];
  for (const row of [...listJobs(db, { limit }), ...listFinishedJobs(db, 10)]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    jobs.push(jobInfo(row));
  }
  return jobs;
}

function jobInfo(row: JobRow): JobInfo {
  const payload = turnPayload(row);
  return {
    id: row.id,
    kind: row.kind,
    // Rows only ever hold the four schema states; the cast is the narrowing.
    state: row.state as JobState,
    runAt: row.run_at,
    enabled: row.enabled === 1,
    attempts: row.attempts,
    ...(payload.everyMs ? { everyMs: payload.everyMs } : {}),
    ...(payload.text ? { title: clip(payload.text, 120) } : {}),
    ...(payload.threadID ? { threadID: payload.threadID } : {}),
    ...(row.result ? { lastResult: row.result } : {}),
  };
}

/** A non-turn job (or a damaged payload) simply has nothing to say. */
function turnPayload(row: JobRow): Partial<TurnJobPayload> {
  if (row.kind !== "turn") return {};
  try {
    return parseJobPayload<Partial<TurnJobPayload>>(row);
  } catch {
    return {};
  }
}

function clip(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

// ---------------------------------------------------------------------------

function requireAuth(deps: DispatchDeps, session: Session): boolean {
  if (session.authed) return true;
  sendError(deps, session, "unauthorized", "send hello with a device token first");
  return false;
}

function sendError(deps: DispatchDeps, _session: Session, code: string, message: string): void {
  deps.emit({ type: "error", code, message });
  log.debug(`error frame → ${code}: ${message}`);
}


function handleAgentRename(deps: DispatchDeps, session: Session, frame: Extract<ClientFrame, { type: "agent.rename" }>): void {
  if (!requireAuth(deps, session)) return;
  const ok = completeAgentRename(deps, frame.agentId, frame.name);
  if (!ok) sendError(deps, session, "bad_frame", "agent name must be 1–64 characters");
}

function completeAgentRename(deps: DispatchDeps, agentID: string, proposedName: string): boolean {
  const result = renameAgent(deps.db, agentID, proposedName);
  if (!result.ok) return false;
  deps.emit({ type: "agent.updated", agentId: result.agentID, displayName: result.name, onboarded: true });
  if (result.agentID === "ea") {
    emitOnboardingMessage(
      deps,
      "main",
      "ea",
      `${result.name}. Nice to meet you. I can research, analyze, and summarize information; coordinate specialist agents; and keep you updated while I work.`,
      "normal",
    );
  }
  return true;
}

function emitOnboardingMessage(
  deps: DispatchDeps,
  channelID: string,
  agentID: string,
  text: string,
  uiHint: "onboarding_name_prompt" | "handoff_notice" | "progress" | "normal",
): void {
  const row = appendChannelMessage(deps.db, {
    channelID,
    fromType: "agent",
    fromID: agentID,
    text,
    uiHint,
  });
  const agent = deps.db.query<{ display_name: string | null; avatar_color: string | null }, [string]>(
    "SELECT display_name, avatar_color FROM agents WHERE id = ?",
  ).get(agentID);
  deps.emit({
    type: "msg.new",
    id: row.id,
    channelId: channelID,
    fromType: "agent",
    fromId: agentID,
    senderName: agent?.display_name ?? agentID,
    senderColor: agent?.avatar_color ?? undefined,
    text,
    internal: false,
    uiHint,
    createdAt: row.created_at,
  });
}

function emitOnboardingIfNeeded(deps: DispatchDeps): void {
  const primary = deps.db.query<{ onboarded: number; display_name: string | null }, []>(
    "SELECT onboarded, display_name FROM agents WHERE id = 'ea'",
  ).get();
  if (!primary || primary.onboarded !== 0) return;
  const sent = deps.db.query<{ count: number }, []>(
    "SELECT count(*) AS count FROM channel_messages WHERE channel_id = 'main' AND from_id = 'ea'",
  ).get()?.count ?? 0;
  if (sent > 0) return;
  const firstName = deps.config.userFirstName?.trim() || "there";
  emitOnboardingMessage(
    deps,
    "main",
    "ea",
    `Hi ${firstName}, I'm ${primary.display_name ?? "Agni Bot"}, your personal assistant. I can help with work and everyday life, and take things off your plate.`,
    "normal",
  );
  emitOnboardingMessage(
    deps,
    "main",
    "ea",
    "What would you like to call me? You can always change this later.",
    "onboarding_name_prompt",
  );
}
