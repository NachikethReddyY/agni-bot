/**
 * Thread export: read the durable records for one conversation and publish
 * them as a single shareable HTML file.
 *
 * The sources are exactly the ones the app already trusts: channel messages
 * (what was said), `tool_calls` (what was run), `agent_sessions.message_log`
 * (the model's own reasoning, when the provider exposes it), and `approvals`
 * (what was asked of the owner and what they answered). Nothing is inferred,
 * so the document can be used to find out why a turn behaved the way it did.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homePath } from "../home";
import { dirname, join, resolve } from "node:path";
import { canonicalAgentID } from "../agent/personas";
import { getConversation } from "../stores/conversations";
import { getThread } from "../stores/threads";
import { renderShareHTML, type ShareDocument, type ShareRecord } from "./render";

/**
 * Where published exports live. Defaults to `share/` beside the database, so a
 * bb-1 deployment keeps exports next to its data; `AGNI_SHARE_DIR` overrides.
 */
export function shareDir(): string {
  const configured = process.env.AGNI_SHARE_DIR?.trim();
  if (configured) return resolve(configured);
  const dbPath = process.env.AGNI_DB_PATH?.trim() || homePath("data", "agni.sqlite");
  return resolve(dirname(dbPath), "share");
}

/** Tokens are opaque file names: lowercase hex, fixed length, never a path. */
export const SHARE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function newShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Where the file for a token lives; null when the token is not a token. */
export function sharePath(token: string): string | null {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null;
  return join(shareDir(), `${token}.html`);
}

