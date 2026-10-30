#!/usr/bin/env bun
/**
 * Protocol fixtures — one example of every frame, written to
 * `packages/protocol/fixtures/frames.json`.
 *
 * The Swift app mirrors these shapes by hand (no codegen between TS and Swift),
 * so this file is the shared contract test: `swift test` in apps/mac decodes
 * every fixture here, and fails if the two languages drift. Regenerate with
 * `bun run fixtures` after any frame change.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  PROTOCOL_VERSION,
  ClientFrameSchema,
  ServerFrameSchema,
  parseClientFrame,
  parseServerFrame,
  type ClientFrame,
  type PluginInfo,
  type ServerFrame,
} from "../src/index.ts";

const CLIENT_FRAMES: ClientFrame[] = [
  { type: "hello", v: PROTOCOL_VERSION, token: "agni_ZmFrZS10b2tlbg", device: "Nachiketh's Mac" },
  { type: "resync", lastSeq: 41 },
  { type: "msg.send", threadID: "thr_01hq", text: "remind me at 5 to call the plumber" },
  { type: "msg.send", threadID: "", text: "new thread, no id yet" },
  { type: "msg.send", threadID: "thr_01hq", text: "what changed in that thread?", conversationID: "cnv_01hq" },
  { type: "msg.send", conversationID: "cnv_01hq", text: "no thread id — conversation clients don't track blocks" },
  { type: "msg.cancel", turnID: "trn_01hq" },
  { type: "approve.reply", requestID: "apr_01hq", decision: "once" },
  { type: "agent.select", agentID: "agni" },
  { type: "conversation.open", conversationID: "", agentID: "agni" },
  { type: "session.new", conversationID: "cnv_01hq" },
  { type: "conversation.history", conversationID: "cnv_01hq", limit: 200 },
  { type: "thread.open", threadID: "thr_01hq" },
  { type: "thread.export", conversationID: "cnv_01hq", title: "Share with Priya" },
  { type: "thread.list", limit: 20 },
  { type: "thread.history", threadID: "thr_01hq", limit: 50 },
  { type: "job.list", limit: 50 },
  { type: "job.set", jobID: "job_01hq", action: "pause" },
  { type: "task.list", status: "open", limit: 50 },
  { type: "task.update", taskID: "tsk_01hq", action: "snooze", until: "2026-10-17T01:00:00.000Z" },
  { type: "job.delete", jobID: "job_01hr" },
  { type: "provider.add", providerID: "groq", apiKey: "fixture-key", model: "llama-3.1-8b-instant" },
  { type: "provider.model.set", providerID: "groq", model: "llama-3.1-8b-instant" },
  { type: "provider.models.list", providerID: "groq" },
  { type: "plugin.list" },
  { type: "plugin.connect", pluginID: "gmail", account: "agent" },
  { type: "plugin.disconnect", connectionID: "plc_01hq" },
  { type: "user.typing", channelId: "ch_01hq", isTyping: true },
  { type: "agent.rename", agentId: "agni", name: "Agni Prime" },
  { type: "channel.create", name: "Launch", agentIds: ["ea", "researcher"] },
  { type: "channel.list" },
  { type: "channel.history", channelId: "chn_01hq", limit: 50 },
];

/** A representative plugins snapshot: one connected agent row, one disconnected owner row. */
const PLUGIN_SNAPSHOT: PluginInfo[] = [
  {
    id: "gmail",
    name: "Gmail",
    category: "google",
    description: "Search, read, draft, send and label mail for this account.",
    authKind: "oauth",
    account: "agent",
    scopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/userinfo.email"],
    capabilities: [
      { capability: "read", mode: "free" },
      { capability: "draft", mode: "free" },
      { capability: "send", mode: "free" },
      { capability: "modify", mode: "free" },
    ],
    available: true,
    connectionID: "plc_01hq",
    status: "connected",
    accountLabel: "hey.agnibot@gmail.com",
    connectedAt: "2026-10-17T09:00:00.000Z",
  },
  {
    id: "calendar",
    name: "Calendar",
    category: "google",
    description: "Search events, create events and invite people for this account.",
    authKind: "oauth",
    account: "owner",
    scopes: ["https://www.googleapis.com/auth/calendar"],
    capabilities: [
      { capability: "read", mode: "free" },
      { capability: "create", mode: "approval" },
      { capability: "modify", mode: "approval" },
      { capability: "share", mode: "approval" },
    ],
    available: true,
  },
];

