/**
 * An agent creating its own agent. The owner asks in chat for a bot; the
 * model calls `create_agent`; the new agent must be in the roster, resolvable
 * as a persona, durable in the agents table, and broadcast to clients — all in
 * the same turn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { buildDelegationPrefix } from "../src/agent/prompts";
import { defaultResolvedPersona, loadRuntimeAgents, personaInfo, registerPersona, resolvePersona, teamRoster, PERSONAS } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";
import type { Persona } from "../src/agent/personas";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); },
  }), { status: 200 });
}

function createAgentRouter(args: Record<string, unknown>): Router {
  let call = 0;
  const fetchMock = (async (): Promise<Response> => {
    call += 1;
    return call === 1
      ? streamResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "create_agent", arguments: JSON.stringify(args) } }] } }] }])
      : streamResponse([{ choices: [{ delta: { content: "Done." } }] }]);
  }) as unknown as typeof fetch;
  return new Router([provider], new HealthTracker(), fetchMock);
}

let db: Database | undefined;
// registerPersona mutates the process-wide roster, and bun shares module
// state across test files — so every test here restores it, or the bots it
// created would leak into personas.test.ts and break its exact-roster
// assertions.
const INITIAL_ROSTER = PERSONAS.length;
afterEach(() => {
  db?.close();
  db = undefined;
  PERSONAS.length = INITIAL_ROSTER;
});

describe("an agent creating its own agent", () => {
  test("a create_agent call registers a selectable, durable agent and broadcasts it", async () => {
    db = openDatabase(":memory:");
    const persona = defaultResolvedPersona(db);
    const thread = createThread(db, persona.id);
    const router = createAgentRouter({ name: "FRIDAY", role: "companion", prompt: "You are blunt and sharp." });
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "make me a companion bot", persona,
      emit: (frame) => { emitted.push(frame as { type: string; [key: string]: unknown }); },
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Done.");
    // Durable row, ready to rename.
    const row = db.query<{ id: string; name: string; display_name: string; avatar_color: string; onboarded: number }, []>(
      "SELECT id, name, display_name, avatar_color, onboarded FROM agents WHERE id = 'friday'",
    ).get();
    expect(row).toMatchObject({ id: "friday", name: "FRIDAY", display_name: "FRIDAY", onboarded: 1 });
    expect(row?.avatar_color).toMatch(/^#/);
    // The role the model gave is the role the agent keeps — it is what the
    // orchestrator reads when deciding who to hand work to.
    expect(db.query<{ role_detail: string }, []>("SELECT role_detail FROM agents WHERE id = 'friday'").get()?.role_detail).toBe("companion");
    // The hierarchy role stays the hierarchy role.
    expect(db.query<{ role: string }, []>("SELECT role FROM agents WHERE id = 'friday'").get()?.role).toBe("agent");
    // In the roster the app receives, and resolvable as a persona.
    const roster = personaInfo(db);
    expect(roster.some((agent) => agent.id === "friday")).toBe(true);
    const resolved = resolvePersona(db, "friday");
    expect(resolved?.name).toBe("FRIDAY");
    expect(resolved?.systemPrompt).toContain("You are blunt and sharp.");
    // A handoff target for the others, and broadcast to clients this turn.
    expect(teamRoster(db, { exclude: "ea" }).some((member) => member.id === "friday")).toBe(true);
    const update = emitted.find((frame) => frame.type === "agents.update");
    expect(update).toBeDefined();
    expect((update?.agents as Array<{ id: string }>).some((agent) => agent.id === "friday")).toBe(true);
  });

  test("unknown tools are dropped and a sensible default set is applied", async () => {
    db = openDatabase(":memory:");
    const persona = defaultResolvedPersona(db);
    const thread = createThread(db, persona.id);
    const router = createAgentRouter({
      name: "Scout", role: "lookout", prompt: "You watch things.",
      tools: ["web_search", "not_a_real_tool", "mail_send"],
    });
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "make a lookout", persona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    const tools = resolvePersona(db, "scout")?.tools ?? [];
    expect(tools).toContain("web_search");
    expect(tools).toContain("mail_send");
    expect(tools).not.toContain("not_a_real_tool");
  });

  test("a new agent with no tools gets the default set", async () => {
    db = openDatabase(":memory:");
    const persona = defaultResolvedPersona(db);
    const thread = createThread(db, persona.id);
    const router = createAgentRouter({ name: "Solo", prompt: "You work alone." });
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "make a lone wolf", persona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    const tools = resolvePersona(db, "solo")?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain("memory_search");
  });

  test("an agent created in chat survives a restart", async () => {
    db = openDatabase(":memory:");
    const persona = defaultResolvedPersona(db);
    const thread = createThread(db, persona.id);
    const router = createAgentRouter({
      name: "Scout", role: "lookout", prompt: "You watch things.", tools: ["web_search", "web_fetch"],
    });
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "make a lookout", persona,
      emit: () => undefined, signal: new AbortController().signal,
    });

    // The row carries what the roster needs, so a fresh process can rebuild it.
    const row = db.query<{ tools: string | null }, []>("SELECT tools FROM agents WHERE id = 'scout'").get();
    expect(JSON.parse(row?.tools ?? "[]")).toEqual(["web_search", "web_fetch"]);

    // A restart: the roster is back to what the process shipped with, and the
    // bot is rebuilt from the row — it must not vanish from the sidebar.
    PERSONAS.length = INITIAL_ROSTER;
    expect(personaInfo(db).some((agent) => agent.id === "scout")).toBe(false);

    const restored = loadRuntimeAgents(db);
    expect(restored).toBe(1);
    const roster = personaInfo(db);
    const scout = roster.find((agent) => agent.id === "scout");
    expect(scout?.name).toBe("Scout");
    expect(scout?.tools).toEqual(["web_search", "web_fetch"]);
    expect(resolvePersona(db, "scout")?.systemPrompt).toContain("You watch things.");
    // Loading twice is a no-op, not a duplicate.
    expect(loadRuntimeAgents(db)).toBe(0);
  });
});

describe("registerPersona", () => {
  test("adds to the roster and refuses a duplicate id", () => {
    db = openDatabase(":memory:");
    const persona: Persona = { id: "dupe", name: "Dupe", color: "#ffffff", role: "r", systemPromptTemplate: "p", tools: [] };
    registerPersona(persona);
    expect(personaInfo(db).some((agent) => agent.id === "dupe")).toBe(true);
    expect(() => registerPersona({ ...persona })).toThrow("already exists");
  });
});

describe("task-lane prompt", () => {
  test("carries the session summary into the delegation prefix", () => {
    const db = openDatabase(":memory:");
    const prefix = buildDelegationPrefix({
      persona: defaultResolvedPersona(db), facts: [], carrySummary: "SUMMARY-MARKER-7",
      handoffSummary: null, depth: 0, maxDepth: 3,
    });
    expect(prefix).toContain("SUMMARY-MARKER-7");
    db.close();
  });
});