/** Read a published export. Returns null for anything that is not a token. */
export function readShareFile(token: string): string | null {
  const path = sharePath(token);
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Render and write the document; returns the token and the URL to hand out. */
export function publishShare(
  doc: ShareDocument,
  options: { baseURL: string },
): { token: string; path: string; url: string } {
  const token = newShareToken();
  const dir = shareDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${token}.html`);
  writeFileSync(path, renderShareHTML(doc), { flag: "w" });
  return { token, path, url: `${options.baseURL.replace(/\/+$/, "")}/share/${token}` };
}

/**
 * The address this daemon is reachable at, for links it hands out. It mirrors
 * the config defaults (loopback unless the deployment binds elsewhere, which
 * is what makes a bb-1 link openable from a phone). A test that binds port 0
 * gets the default port here and should not assert on the URL.
 */
export function shareBaseURL(env: Record<string, string | undefined> = Bun.env): string {
  const host = env.AGNI_HOST?.trim() || "127.0.0.1";
  const parsed = Number.parseInt(env.AGNI_PORT ?? "", 10);
  return `http://${host}:${Number.isFinite(parsed) && parsed > 0 ? parsed : 8787}`;
}

/** Export a thread's conversation. Used by the `share_thread` tool. */
export function shareThread(
  db: Database,
  options: { threadID: string; title?: string },
): { token: string; url: string; records: number } {
  const thread = getThread(db, options.threadID);
  if (!thread?.conversation_id) throw new Error("this block is not part of a conversation, so there is nothing to export");
  const doc = buildShareDocument(db, {
    conversationID: thread.conversation_id,
    ...(options.title ? { title: options.title } : {}),
  });
  const published = publishShare(doc, { baseURL: shareBaseURL() });
  return { token: published.token, url: published.url, records: doc.records.length };
}

interface AgentLabel {
  name: string;
  color?: string;
}

/**
 * Assemble the document for a conversation. Throws when the conversation does
 * not exist — an export of nothing is not a useful artifact.
 */
export function buildShareDocument(
  db: Database,
  options: { conversationID: string; title?: string; createdAt?: string },
): ShareDocument {
  const conversation = getConversation(db, options.conversationID);
  if (!conversation) throw new Error(`unknown conversation ${options.conversationID}`);
  const canonical = canonicalAgentID(conversation.agent_id);
  // Same rule as `conversation.history`: the assistant's channel is "main",
  // every other agent has a DM channel. Kept identical on purpose — an export
  // that disagrees with the app about what a conversation contains is a bug.
  const channelID = canonical === "ea" ? "main" : `dm:${conversation.agent_id}`;
  const names = agentLabels(db);
  const records: ShareRecord[] = [];
  const messageTimes = new Map<string, string>();

  const messages = db
    .query<{
      id: string; text: string; created_at: string; from_id: string; from_type: string;
    }, [string]>(
      `SELECT id, text, created_at, from_id, from_type FROM channel_messages
       WHERE channel_id = ? AND internal = 0 ORDER BY created_at, rowid`,
    )
    .all(channelID);
  for (const row of messages) {
    if (row.from_type === "system") {
      // Handoff notices are conversation flow ("Bahu → Researcher: …"), not
      // diagnostics, so they stay in the transcript.
      records.push({ id: row.id, kind: "notice", at: row.created_at, text: row.text });
      continue;
    }
    const isAgent = row.from_type !== "user";
    records.push({
      id: row.id,
      kind: isAgent ? "agent" : "user",
      at: row.created_at,
      agentID: isAgent ? row.from_id : undefined,
      agentName: isAgent ? labelOf(names, row.from_id).name : undefined,
      agentColor: isAgent ? labelOf(names, row.from_id).color : undefined,
      text: row.text,
    });
    if (isAgent) messageTimes.set(anchor(row.text), row.created_at);
  }

  // Durable tool records for every block in this conversation — delegated
  // child blocks included, so a handoff's own work is auditable too.
  const toolCalls = db
    .query<{
      id: string; tool_name: string; args: string; result: string | null; ok: number;
      error: string | null; duration_ms: number | null; created_at: string; agent_id: string;
    }, [string]>(
      `SELECT tc.id, tc.tool_name, tc.args, tc.result, tc.ok, tc.error, tc.duration_ms, tc.created_at, t.agent_id
       FROM tool_calls tc
       JOIN threads th ON th.id = tc.thread_id
       JOIN turns t ON t.id = tc.turn_id
       WHERE th.conversation_id = ? ORDER BY tc.created_at, tc.rowid`,
    )
    .all(conversation.id);
  for (const row of toolCalls) {
    const label = labelOf(names, row.agent_id);
    records.push({
      id: row.id,
      kind: "tool",
      at: row.created_at,
      agentID: row.agent_id,
      agentName: label.name,
      agentColor: label.color,
      toolName: row.tool_name,
      args: row.args,
      result: row.ok ? row.result ?? "" : row.error ?? row.result ?? "",
      ok: row.ok === 1,
      durationMs: row.duration_ms ?? undefined,
    });
  }

  const approvals = db
    .query<{ id: string; action: string; decision: string | null; status: string; created_at: string; decided_at: string | null }, [string]>(
      `SELECT a.id, a.action, a.decision, a.status, a.created_at, a.decided_at FROM approvals a
       JOIN threads th ON th.id = a.thread_id
       WHERE th.conversation_id = ? ORDER BY a.created_at`,
    )
    .all(conversation.id);
  for (const row of approvals) {
    records.push({
      id: row.id,
      kind: "approval",
      at: row.decided_at ?? row.created_at,
      text: row.action,
      decision: row.status === "pending" ? undefined : row.decision ?? "reject",
    });
  }

  // A turn that ended badly is worth labelling in place: it explains a gap in
  // the conversation, which is the question an export is usually opened with.
  const unfinished = db
    .query<{ id: string; text: string; created_at: string }, [string]>(
      `SELECT m.id, m.text, m.created_at FROM messages m
       JOIN threads th ON th.id = m.thread_id
       JOIN turns t ON t.id = m.turn_id
       WHERE th.conversation_id = ? AND t.stop_reason IN ('error', 'timeout')
         AND m.role = 'assistant' AND m.text <> '' ORDER BY m.created_at`,
    )
    .all(conversation.id);
  for (const row of unfinished) {
    const existing = records.find((record) => record.kind === "agent" && anchor(record.text ?? "") === anchor(row.text));
    if (existing) existing.code = "unfinished turn";
    else records.push({ id: row.id, kind: "error", at: row.created_at, code: "unfinished turn", text: row.text });
  }

  records.push(...thinkingRecords(db, conversation.id, names, messageTimes));

  const primary = labelOf(names, canonical);
  return {
    title: options.title?.trim() || `${primary.name} — conversation`,
    agentName: primary.name,
    agentID: canonical,
    conversationID: conversation.id,
    createdAt: options.createdAt ?? new Date().toISOString(),
    records: records.filter((record) => (record.text ?? "").trim().length > 0 || record.kind === "tool"),
  };
}

/**
 * Model reasoning, pulled from session logs. Ordering is derived, because a
 * session log has no per-entry timestamps: each thought is anchored one second
 * before the reply it produced, falling back to the session's last write when
 * that reply cannot be matched. Discussion of placement belongs here rather
 * than in the renderer, which only sorts by time.
 */
function thinkingRecords(
  db: Database,
  conversationID: string,
  labels: Map<string, AgentLabel>,
  messageTimes: Map<string, string>,
): ShareRecord[] {
  const sessions = db
    .query<{ thread_id: string; message_log: string; updated_at: string; agent_id: string }, [string]>(
      `SELECT s.thread_id, s.message_log, s.updated_at, th.agent_id FROM agent_sessions s
       JOIN threads th ON th.id = s.thread_id WHERE th.conversation_id = ? ORDER BY s.updated_at`,
    )
    .all(conversationID);
  const records: ShareRecord[] = [];
  for (const session of sessions) {
    const log = parseSessionLog(session.message_log);
    let pending: string | null = null;
    let index = 0;
    for (const entry of log) {
      if (entry.role !== "assistant") continue;
      const reasoning = (entry.reasoning ?? "").trim();
      if (reasoning) {
        // Reasoning precedes the message it belongs to; keep it until that
        // message appears so the two stay adjacent.
        pending = pending ? `${pending}\n\n${reasoning}` : reasoning;
        continue;
      }
      if (!pending) continue;
      const answeredAt = messageTimes.get(anchor(entry.content ?? ""));
      records.push({
        id: `${session.thread_id}-thought-${index++}`,
        kind: "thinking",
        at: answeredAt ? before(answeredAt) : session.updated_at,
        agentID: session.agent_id,
        agentName: labelOf(labels, session.agent_id).name,
        text: pending,
      });
      pending = null;
    }
    if (pending) {
      records.push({
        id: `${session.thread_id}-thought-${index++}`,
        kind: "thinking",
        at: session.updated_at,
        agentID: session.agent_id,
        agentName: labelOf(labels, session.agent_id).name,
        text: pending,
      });
    }
  }
  return records;
}

function parseSessionLog(raw: string): Array<{ role?: string; content?: string; reasoning?: string }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Array<{ role?: string; content?: string; reasoning?: string }>) : [];
  } catch {
    return [];
  }
}

function agentLabels(db: Database): Map<string, AgentLabel> {
  const rows = db
    .query<{ id: string; display_name: string | null; avatar_color: string | null }, []>(
      "SELECT id, display_name, avatar_color FROM agents",
    )
    .all();
  return new Map(rows.map((row) => [row.id, { name: row.display_name?.trim() || row.id, color: row.avatar_color ?? undefined }]));
}

function labelOf(labels: Map<string, AgentLabel>, id: string): AgentLabel {
  return labels.get(id) ?? { name: id };
}

/** Normalized prefix used to match a session entry to the message it produced. */
function anchor(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** One second earlier — enough to sort a thought before its answer. */
function before(iso: string): string {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? iso : new Date(parsed - 1_000).toISOString();
}