const SERVER_FRAMES: ServerFrame[] = [
  { type: "hello.ok", seq: 42, v: PROTOCOL_VERSION, serverTime: "2026-10-16T12:00:00.000Z", lastSeq: 42 },
  { type: "token", seq: 43, turnID: "trn_01hq", threadID: "thr_01hq", delta: "Call " },
  { type: "turn.start", seq: 44, turnID: "trn_01hq", threadID: "thr_01hq", agentID: "agni", conversationID: "cnv_01hq" },
  {
    type: "turn.end",
    seq: 45,
    turnID: "trn_01hq",
    threadID: "thr_01hq",
    stopReason: "end",
    usage: { provider: "groq", model: "llama-3.1-8b-instant", inputTokens: 128, outputTokens: 24, latencyMs: 412 },
    conversationID: "cnv_01hq",
  },
  { type: "turn.end", seq: 46, turnID: "trn_01hr", threadID: "thr_01hq", stopReason: "cancelled" },
  { type: "tool.start", seq: 47, callID: "call_01hq", name: "memory.search", preview: "passport expiry" },
  { type: "tool.update", seq: 48, callID: "call_01hq", preview: "3 matches" },
  { type: "tool.end", seq: 49, callID: "call_01hq", ok: true, preview: "3 matches" },
  {
    type: "approval.request",
    seq: 50,
    requestID: "apr_01hq",
    action: "shell: git push origin main",
    preview: "git push origin main\n→ To github.com:theynr/agni.git",
    buttons: ["once", "always", "reject"],
  },
  {
    type: "form.request",
    seq: 51,
    requestID: "frm_01hq",
    question: "Which inbox should the brief watch while you're away?",
    options: ["agent", "personal", "both"],
  },
  { type: "notify", seq: 52, title: "Agni · standup in 10", body: "You asked to be nudged before the 09:30 standup.", sound: true, threadID: "thr_01hq" },
  {
    type: "agents.update",
    seq: 53,
    agents: [
      { id: "agni", name: "Agni", color: "#f0b95a", tools: [] },
      { id: "scout", name: "Scout", color: "#7cc4ff", model: "gemini-2.0-flash", tools: ["links.search"] },
    ],
  },
  {
    type: "thread.list.ok",
    seq: 54,
    threads: [
      { id: "thr_01hq", agentID: "agni", title: "remind me at 5 to call the plumber", updatedAt: "2026-10-16T12:00:00.000Z", preview: "Set for 17:00." },
      { id: "thr_01hp", agentID: "agni", updatedAt: "2026-10-15T09:12:00.000Z" },
    ],
  },
  {
    type: "thread.history.ok",
    seq: 55,
    threadID: "thr_01hq",
    title: "remind me at 5 to call the plumber",
    messages: [
      { id: "msg_01hq", role: "user", text: "remind me at 5 to call the plumber", createdAt: "2026-10-16T11:59:58.000Z" },
      {
        id: "msg_01hr",
        role: "assistant",
        text: "Set for 17:00.",
        createdAt: "2026-10-16T12:00:00.000Z",
        turnID: "trn_01hq",
      },
    ],
  },
  {
    type: "job.list.ok",
    seq: 56,
    jobs: [
      {
        id: "job_01hq",
        kind: "turn",
        state: "queued",
        runAt: "2026-10-17T07:55:00.000Z",
        enabled: true,
        attempts: 4,
        everyMs: 86_400_000,
        title: "precompute the morning brief",
        threadID: "thr_01hr",
        lastResult: "thread thr_01hr: Inbox is quiet; two links worth a look. (recurring)",
      },
      {
        id: "job_01hr",
        kind: "turn",
        state: "queued",
        runAt: "2026-10-16T17:00:00.000Z",
        enabled: false,
        attempts: 0,
        title: "remind me to call the plumber",
      },
    ],
  },
  { type: "task.list.ok", seq: 59, tasks: [{ id: "tsk_01hq", title: "Renew insurance", dueAt: "2026-10-17T01:00:00.000Z", priority: "high", status: "open", snoozedUntil: null, createdAt: "2026-10-16T12:00:00.000Z", updatedAt: "2026-10-16T12:00:00.000Z" }] },
  { type: "task.update.ok", seq: 60, task: { id: "tsk_01hq", title: "Renew insurance", dueAt: "2026-10-17T01:00:00.000Z", priority: "high", status: "snoozed", snoozedUntil: "2026-10-17T01:00:00.000Z", createdAt: "2026-10-16T12:00:00.000Z", updatedAt: "2026-10-16T12:01:00.000Z" } },
  { type: "provider.add.ok", seq: 61, providers: [{ id: "groq", label: "Groq", model: "llama-3.1-8b-instant", available: true, cooldownRemainingMs: 0 }] },
  { type: "provider.models.ok", seq: 62, providerID: "groq", models: ["llama-3.1-8b-instant"] },
  {
    type: "plugin.connect.ok",
    seq: 66,
    pluginID: "gmail",
    account: "agent",
    authorizeURL: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=st_01hq",
  },
  { type: "plugin.list.ok", seq: 67, plugins: PLUGIN_SNAPSHOT },
  { type: "plugin.state", seq: 68, plugins: PLUGIN_SNAPSHOT },
  { type: "conversation.ok", seq: 63, conversationID: "cnv_01hq", agentID: "agni", sessionID: "thr_01hq" },
  { type: "session.start", seq: 64, conversationID: "cnv_01hq", sessionID: "thr_01hs", reason: "manual" },
  {
    type: "conversation.history.ok",
    seq: 65,
    conversationID: "cnv_01hq",
    messages: [
      { id: "msg_01hq", role: "user", text: "remind me at 5 to call the plumber", createdAt: "2026-10-16T11:59:58.000Z", sessionID: "thr_01hq" },
      { id: "msg_01hs", role: "assistant", text: "Done — starting a fresh session block.", createdAt: "2026-10-17T10:41:00.000Z", sessionID: "thr_01hs" },
    ],
  },
  { type: "presence", seq: 57, state: "offline" },
  {
    type: "thread.export.ok",
    seq: 72,
    conversationID: "cnv_01hq",
    url: "http://127.0.0.1:8787/share/0f3a1c9d2e4b4c8a9f1e2d3c4b5a6978",
    token: "0f3e8b1d4c2a9f6e0d3b7a1c5e9f2b4d",
    records: 42,
    createdAt: "2026-10-19T09:12:00.000Z",
  },
  { type: "error", seq: 58, code: "no_provider", message: "no provider in tier instant", retryAfter: 2 },
  { type: "status.update", seq: 69, channelId: "ch_01hq", agentId: "agni", text: "Nachiketh is typing…", transient: true },
  {
    type: "msg.new",
    seq: 70,
    id: "msg_01ht",
    channelId: "ch_01hq",
    fromType: "user",
    fromId: "usr_1",
    senderName: "Nachiketh",
    senderColor: "#f0b95a",
    text: "hello channel",
    internal: false,
    createdAt: "2026-10-17T10:00:00.000Z",
  },
  { type: "agent.updated", seq: 71, agentId: "agni", displayName: "Agni Prime", onboarded: true },
  { type: "channel.created", seq: 72, channel: { id: "chn_01hq", name: "Launch", type: "group", agentIds: ["ea", "researcher"], createdAt: "2026-10-31T09:00:00.000Z" } },
  { type: "channel.list.ok", seq: 73, channels: [{ id: "chn_01hq", name: "Launch", type: "group", agentIds: ["ea", "researcher"], createdAt: "2026-10-31T09:00:00.000Z" }] },
  { type: "channel.history.ok", seq: 74, channelId: "chn_01hq", messages: [{ id: "chm_01hq", role: "user", text: "plan the launch", createdAt: "2026-10-31T09:01:00.000Z" }] },
];

