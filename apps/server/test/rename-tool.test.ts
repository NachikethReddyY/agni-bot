import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { ToolRegistry } from "../src/tools/registry";
import { registerRenameTool } from "../src/tools/rename-tool";
import { buildTaskToolRegistry, taskToolSpecs } from "../src/tools/task-registry";
import { resolvePersona } from "../src/agent/personas";

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

function harness(agentID = "ea") {
  const registry = new ToolRegistry();
  const emitted: ServerFrameBody[] = [];
  registerRenameTool(registry, { db: db!, emit: (frame) => emitted.push(frame), currentAgentID: agentID });
  const tool = registry.get("rename_agent");
  if (!tool) throw new Error("rename_agent was not registered");
  const ctx = { threadID: "thr_test", turnID: "trn_test", signal: AbortSignal.timeout(1_000) };
  return { registry, emitted, tool, ctx };
}

describe("rename_agent tool", () => {
  test("renames the calling agent and pushes agent.updated", async () => {
    db = openDatabase(":memory:");
    const { emitted, tool, ctx } = harness();
    const result = (await tool.handler({ name: "Baahu" } as never, ctx)) as Record<string, unknown>;
    expect(result).toEqual({ ok: true, agentId: "ea", previousName: "New Bot", name: "Baahu" });
    expect(emitted).toEqual([{ type: "agent.updated", agentId: "ea", displayName: "Baahu", onboarded: true }]);
    expect(resolvePersona(db, "ea")?.systemPrompt.split("\n")[0]).toBe("You are Baahu, personal assistant to the owner.");
  });

  test("can rename another agent by id, and refuses an unknown one", async () => {
    db = openDatabase(":memory:");
    const { emitted, tool, ctx } = harness();
    const renamed = (await tool.handler({ name: "Scout", agentId: "researcher" } as never, ctx)) as Record<string, unknown>;
    expect(renamed.ok).toBe(true);
    expect(renamed.agentId).toBe("researcher");
    expect(emitted[0]).toMatchObject({ type: "agent.updated", agentId: "researcher", displayName: "Scout" });

    const refused = (await tool.handler({ name: "Ghost", agentId: "nobody" } as never, ctx)) as Record<string, unknown>;
    expect(refused.ok).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  test("a bad name is refused without emitting or writing", async () => {
    db = openDatabase(":memory:");
    const { emitted, tool, ctx } = harness();
    const result = (await tool.handler({ name: "  " } as never, ctx)) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(db.query<{ display_name: string }, []>("SELECT display_name FROM agents WHERE id = 'ea'").get()?.display_name).toBe("New Bot");
  });

  test("the tool is exposed to the ea persona in the model's tool list", () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    registerRenameTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const names = taskToolSpecs(registry, resolvePersona(db, "ea")!.tools, "static").map((spec) => spec.function.name);
    expect(names).toContain("rename_agent");
  });
});
