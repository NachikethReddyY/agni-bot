import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import type { ToolCall } from "../src/models/client";
import { runTaskTurn, startParallelReads } from "../src/agent/task-loop";
import { defaultResolvedPersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

describe("startParallelReads", () => {
  test("starts every read at once, skipping the duplicate guard's repeats", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = startParallelReads(
      [call("a", "memory_search", { q: 1 }), call("b", "web_fetch", { url: "x" }), call("c", "memory_search", { q: 1 })],
      new Map(), 0, 3, () => false,
      async (c) => { order.push(c.id); await gate; return c.id; },
    );
    // Both started before either finished; the exact repeat was left to the guard.
    expect(order).toEqual(["a", "b"]);
    expect([...started.keys()]).toEqual(["a", "b"]);
    release();
    expect(await started.get("b")).toBe("b");
  });

  test("a single call, a write, or a gated call keeps the step in series", () => {
    const run = async () => "x";
    expect(startParallelReads([call("a", "grep")], new Map(), 0, 3, () => false, run).size).toBe(0);
    expect(startParallelReads([call("a", "grep"), call("b", "write_file")], new Map(), 0, 3, () => false, run).size).toBe(0);
    expect(startParallelReads([call("a", "grep"), call("b", "glob")], new Map(), 0, 3, () => true, run).size).toBe(0);
  });
});

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("parallel reads in a turn", () => {
  test("tool results keep the model's call order", async () => {
    db = openDatabase(":memory:");
    const persona = defaultResolvedPersona(db);
    const thread = createThread(db, persona.id);
    let n = 0;
    const sse = (chunk: unknown) => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    const fetchStub = async () => n++ === 0
      ? sse({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "c1", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\"}" } },
        { index: 1, id: "c2", type: "function", function: { name: "recall_fact", arguments: "{}" } },
        { index: 2, id: "c3", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\"}" } },
      ] } }] })
      : sse({ choices: [{ delta: { content: "done" } }] });
    const router = new Router([{ id: "t", label: "T", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" }], new HealthTracker(), fetchStub as unknown as typeof fetch);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "what is open?", persona, emit: () => undefined, signal: new AbortController().signal,
    });
    expect(result.text).toBe("done");
    const log = JSON.parse(db.query<{ message_log: string }, [string]>("SELECT message_log FROM agent_sessions WHERE thread_id = ?").get(thread.id)!.message_log) as Array<{ role: string; toolCallID?: string; content: string }>;
    const tools = log.filter((m) => m.role === "tool");
    expect(tools.map((m) => m.toolCallID)).toEqual(["c1", "c2", "c3"]);
    expect(tools[2]!.content).toContain("Duplicate");
    expect(db.query("SELECT count(*) AS n FROM tool_calls WHERE thread_id = ?").get(thread.id)).toEqual({ n: 2 });
  });
});