/** Every frame must survive its own schema before it is a fixture. */
const problems: string[] = [];
for (const frame of CLIENT_FRAMES) {
  const parsed = parseClientFrame(frame);
  if (!parsed.ok) problems.push(`client ${frame.type}: ${parsed.error}`);
}
for (const frame of SERVER_FRAMES) {
  const parsed = parseServerFrame(frame);
  if (!parsed.ok) problems.push(`server ${frame.type}: ${parsed.error}`);
}

// A fixture set that misses a frame type is a fixture set that stops catching
// drift — every variant of the union has to be represented, plus its schema.
const clientTypes = new Set(CLIENT_FRAMES.map((frame) => frame.type));
const serverTypes = new Set(SERVER_FRAMES.map((frame) => frame.type));
for (const option of ClientFrameSchema.options) {
  const literal = option.shape.type.value as ClientFrame["type"];
  if (!clientTypes.has(literal)) problems.push(`no client fixture for "${literal}"`);
}
for (const option of ServerFrameSchema.options) {
  const literal = option.shape.type.value as ServerFrame["type"];
  if (!serverTypes.has(literal)) problems.push(`no server fixture for "${literal}"`);
}

if (problems.length > 0) {
  console.error("fixture set is incomplete or malformed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const out = join(import.meta.dir, "..", "fixtures", "frames.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), protocolVersion: PROTOCOL_VERSION, client: CLIENT_FRAMES, server: SERVER_FRAMES }, null, 2)}\n`,
);
console.log(`wrote ${CLIENT_FRAMES.length} client + ${SERVER_FRAMES.length} server fixtures → ${out}`);
