/**
 * Read-only bot debugger API for the web app's debug screen. Everything here
 * is already in the database; this only joins it up so a turn can be read
 * as a flow: what the bot was asked, each tool it called, what came back,
 * how much of its budget it spent, and why it stopped.
 *
 * Owner-only: every route needs a paired device token, like /attachments.
 */
import type { Database } from "bun:sqlite";
import { verifyToken } from "../auth/tokens";
import type { Config } from "../config";
import type { Router } from "../models/router";
import { dayTotals } from "../stores/usage";
import { MAX_STEPS, MAX_TOKENS } from "../agent/task-loop";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "cache-control": "no-store",
};

/** Big tool results and context messages are cut so one turn cannot stall the page. */
const MAX_TEXT = 20_000;

const clip = (text: string | null | undefined, max = MAX_TEXT): string | null =>
  text == null ? null : text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;

function parseJSON(text: string | null): unknown {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function debugRequest(request: Request, db: Database, router: Router, config: Config): Promise<Response> {
  const reply = (data: unknown, status = 200) => Response.json(data, { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return reply({ error: "Read-only." }, 405);
  const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !(await verifyToken(db, token))) return reply({ error: "Pair this device first." }, 401);

  const url = new URL(request.url);
  if (url.pathname === "/debug/overview") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 150));
    return reply(debugOverview(db, router, config, limit));
  }
  const turnID = /^\/debug\/turns\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
  if (turnID) {
    const detail = debugTurn(db, turnID);
    return detail ? reply(detail) : reply({ error: "Turn not found." }, 404);
  }
  return reply({ error: "Not found." }, 404);
}

export function debugOverview(db: Database, router: Router, config: Config, limit = 150) {
  return {
    serverTime: new Date().toISOString(),
    limits: {
      maxSteps: MAX_STEPS,
      maxTokens: MAX_TOKENS,
      turnTimeoutMs: config.turnTimeoutMs,
      firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    },
    providers: router.status(),
    capacity: router.load(),
    usageToday: dayTotals(db),
    agents: db.query("SELECT id, COALESCE(display_name, name) AS name, role, tools FROM agents ORDER BY created_at").all(),
    sessions: db.query(`
      SELECT s.thread_id, th.agent_id, s.turn_id, s.state, s.step_count, s.token_count, s.max_steps, s.max_tokens,
             json_array_length(s.message_log) AS message_count, length(s.message_log) AS log_chars,
             length(COALESCE(s.summary, '')) AS summary_chars, s.updated_at
      FROM agent_sessions s LEFT JOIN threads th ON th.id = s.thread_id
      ORDER BY s.updated_at DESC LIMIT 40
    `).all(),
    jobs: (db.query(`
      SELECT id, kind, state, run_at, attempts, enabled, substr(result, 1, 400) AS result, payload, updated_at
      FROM jobs ORDER BY updated_at DESC LIMIT 40
    `).all() as Array<Record<string, unknown> & { payload: string | null }>).map(({ payload, ...job }) => {
      const parsed = parseJSON(payload) as Record<string, unknown> | null;
      return {
        ...job,
        agentID: typeof parsed?.agentID === "string" ? parsed.agentID : null,
        title: typeof parsed?.title === "string" ? parsed.title : typeof parsed?.text === "string" ? clip(parsed.text, 120) : null,
      };
    }),
    turns: db.query(`
      SELECT t.id, t.thread_id, t.agent_id, t.state, t.stop_reason, t.provider, t.model,
             t.input_tokens, t.output_tokens, t.latency_ms, t.started_at, t.ended_at,
             (SELECT count(*) FROM tool_calls c WHERE c.turn_id = t.id) AS tool_count,
             (SELECT count(*) FROM tool_calls c WHERE c.turn_id = t.id AND c.ok = 0) AS failed_count,
             (SELECT group_concat(tool_name, ',') FROM (SELECT tool_name FROM tool_calls c WHERE c.turn_id = t.id ORDER BY created_at)) AS tool_names,
             (SELECT s.step_count FROM agent_sessions s WHERE s.turn_id = t.id) AS step_count,
             (SELECT s.token_count FROM agent_sessions s WHERE s.turn_id = t.id) AS token_count
      FROM turns t ORDER BY t.started_at DESC LIMIT ?
    `).all(limit),
  };
}

interface StoredMessage {
  role: string;
  content?: unknown;
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  toolCallID?: string;
  reasoning?: unknown;
}

export function debugTurn(db: Database, turnID: string) {
  const turn = db.query(`
    SELECT t.*, COALESCE(a.display_name, a.name) AS agent_name, th.title AS thread_title, th.conversation_id
    FROM turns t LEFT JOIN agents a ON a.id = t.agent_id LEFT JOIN threads th ON th.id = t.thread_id
    WHERE t.id = ?
  `).get(turnID);
  if (!turn) return null;

  const tools = (db.query(`
    SELECT call_id, tool_name, args, result, ok, error, duration_ms, created_at
    FROM tool_calls WHERE turn_id = ? ORDER BY created_at, rowid
  `).all(turnID) as Array<{ args: string; result: string | null; ok: number } & Record<string, unknown>>).map((call) => ({
    ...call,
    ok: call.ok === 1,
    args: parseJSON(call.args),
    result: clip(call.result),
  }));

  const messages = db.query(`
    SELECT 'thread' AS source, role, NULL AS from_id, 0 AS internal, text, created_at FROM messages WHERE turn_id = ?
    UNION ALL
    SELECT 'channel', from_type, from_id, internal, text, created_at FROM channel_messages WHERE turn_id = ?
    ORDER BY created_at
  `).all(turnID, turnID);

  // The session row keeps only the newest turn of each thread, so the exact
  // context the model saw survives only for that turn.
  const session = db.query(`
    SELECT state, step_count, token_count, max_steps, max_tokens, summary, message_log, updated_at
    FROM agent_sessions WHERE turn_id = ?
  `).get(turnID) as { message_log: string; summary: string | null } & Record<string, unknown> | null;

  let context: unknown[] | null = null;
  if (session) {
    const log = parseJSON(session.message_log);
    context = Array.isArray(log)
      ? (log as StoredMessage[]).map((message) => ({
          role: message.role,
          content: clip(typeof message.content === "string" ? message.content : message.content == null ? "" : JSON.stringify(message.content), 8_000),
          toolCalls: message.toolCalls?.map((call) => ({ id: call.id, name: call.function.name, arguments: clip(call.function.arguments, 4_000) })),
          toolCallID: message.toolCallID,
          reasoning: message.reasoning == null ? undefined : clip(typeof message.reasoning === "string" ? message.reasoning : JSON.stringify(message.reasoning), 4_000),
        }))
      : null;
  }
  const { message_log: _log, ...sessionInfo } = session ?? { message_log: "" };

  return { turn, tools, messages, session: session ? { ...sessionInfo, summary: clip(session.summary) } : null, context };
}
