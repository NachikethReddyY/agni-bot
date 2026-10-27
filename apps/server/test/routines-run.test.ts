import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { executeRoutine, ROUTINE_TOOL_ALLOWLIST } from "../src/routines/run";
import { buildRoutinePrompt } from "../src/routines/prompt";
import type { Routine } from "../src/routines/types";
import { insertRoutine, getRoutine } from "../src/stores/routines";
import { createThread } from "../src/stores/threads";
import { ensureConversation, backgroundSession } from "../src/stores/conversations";
import { runTaskTurn } from "../src/agent/task-loop";
import { resolvePersona } from "../src/agent/personas";
import { rootGuardrail } from "../src/agent/guardrails";

let db: Database | undefined;
let dbPath: string | undefined;
afterEach(() => { db?.close(); db = undefined; if (dbPath) rmSync(dbPath, { force: true }); dbPath = undefined; });

function routine(overrides: Partial<Routine> = {}): Routine {
  const now = new Date().toISOString();
  return {
    id: "rtn_test", jobID: "job_test", agentID: "ea", name: "Daily check", prompt: "Check the status.",
    cron: "0 9 * * *", timezone: "UTC", misfire: "run_once", preflight: { kind: "none" },
    maxTokens: 16_000, maxExecutionMs: 5_000, allowedDomains: [], threadID: null,
    lastStateHash: null, stateContext: { seen: 1 }, successStreak: 0, failureStreak: 0,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

function setup(value = routine(), fileBacked = false): Database {
  const path = fileBacked ? join(tmpdir(), `agni-routine-${crypto.randomUUID()}.sqlite`) : ":memory:";
  if (fileBacked) dbPath = path;
  db = openDatabase(path);
  db.run("INSERT INTO jobs (id, kind, payload, run_at, enabled, created_at, updated_at) VALUES (?, 'routine', '{}', ?, 1, ?, ?)", [value.jobID, new Date().toISOString(), value.createdAt, value.createdAt]);
  insertRoutine(db, value);
  return db;
}

function routerWith(route: (request: any) => Promise<any> | any) {
  let calls = 0;
  const router = { route: async (request: any) => { calls++; return route(request); } };
  return { router: router as any, calls: () => calls };
}

const settings = { firstTokenTimeoutMs: 1_000, turnTimeoutMs: 10_000 };

describe("routine execution", () => {
  test("unchanged hash records a silent skip without calling the router", async () => {
    const r = routine({ preflight: { kind: "sql", query: "SELECT 1 AS value" }, lastStateHash: new Bun.CryptoHasher("sha256").update('[{"value":1}]').digest("hex") });
    const database = setup(r, true);
    const fake = routerWith(() => { throw new Error("router must not be called"); });
    const posted: unknown[] = [];
    const run = await executeRoutine({ db: database, router: fake.router, settings, emit: (frame) => posted.push(frame) }, r);
    expect(run.outcome).toBe("skipped_no_delta");
    expect(run.tokens).toBe(0);
    expect(fake.calls()).toBe(0);
    expect(database.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(posted).toEqual([]);
  });

  test("changed state runs once and persists the returned state context", async () => {
    const r = routine({ preflight: { kind: "none" } });
    const database = setup(r);
    const fake = routerWith(async (request) => {
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("mail_send");
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("bash");
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("write_file");
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("handoff");
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("routine_create");
      expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("ask");
      return { text: "Status is good.\n\nRoutine state (used next run)\n```json\n{\"stateContext\":{\"seen\":2}}\n```", outputTokens: 20, provider: "fake", model: "fake", latencyMs: 1 };
    });
    const thread = createThread(database, "ea");
    const routineWithThread = { ...r, threadID: thread.id };
    const run = await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, routineWithThread);
    expect(fake.calls()).toBe(1);
    expect(run.outcome).toBe("ran");
    expect(getRoutine(database, r.id)).toMatchObject({ stateContext: { seen: 2 }, successStreak: 1, failureStreak: 0 });
  });

  test("timeout keeps prior state", async () => {
    const r = routine({ maxExecutionMs: 10, threadID: null });
    const database = setup(r);
    const fake = routerWith((request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const run = await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, r);
    expect(run.outcome).toBe("timed_out");
    expect(getRoutine(database, r.id)?.stateContext).toEqual({ seen: 1 });
  });

  test("invalid state JSON keeps the prior state and records a warning", async () => {
    const r = routine({ preflight: { kind: "none" } });
    const database = setup(r);
    const fake = routerWith(() => ({ text: "The check is complete, but I omitted the state block.", outputTokens: 4, provider: "fake", model: "fake", latencyMs: 1 }));
    const run = await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, r);
    expect(run.outcome).toBe("ran");
    expect(run.error).toContain("Warning");
    expect(getRoutine(database, r.id)?.stateContext).toEqual({ seen: 1 });
  });

  test("prompt-injected mail_send and ask calls get not available results", async () => {
    const r = routine({ preflight: { kind: "none" } });
    const database = setup(r);
    const fake = routerWith(async (request) => {
      if (!request.messages.some((message: any) => String(message.content).includes("not available"))) {
        expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("mail_send");
        expect(request.tools.map((tool: any) => tool.function.name)).not.toContain("ask");
        return {
          text: "",
          toolCalls: ["mail_send", "ask"].map((name) => ({ id: `call-${name}`, type: "function", function: { name, arguments: "{}" } })),
          outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1,
        };
      }
      return { text: "Done. ```json {\"stateContext\":null} ```", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1 };
    });
    await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, r);
    const results = database.query<{ result: string }, []>("SELECT result FROM tool_calls ORDER BY created_at").all();
    expect(results).toHaveLength(2);
    expect(results.map((row) => row.result).every((text) => text.includes("not available"))).toBe(true);
  });

  test("routine tool specs exclude every write, send, and routine-creating tool", async () => {
    const r = routine({ preflight: { kind: "none" } });
    const database = setup(r);
    const sent: string[][] = [];
    const fake = routerWith((request) => {
      sent.push(request.tools.map((tool: any) => tool.function.name));
      return { text: "Done.", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1 };
    });
    await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, r);
    const names = sent.flat();
    for (const banned of ["mail_send", "bash", "write_file", "handoff", "routine_create", "ask", "run_privileged"]) {
      expect(names).not.toContain(banned);
    }
    for (const name of names) expect(ROUTINE_TOOL_ALLOWLIST).toContain(name);
  });

  test("a tool allowlist never grants a tool the persona lacks", async () => {
    const r = routine({ preflight: { kind: "none" } });
    const database = setup(r);
    const persona = { ...resolvePersona(database, "ea")!, tools: ["grep"] };
    const conversation = ensureConversation(database, "ea");
    const thread = backgroundSession(database, conversation, "scope check");
    const sent: string[] = [];
    const fake = routerWith((request) => {
      sent.push(...request.tools.map((tool: any) => tool.function.name));
      return { text: "Done.", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1 };
    });
    await runTaskTurn(database, fake.router, settings, {
      threadID: thread.id, text: "check", persona, emit: () => {}, signal: AbortSignal.timeout(5_000),
      conversationID: conversation.id, carrySummary: null, guardrail: rootGuardrail("ea"),
      toolAllowlist: ["grep", "bash", "mail_send"],
    });
    expect(sent).not.toContain("bash");
    expect(sent).not.toContain("mail_send");
    expect(sent).not.toContain("ask");
    expect(sent).toContain("grep");
    expect(sent.every((name) => name === "grep")).toBe(true);
  });

  test("web_fetch to a host outside the routine's allowlist is refused", async () => {
    const r = routine({ preflight: { kind: "none" }, allowedDomains: ["example.com"] });
    const database = setup(r);
    let step = 0;
    const fake = routerWith(() => {
      step++;
      if (step === 1) {
        return {
          text: "", toolCalls: [{ id: "call-fetch", type: "function", function: { name: "web_fetch", arguments: JSON.stringify({ url: "https://evil.com/" }) } }],
          outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1,
        };
      }
      return { text: "Done. ```json {\"stateContext\":null} ```", outputTokens: 1, provider: "fake", model: "fake", latencyMs: 1 };
    });
    await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, r);
    const row = database.query<{ result: string }, []>("SELECT result FROM tool_calls ORDER BY created_at").get();
    expect(row?.result).toContain("domain is not allowed");
  });

  test("a small routine token budget stops the task loop after its first call", async () => {
    const r = routine({ preflight: { kind: "none" }, maxTokens: 1 });
    const database = setup(r);
    const fake = routerWith((request) => {
      expect(request.maxTokens).toBe(1);
      return {
        text: "", toolCalls: [{ id: "call-tasks", type: "function", function: { name: "tasks_list", arguments: "{}" } }],
        outputTokens: 2, provider: "fake", model: "fake", latencyMs: 1,
      };
    });
    const run = await executeRoutine({ db: database, router: fake.router, settings, emit: () => {} }, r);
    expect(fake.calls()).toBe(1);
    expect(run.outcome).toBe("budget_exceeded");
  });

  test("five failures disable the job and notify", async () => {
    const r = routine({ preflight: { kind: "none" } });
    const database = setup(r);
    const fake = routerWith(() => { throw new Error("provider failure"); });
    const frames: any[] = [];
    for (let i = 0; i < 5; i++) {
      const current = getRoutine(database, r.id)!;
      await executeRoutine({ db: database, router: fake.router, settings, emit: (frame) => frames.push(frame) }, current);
    }
    expect(database.query("SELECT enabled FROM jobs WHERE id = ?").get(r.jobID)).toEqual({ enabled: 0 });
    expect(frames.some((frame) => frame.type === "notify" && frame.body.includes("paused after 5 failures"))).toBe(true);
  });

  test("prompt separates saved state from instructions and allowlist is read-only", () => {
    const text = buildRoutinePrompt(routine({ stateContext: { note: "value" } }));
    expect(text).toContain("fenced JSON is prior routine state data");
    expect(text).toContain("Routine state (used next run)");
    expect(text).toContain("under 1 KB");
    expect(ROUTINE_TOOL_ALLOWLIST).not.toContain("mail_send");
    expect(ROUTINE_TOOL_ALLOWLIST).not.toContain("ask");
    expect(ROUTINE_TOOL_ALLOWLIST).not.toContain("write_file");
  });
});
