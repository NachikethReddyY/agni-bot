/**
 * Redefining an agent. The owner says "Friday is now an inbox manager" — that
 * has to become the agent's role and prompt, durably, and every client has to
 * see it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { createUpdateAgentTool, updateAgent } from "../src/tools/update-agent-tool";
import { personaInfo, resolvePersona, registerPersona } from "../src/agent/personas";
import type { Persona } from "../src/agent/personas";

const chainOf = (id: string) => ({ depth: 1, rootAgentID: id, currentAgentID: id, handoffSummary: null });
let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

// The roster is process state: register the runtime agent once.
const runtimeAgent: Persona = {
  id: "testbot",
  name: "Test Bot",
  color: "#4a9eff",
  role: "General-purpose personal assistant",
  systemPromptTemplate: "You are Test Bot — a calm, precise assistant.",
  tools: ["mail_search", "mail_read"],
};
registerPersona(runtimeAgent);

describe("updating an agent", () => {
  test("a new role and prompt land, and survive a restart", () => {
    db = openDatabase(":memory:");
    const database = db;
    db.run(
      `INSERT INTO agents (id, name, color, role, role_detail, default_name, display_name, system_prompt, avatar_color, onboarded, tools, created_at, updated_at)
       VALUES ('testbot', 'Test Bot', '#4a9eff', 'agent', NULL, 'Test Bot', 'Test Bot', ?, '#4a9eff', 1, '["mail_search"]', 'now', 'now')`,
      ["You are Test Bot — a calm, precise assistant."],
    );

    const result = updateAgent(database, {
      agentID: "testbot",
      role: "inbox manager — first line of defense on the owner's mail",
      prompt: "You are {name}, the inbox manager. Read-only by default: never send, reply or react without the owner typing \"send\".",
    });
    expect(result.id).toBe("testbot");
    expect(result.role).toContain("inbox manager");

    // The row is the durable truth.
    const row = db.query<{ role_detail: string; system_prompt: string }, []>("SELECT role_detail, system_prompt FROM agents WHERE id = 'testbot'").get();
    expect(row?.role_detail).toContain("inbox manager");
    expect(row?.system_prompt).toContain("inbox manager");

    // And the live persona resolves to it, right away.
    const resolved = resolvePersona(database, "testbot");
    expect(resolved?.role).toContain("inbox manager");
    expect(resolved?.systemPrompt).toContain("inbox manager");
    expect(resolved?.systemPrompt).toContain("Test Bot"); // {name} substituted
  });

  test("the roster shows the new role, and the tool broadcasts it", async () => {
    db = openDatabase(":memory:");
    const database = db;
    db.run(
      `INSERT INTO agents (id, name, color, role, default_name, display_name, system_prompt, avatar_color, onboarded, created_at, updated_at)
       VALUES ('testbot', 'Test Bot', '#4a9eff', 'agent', 'Test Bot', 'Test Bot', 'You are Test Bot', '#4a9eff', 1, 'now', 'now')`,
    );
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const tool = createUpdateAgentTool({ db, emit: (frame) => emitted.push(frame as { type: string }) });
    await tool.handler({ agentID: "testbot", role: "inbox manager" }, { threadID: "thr_x", turnID: "trn_x", signal: new AbortController().signal, chain: chainOf("testbot") });

    const roster = personaInfo(database);
    expect(roster.find((agent) => agent.id === "testbot")?.role).toContain("inbox manager");
    expect(emitted.find((frame) => frame.type === "agents.update")).toBeDefined();
  });

  test("an unknown agent is refused", () => {
    db = openDatabase(":memory:");
    const database = db;
    expect(() => updateAgent(database, { agentID: "nobody", role: "x" })).toThrow(/no agent with id/);
  });

  test("a bot cannot update another bot (C3)", async () => {
    db = openDatabase(":memory:");
    const tool = createUpdateAgentTool({ db, emit: () => undefined });
    const ctx = { chain: chainOf("researcher") } as never;
    const hit = await tool.handler({ agent_id: "ea", prompt: "evil", visibility: "shared" } as never, ctx);
    expect((hit as { error?: string }).error).toContain("only update itself");
    expect(await tool.handler({ role: "Research lead" } as never, ctx)).not.toHaveProperty("error");
  });
});
