import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn, turnEmbedder } from "../src/agent/task-loop";
import { TURN_EMBED_TIMEOUT_MS } from "../src/agent/retrieval";
import { isSmallTalk } from "../src/agent/gate";
import { resolvePersona } from "../src/agent/personas";
import type { EmbedderConfig } from "../src/agent/embeddings";
import { createThread } from "../src/stores/threads";
import {
  buildTaskToolRegistry, CORE_TOOLS, DEFER_TOOLS_ABOVE, deferredToolHints, deferredTools, registerLoadTools,
} from "../src/tools/task-registry";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

type Ctx = { threadID: string; turnID: string; signal: AbortSignal };
type Handler = (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
const ctx: Ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };

describe("deferred tools", () => {
  test("a small allowlist defers nothing; a large one defers non-core registered names", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const small = ["grep", "glob", "read_file"];
    expect(small.length).toBeLessThanOrEqual(DEFER_TOOLS_ABOVE);
    expect(deferredTools(registry, small)).toEqual([]);

    const big = [...CORE_TOOLS, "grep", "glob", "read_file", "not_a_tool", "bash", "mail_search"];
    expect(big.length).toBeGreaterThan(DEFER_TOOLS_ABOVE);
    const deferred = deferredTools(registry, big);
    expect(deferred).toEqual(big.filter((n) => !CORE_TOOLS.has(n) && registry.get(n)));
    expect(deferred).toContain("grep");
    expect(deferred).not.toContain("not_a_tool");
    for (const name of CORE_TOOLS) expect(deferred).not.toContain(name);
  });

  test("hints are one short `- name: first sentence` line each", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const names = ["grep", "glob", "read_file", "bash"].filter((n) => registry.get(n));
    const hints = deferredToolHints(registry, names);
    expect(hints).toHaveLength(names.length);
    hints.forEach((hint, i) => {
      expect(hint.startsWith(`- ${names[i]}: `)).toBe(true);
      expect(hint).not.toContain("\n");
      expect(hint.length).toBeLessThanOrEqual(110);
    });
  });

  test("load_tools loads known names, reports unknown ones, rejects a non-array", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const loaded = new Set<string>();
    registerLoadTools(registry, ["grep", "glob"], loaded);
    const handler = registry.get("load_tools")!.handler as unknown as Handler;

    expect(await handler({ names: ["grep", "nope"] }, ctx)).toEqual({ loaded: ["grep"], unknown: ["nope"] });
    expect([...loaded]).toEqual(["grep"]);
    await expect(handler({ names: "grep" }, ctx)).rejects.toThrow();
  });
});

describe("turnEmbedder and small talk", () => {
  const config: EmbedderConfig = { baseURL: "http://127.0.0.1:1234/v1", model: "m", kind: "openai", timeoutMs: 5_000 };

  test("no config or small talk means no embedder", () => {
    expect(turnEmbedder("What is the plan for Friday?", null)).toBeNull();
    for (const text of ["hi", "thanks!", "ok", ""]) expect(turnEmbedder(text, config)).toBeNull();
  });

  test("a real question caps the timeout but keeps a lower one", () => {
    expect(turnEmbedder("When is my dentist appointment?", config)?.timeoutMs).toBe(TURN_EMBED_TIMEOUT_MS);
    expect(turnEmbedder("When is my dentist appointment?", { ...config, timeoutMs: 100 })?.timeoutMs).toBe(100);
  });

  test("isSmallTalk", () => {
    expect(isSmallTalk("thanks")).toBe(true);
    expect(isSmallTalk("what's my wifi password?")).toBe(false);
  });
});

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };
function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}

describe("load_tools in a turn", () => {
  test("a deferred tool is hinted on call 1 and sent on call 2 after load_tools", async () => {
    db = openDatabase(":memory:");
    const persona = resolvePersona(db, "ea")!;
    const thread = createThread(db, persona.id);
    const bodies: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }> = [];
    const fetchMock = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["mail_search"] }) } }] } }] }])
        : streamResponse([{ choices: [{ delta: { content: "Loaded." } }] }]);
    }) as unknown as typeof fetch;
    const router = new Router([provider], new HealthTracker(), fetchMock);
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "Find the invoice email from Acme", persona,
      emit: () => {}, signal: new AbortController().signal,
    });

    const toolNames = (i: number) => bodies[i]!.tools.map((t) => t.function.name);
    expect(bodies).toHaveLength(2);
    expect(toolNames(0)).toContain("load_tools");
    expect(toolNames(0)).not.toContain("mail_search");
    expect(String(bodies[0]!.messages.find((m) => m.role === "system")?.content)).toContain("mail_search");
    expect(toolNames(1)).toContain("mail_search");
  });
});
