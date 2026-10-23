import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import type { ResolvedPersona } from "../src/agent/personas";
import { createThread, createTurn } from "../src/stores/threads";
import { ensureDMChannel } from "../src/stores/channels";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};
const taskPersona: ResolvedPersona = {
  id: "agni", name: "Agni", color: "#f0b95a", role: "front desk",
  systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.",
  tools: ["tasks_list"],
};
let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}

describe("task lane loop", () => {
  test("the model renaming the agent persists it, with no approval card", async () => {
    db = openDatabase(":memory:");
    const persona = { ...taskPersona, tools: ["rename_agent"] };
    const thread = createThread(db, persona.id);
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "rename_agent", arguments: "{\"name\":\"Baahu\"}" } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "Renamed to Baahu." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "I want to call you Baahu", persona,
      emit: (frame) => { emitted.push(frame as { type: string; [key: string]: unknown }); },
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Renamed to Baahu.");
    expect(db.query<{ display_name: string }, []>("SELECT display_name FROM agents WHERE id = 'ea'").get()?.display_name).toBe("Baahu");
    expect(db.query("SELECT tool_name, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)).toEqual({ tool_name: "rename_agent", ok: 1 });
    const updated = emitted.find((frame) => frame.type === "agent.updated");
    expect(updated).toMatchObject({ agentId: "ea", displayName: "Baahu", onboarded: true });
    // Renaming is reversible, so it must not stop the turn for a click.
    expect(emitted.find((frame) => frame.type === "approval.request")).toBeUndefined();
  });

  test("a write outside the scratch tree still gates, and the decision resumes it", async () => {
    db = openDatabase(":memory:");
    const persona = { ...taskPersona, tools: ["write_file"] };
    const thread = createThread(db, persona.id);
    const outside = join(tmpdir(), `agni-policy-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: outside, content: "hello" }) } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "Wrote it." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    try {
      const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
        threadID: thread.id, text: "write a file OUTSIDE scratch", persona,
        emit: (frame) => {
          emitted.push(frame as { type: string; [key: string]: unknown });
          // Answer the card the way the app does: record durably, wake the waiter.
          if (frame.type === "approval.request") {
            db!.run("UPDATE approvals SET status = 'decided', decision = 'once', decided_at = ? WHERE id = ?", [
              new Date().toISOString(), String(frame.requestID),
            ]);
            resolveApprovalWaiter(String(frame.requestID), "once");
          }
        },
        signal: new AbortController().signal,
      });
      expect(emitted.filter((frame) => frame.type === "approval.request")).toHaveLength(1);
      expect(emitted.find((frame) => frame.type === "approval.request")).toMatchObject({ action: `write file: ${outside}` });
      expect(db.query("SELECT tool_name, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)).toEqual({ tool_name: "write_file", ok: 1 });
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("executes a store tool, observes its result, and returns a final response", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const requestBodies: Array<Record<string, unknown>> = [];
    let request = 0;
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      request += 1;
      return request === 1
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\",\"limit\":5}" } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "You have no open tasks." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "What tasks do I have?", persona: taskPersona,
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }), signal: new AbortController().signal,
    });

    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("You have no open tasks.");
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.tools).toHaveLength(2);
    expect(
      (requestBodies[0]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort(),
    ).toEqual(["say", "tasks_list"]);
    expect(requestBodies[0]?.tool_choice).toBe("auto");
    expect((requestBodies[1]?.messages as Array<Record<string, unknown>>).some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
    expect(db.query("SELECT tool_name, ok FROM tool_calls WHERE turn_id = ?").get(result.turnID)).toEqual({ tool_name: "tasks_list", ok: 1 });
    expect(db.query("SELECT state FROM agent_sessions WHERE thread_id = ?").get(thread.id)).toEqual({ state: "done" });
  });

  test("keeps generic shell and file tools outside the task allowlist", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const registry = new Router([provider], new HealthTracker(), (async () => streamResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-shell", type: "function", function: { name: "bash", arguments: "{\"command\":\"echo no\"}" } }] } }] },
    ])) as unknown as typeof fetch);
    const result = await runTaskTurn(db, registry, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "Run a command", persona: taskPersona,
      emit: () => undefined, signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("end");
    expect(db.query<{ result: string }, [string]>("SELECT result FROM tool_calls WHERE turn_id = ?").get(result.turnID)?.result).toContain("not available");
  });

  test("recovers an interrupted session without replaying an uncertain tool side effect", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const oldTurnID = "trn_interrupted";
    createTurn(db, { id: oldTurnID, threadID: thread.id, agentID: taskPersona.id });
    const log = [
      { role: "user", content: "Add a task" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-uncertain", type: "function", function: { name: "task_create", arguments: "{\\\"title\\\":\\\"Do not duplicate\\\"}" } }] },
    ];
    db.run("INSERT INTO agent_sessions (thread_id, turn_id, state, message_log, max_steps, max_tokens, created_at, updated_at) VALUES (?, ?, 'running', ?, 8, 16000, datetime('now'), datetime('now'))", [thread.id, oldTurnID, JSON.stringify(log)]);
    db.run("INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, created_at) VALUES ('tcl_interrupted', ?, ?, 'call-uncertain', 'task_create', '{\"title\":\"Do not duplicate\"}', NULL, 0, datetime('now'))", [thread.id, oldTurnID]);

    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse([{ choices: [{ delta: { content: "I resumed. Please retry that task action if needed." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "Continue", persona: taskPersona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    const sentMessages = requestBody?.messages as Array<{ role: string; content: string }>;
    expect(result.turnID).toBe(oldTurnID);
    expect(sentMessages.some((message) => message.role === "tool" && message.content.includes("was not repeated"))).toBe(true);
    expect(db.query("SELECT count(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    expect(db.query<{ state: string }, [string]>("SELECT state FROM agent_sessions WHERE thread_id = ?").get(thread.id)?.state).toBe("done");
  });

  test("a turn that runs out of steps says what the tools actually did", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    // The model only ever calls a tool: the turn has to end on the step
    // budget, and the answer has to name the work that happened.
    const fetchMock = (async () => streamResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-loop", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\",\"limit\":5}" } }] } }] },
    ])) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "List my tasks, then keep going", persona: taskPersona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    expect(result.text).toContain("hit the 16-tool limit");
    expect(result.text).toContain("Done: tasks_list");
    // The message is durable: it is what the thread shows after a reload.
    expect(db.query<{ text: string }, [string]>("SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant'").get(thread.id)?.text).toContain("Done: tasks_list");
  });

  test("a turn that reads the app's own source is stopped, and told what it can do", async () => {
    db = openDatabase(":memory:");
    const persona = { ...taskPersona, tools: ["bash", "mail_search", "task_create"] };
    const thread = createThread(db, persona.id);
    // The failure this catches: the owner asks for something the tools cannot
    // do, and the model goes to read the app's source to find out how to
    // build it — fifteen `cat` calls, then a budget failure that tells the
    // owner nothing.
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return streamResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "cat apps/server/src/ws/frames.ts" }) } }] } }] },
      ]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "add a fire board widget to the app", persona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    // It stops early, with the truth, instead of running out of budget.
    expect(result.text).toContain("I can't change how the app itself works");
    expect(result.text).not.toContain("task budget");
    expect(result.text).toContain("mail");
    // The message is short: it names what it can do, not the whole tool list.
    expect(result.text).not.toContain("mail_search");
    expect(result.text.length).toBeLessThan(320);
    // Fewer than the full step budget: the guard fired first.
    const calls = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM tool_calls").get()?.n ?? 0;
    expect(calls).toBeLessThan(16);
    // The model was told to act before the turn was cut.
    const log = db.query<{ message_log: string }, [string]>("SELECT message_log FROM agent_sessions WHERE thread_id = ?").get(thread.id)?.message_log ?? "";
    expect(log).toContain("Stop reading the app's source");
  });

  test("interleaving lookups does not hide the wandering", async () => {
    db = openDatabase(":memory:");
    const persona = { ...taskPersona, tools: ["bash", "job_list", "recall_fact", "task_create"] };
    const thread = createThread(db, persona.id);
    let request = 0;
    const calls = ["bash", "job_list", "bash", "recall_fact", "bash", "bash", "bash"];
    const fetchMock = (async () => {
      request += 1;
      const name = calls[Math.min(request - 1, calls.length - 1)] ?? "bash";
      const args = name === "bash" ? { command: "cat apps/server/src/ws/frames.ts" } : {};
      return streamResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
      ]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "add a fire board widget to the app", persona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    // Looking at the app's own state is not progress, so the guard still fires.
    expect(result.text).toContain("I can't change how the app itself works");
    expect(result.text).not.toContain("tool limit");
  });

  test("a request about the code is not treated as going off road", async () => {
    db = openDatabase(":memory:");
    const persona = { ...taskPersona, tools: ["bash"] };
    const thread = createThread(db, persona.id);
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      // Reading the source is the work here, so the guard stays out of it.
      return request <= 3
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "cat apps/server/src/index.ts" }) } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "Here is what the daemon does." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "read the code and explain how the daemon boots", persona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    expect(result.text).toBe("Here is what the daemon does.");
    expect(result.text).not.toContain("I can't change how the app itself works");
  });

  test("between-tool narration is not published as a message", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? streamResponse([
            { choices: [{ delta: { content: "Checking the list." } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\",\"limit\":5}" } }] } }] },
          ])
        : streamResponse([{ choices: [{ delta: { content: "You have no open tasks." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "What tasks do I have?", persona: taskPersona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    // The caller still gets the final answer, and the transcript keeps only
    // the answer: step narration is thinking aloud, not something to show.
    expect(result.text).toBe("You have no open tasks.");
    const durable = db.query<{ text: string }, [string]>(
      "SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY rowid",
    ).all(thread.id);
    expect(durable.map((row) => row.text)).toEqual(["You have no open tasks."]);
  });

  test("a channel turn buffers step narration and streams only the answer", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    const channel = ensureDMChannel(db, taskPersona.id);
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? streamResponse([
            { choices: [{ delta: { content: "Checking the list." } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "tasks_list", arguments: "{\"status\":\"open\",\"limit\":5}" } }] } }] },
          ])
        : streamResponse([{ choices: [{ delta: { content: "You have no open tasks." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "What tasks do I have?", persona: taskPersona,
      channelID: channel.id,
      emit: (frame) => { emitted.push(frame as { type: string; [key: string]: unknown }); },
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("You have no open tasks.");
    const deltas = emitted.filter((frame) => frame.type === "token").map((frame) => frame.delta);
    expect(deltas).toEqual(["You have no open tasks."]);
    const published = emitted.filter((frame) => frame.type === "msg.new").map((frame) => frame.text);
    expect(published).toEqual(["You have no open tasks."]);
    // The token fills the bubble the durable message then seals.
    const tokenAt = emitted.findIndex((frame) => frame.type === "token");
    const messageAt = emitted.findIndex((frame) => frame.type === "msg.new");
    expect(tokenAt).toBeGreaterThan(-1);
    expect(messageAt).toBeGreaterThan(tokenAt);
  });

  test("a turn that fails outright leaves a message the user can see", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, taskPersona.id);
    // No providers at all: the model call cannot even start.
    const router = new Router([], new HealthTracker(), (async () => streamResponse([])) as unknown as typeof fetch);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "check your email", persona: taskPersona,
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }), signal: new AbortController().signal,
    });

    expect(result.stopReason).toBe("error");
    expect(result.text).toContain("This turn failed:");
    expect(result.text).toContain("no model providers configured");
    expect(emitted.find((frame) => frame.type === "error")).toMatchObject({ code: "no_provider" });
    expect(db.query<{ text: string }, [string]>("SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant'").get(thread.id)?.text).toContain("This turn failed:");
  });
});
