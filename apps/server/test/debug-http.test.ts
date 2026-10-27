import { expect, test } from "bun:test";
import { mintToken } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { debugRequest } from "../src/debug/http";
import type { Router } from "../src/models/router";

const router = { status: () => [], load: () => ({ active: 0, capacity: 4 }) } as unknown as Router;
const config = { turnTimeoutMs: 120_000, firstTokenTimeoutMs: 30_000 } as Config;

test("debug routes need a device token and join a turn into one flow", async () => {
  const db = openDatabase(":memory:");
  try {
    const now = "2026-10-27T00:00:00.000Z";
    db.run("INSERT INTO threads (id, agent_id, created_at, updated_at) VALUES ('thr_1', 'ea', ?, ?)", [now, now]);
    db.run("INSERT INTO turns (id, thread_id, agent_id, state, stop_reason, started_at, ended_at) VALUES ('trn_1', 'thr_1', 'ea', 'done', 'end', ?, ?)", [now, now]);
    db.run("INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, duration_ms, created_at) VALUES ('tcl_1', 'thr_1', 'trn_1', 'c1', 'search_email', '{\"query\":\"invoice\"}', '{\"hits\":2}', 1, NULL, 420, ?)", [now]);
    db.run("INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, error, duration_ms, created_at) VALUES ('tcl_2', 'thr_1', 'trn_1', 'c2', 'read_email', '{}', NULL, 0, 'timeout', 9000, ?)", [now]);
    const log = [
      { role: "user", content: "did ACME send the invoice?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", function: { name: "search_email", arguments: "{\"query\":\"invoice\"}" } }], responseItems: [{ huge: true }] },
      { role: "tool", toolCallID: "c1", content: "{\"hits\":2}" },
    ];
    db.run("INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, step_count, token_count, max_steps, max_tokens, created_at, updated_at) VALUES ('thr_1', 'trn_1', 'done', ?, 2, 300, 16, 16000, ?, ?)", [JSON.stringify(log), now, now]);

    expect((await debugRequest(new Request("http://localhost/debug/overview"), db, router, config)).status).toBe(401);
    const { token } = await mintToken(db, "debug-test");
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const overview = await (await debugRequest(new Request("http://localhost/debug/overview", auth), db, router, config)).json() as {
      limits: { maxSteps: number; turnTimeoutMs: number };
      turns: Array<{ id: string; tool_count: number; failed_count: number; tool_names: string; step_count: number }>;
      sessions: Array<{ message_count: number }>;
    };
    expect(overview.limits).toMatchObject({ maxSteps: 16, turnTimeoutMs: 120_000 });
    expect(overview.turns[0]).toMatchObject({ id: "trn_1", tool_count: 2, failed_count: 1, tool_names: "search_email,read_email", step_count: 2 });
    expect(overview.sessions[0]!.message_count).toBe(3);

    const detail = await (await debugRequest(new Request("http://localhost/debug/turns/trn_1", auth), db, router, config)).json() as {
      tools: Array<{ tool_name: string; ok: boolean; args: unknown; duration_ms: number }>;
      context: Array<{ role: string; toolCalls?: Array<{ name: string }>; responseItems?: unknown }>;
    };
    expect(detail.tools.map((tool) => [tool.tool_name, tool.ok, tool.duration_ms])).toEqual([["search_email", true, 420], ["read_email", false, 9000]]);
    expect(detail.tools[0]!.args).toEqual({ query: "invoice" });
    expect(detail.context.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(detail.context[1]!.toolCalls?.[0]?.name).toBe("search_email");
    expect(detail.context[1]!.responseItems).toBeUndefined();

    expect((await debugRequest(new Request("http://localhost/debug/turns/nope", auth), db, router, config)).status).toBe(404);
  } finally { db.close(); }
});
