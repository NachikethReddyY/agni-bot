import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { registerScratchTools } from "../src/tools/scratch-tool";
import { createDelegationTask } from "../src/stores/tasks";
import { appendTaskNote, listTaskNotes, MAX_TASK_NOTES } from "../src/stores/task-notes";
import { runTaskTurn } from "../src/agent/task-loop";
import { resolvePersona, updatePersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

type Handler = { handler: (args: Record<string, unknown>, ctx?: unknown) => Promise<Record<string, unknown>> };
const ctx = { threadID: "t", turnID: "u", signal: new AbortController().signal };

describe("task scratchpad", () => {
  test("bots on the task append and read; the delegator sees notes through visibility", async () => {
    db = openDatabase(":memory:");
    const task = createDelegationTask(db, { ownerAgentID: "researcher", brief: { goal: "Find the venue" }, parentAgentID: "ea" });
    const child = new ToolRegistry();
    registerScratchTools(child, { db, taskID: task.id, agentID: "researcher" });
    await (child.get("scratch_append") as unknown as Handler).handler({ text: "Venue A is booked." }, ctx);
    const read = await (child.get("scratch_read") as unknown as Handler).handler({}, ctx);
    expect(read.notes).toEqual([expect.objectContaining({ agentID: "researcher", text: "Venue A is booked." })]);

    const parent = new ToolRegistry();
    registerDelegateTaskTool(parent, { db, emit: () => undefined, currentAgentID: "ea" });
    const status = (parent.get("task_status") as unknown as Handler).handler;
    updatePersona(db, "researcher", { visibility: "shared" });
    expect((await status({ taskID: task.id }, ctx)).notes).toBe("- Venue A is booked.");
    // A private bot's notes stay with it.
    updatePersona(db, "researcher", { visibility: "private" });
    expect((await status({ taskID: task.id }, ctx)).notes).toBeUndefined();
  });

  test("the pad keeps the newest notes only", () => {
    db = openDatabase(":memory:");
    for (let i = 0; i < MAX_TASK_NOTES + 5; i++) appendTaskNote(db, "tsk_x", "researcher", `n${i}`);
    const notes = listTaskNotes(db, "tsk_x");
    expect(notes).toHaveLength(MAX_TASK_NOTES);
    expect(notes[0]!.text).toBe("n5");
  });

  test("only a delegated turn is offered the scratch tools", async () => {
    db = openDatabase(":memory:");
    const bodies: string[] = [];
    const fetchStub = async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`);
    };
    const router = new Router([{ id: "t", label: "T", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" }], new HealthTracker(), fetchStub as unknown as typeof fetch);
    const persona = resolvePersona(db, "researcher")!;
    const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };
    const base = { text: "go", persona, emit: () => undefined, signal: new AbortController().signal };
    await runTaskTurn(db, router, settings, { ...base, threadID: createThread(db, persona.id).id });
    expect(bodies[0]).not.toContain("scratch_append");
    const task = createDelegationTask(db, { ownerAgentID: "researcher", brief: { goal: "x" } });
    await runTaskTurn(db, router, settings, {
      ...base, threadID: createThread(db, persona.id).id,
      delegation: { taskID: task.id, ownerAgentID: "researcher", parentAgentID: "ea", parentChannelID: null },
    });
    expect(bodies[1]).toContain("scratch_append");
  });
});
