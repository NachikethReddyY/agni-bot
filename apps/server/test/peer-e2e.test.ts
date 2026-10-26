import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { rootGuardrail } from "../src/agent/guardrails";
import { defaultResolvedPersona } from "../src/agent/personas";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerHandoffTool } from "../src/tools/handoff-tool";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { createThread, recentMessages } from "../src/stores/threads";
import { listJobs, parseJobPayload } from "../src/stores/jobs";
import { putAgentMemory } from "../src/stores/agent-memories";

const provider: ProviderConfig = { id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };
const settings = { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 };

function sseReply(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { status: 200 });
}

function makeRouter(responses: string[], requests: Array<{ messages: Array<{ role: string; content: string }> }> = []): Router {
  let index = 0;
  const fetchStub = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (init?.body) requests.push(JSON.parse(String(init.body)) as typeof requests[number]);
    return sseReply(responses[Math.min(index++, responses.length - 1)] ?? responses[0] ?? "");
  };
  return new Router([provider], new HealthTracker(), fetchStub as unknown as typeof fetch);
}

type Tool = { handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown> };
const ctx = (threadID: string, turnID = "trn_parent") => ({ threadID, turnID, signal: new AbortController().signal });
const jobPayloads = (db: Database) => listJobs(db, { includeFinished: true }).filter((job) => job.kind === "turn")
  .map((job) => ({ job, payload: parseJobPayload<Record<string, unknown>>(job) }));

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("peer handoff end-to-end", () => {
  test("peer input never pulls stored text into the system prefix", async () => {
    db = openDatabase(":memory:");
    // Durable facts always ride in the prefix, so the stored note appears once
    // there. A peer brief must not also pull it in again as recall.
    putAgentMemory(db, { scope: "global_user", keySlug: "e2e-recall", content: "Stored note: E2E-RECALL-BRIEF is the Q3 budget brief for Priya.", kind: "note" });
    const parent = createThread(db, defaultResolvedPersona(db).id);
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const registry = new ToolRegistry();
    registerHandoffTool(registry, { db, router: makeRouter(["Done."], requests), settings, emit: () => undefined, signal: new AbortController().signal, threadID: parent.id, channelID: "main", currentAgentID: "ea", guardrail: rootGuardrail("ea") });
    const tool = registry.get("handoff") as unknown as Tool;
    await tool.handler({ toAgentID: "researcher", task: "Summarise the E2E-RECALL-BRIEF budget for Priya, the Q3 numbers please" }, ctx(parent.id));
    const system = requests.flatMap((request) => request.messages).filter((message) => message.role === "system");
    const copies = system.reduce((count, message) => count + message.content.split("Stored note: E2E-RECALL-BRIEF").length - 1, 0);
    expect(copies).toBe(1);
  });

  test("sync round trip wraps the brief, returns attributed answer, and logs both sides", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, defaultResolvedPersona(db).id);
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const emitted: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registerHandoffTool(registry, { db, router: makeRouter(["Researcher answer."], requests), settings, emit: (f) => emitted.push(f as unknown as Record<string, unknown>), signal: new AbortController().signal, threadID: parent.id, channelID: "main", currentAgentID: "ea", guardrail: rootGuardrail("ea") });
    const tool = registry.get("handoff") as unknown as Tool;
    const result = await tool.handler({ toAgentID: "researcher", task: "E2E-SYNC-BRIEF" }, ctx(parent.id)) as Record<string, unknown>;
    const all = requests.flatMap((request) => request.messages);
    expect(all.some((m) => m.role === "user" && m.content.includes('<peer_message from="Agni Bot" intent="request">') && m.content.includes("E2E-SYNC-BRIEF"))).toBe(true);
    expect(result).toMatchObject({ text: "Researcher answer.", agentID: "researcher", agentName: expect.any(String) });
    expect(emitted.some((frame) => frame.uiHint === "handoff_notice" && frame.channelId === "main")).toBe(true);
    const dm = db.query<{ text: string }, []>("SELECT text FROM channel_messages WHERE channel_id = 'dm:researcher'").all();
    expect(dm.some((row) => row.text === "Researcher answer.")).toBe(true);
    expect(all.filter((m) => m.role === "system").every((m) => !m.content.includes("E2E-SYNC-BRIEF"))).toBe(true);
  });

  test("async result is enveloped in wake text, stored plainly, then sent as user input", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const chain = rootGuardrail("ea").chainID;
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", channelID: "main", parentThreadID: parent.id, parentTurnID: "trn_parent", chainID: chain });
    const delegate = registry.get("delegate_task") as unknown as Tool;
    await delegate.handler({ toAgentID: "researcher", goal: "E2E-ASYNC-GOAL" }, ctx(parent.id));
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 1 });
    registerTurnJob(runner, { db, router: makeRouter(["E2E-ASYNC-SUMMARY", "Parent resumed."], requests), settings, emit: () => undefined });
    await runner.tick();
    const wake = jobPayloads(db).find(({ payload }) => typeof payload.wakeKey === "string");
    expect(wake).toBeTruthy();
    const result = (wake!.payload.results as Array<{ taskID: string; agentID: string; summary: string }>)[0]!;
    expect(result.summary).toContain("E2E-ASYNC-SUMMARY");
    await runner.tick();
    const wakeMessage = requests.flatMap((request) => request.messages).find((m) => m.role === "user" && m.content.includes("<peer_message from=\"researcher\" intent=\"result\""));
    expect(wakeMessage).toBeTruthy();
    expect(wakeMessage!.content).toContain(`<peer_message from="researcher" intent="result" task="${result.taskID}">`);
    expect(wakeMessage!.content.indexOf("finished") < wakeMessage!.content.indexOf("<peer_message")).toBe(true);
    const logText = recentMessages(db, parent.id, 20).map((m) => m.text).join("\n");
    expect(logText).toContain("E2E-ASYNC-SUMMARY");
    expect(logText).not.toContain("<peer_message");
  });

  test("private researcher text is redacted from sync result and async wake", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    const parent = createThread(db, "ea");
    const registry = new ToolRegistry();
    registerHandoffTool(registry, { db, router: makeRouter(["PRIVATE-CANARY"]), settings, emit: () => undefined, signal: new AbortController().signal, threadID: parent.id, currentAgentID: "ea", guardrail: rootGuardrail("ea") });
    const sync = await (registry.get("handoff") as unknown as Tool).handler({ toAgentID: "researcher", task: "Private sync" }, ctx(parent.id)) as Record<string, unknown>;
    expect(sync.text).toBeNull();
    expect(sync.redacted).toBe(true);

    const queue = new ToolRegistry();
    registerDelegateTaskTool(queue, { db, emit: () => undefined, currentAgentID: "ea", parentThreadID: parent.id, chainID: rootGuardrail("ea").chainID });
    await (queue.get("delegate_task") as unknown as Tool).handler({ toAgentID: "researcher", goal: "Private async" }, ctx(parent.id));
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: makeRouter(["PRIVATE-CANARY"]), settings, emit: () => undefined });
    await runner.tick();
    const wake = jobPayloads(db).find(({ payload }) => typeof payload.wakeKey === "string")!;
    const item = (wake.payload.results as Array<{ summary: string; redacted: boolean }>)[0]!;
    expect(item).toMatchObject({ summary: "", redacted: true });
    expect((wake.payload.text as string | undefined) ?? "").not.toContain("PRIVATE-CANARY");
  });

  test("sync retries once, then stops with an owner-visible notice", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const emitted: Array<Record<string, unknown>> = [];
    const router = makeRouter(["Answer."], requests);
    const invoke = async () => {
      const registry = new ToolRegistry();
      registerHandoffTool(registry, { db: db!, router, settings, emit: (f) => emitted.push(f as unknown as Record<string, unknown>), signal: new AbortController().signal, threadID: parent.id, channelID: "main", currentAgentID: "ea", guardrail: rootGuardrail("ea", "sync-chain") });
      return (registry.get("handoff") as unknown as Tool).handler({ toAgentID: "researcher", task: "same sync" }, ctx(parent.id));
    };
    expect(await invoke()).toMatchObject({ text: "Answer." });
    expect(await invoke()).toMatchObject({ repeated: true });
    expect(requests).toHaveLength(1);
    expect(await invoke()).toMatchObject({ stopped: true });
    expect(emitted.some((f) => f.fromType === "system" && String(f.text).includes("Stopped"))).toBe(true);
  });

  test("async retries enqueue no second job and a third request stops in main", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const emitted: Array<Record<string, unknown>> = [];
    const invoke = async (goal: string) => {
      const registry = new ToolRegistry();
      registerDelegateTaskTool(registry, { db: db!, emit: (f) => emitted.push(f as unknown as Record<string, unknown>), currentAgentID: "ea", parentThreadID: parent.id, chainID: "async-chain" });
      return (registry.get("delegate_task") as unknown as Tool).handler({ toAgentID: "researcher", goal }, ctx(parent.id));
    };
    expect(await invoke("same async")).toMatchObject({ state: "queued" });
    const retry = await invoke("same async");
    const stopped = await invoke("same async");
    const queuedTurns = jobPayloads(db).filter(({ payload }) => payload.delegationTaskID).length;
    const ownerNotice = db.query<{ text: string; channel_id: string }, []>("SELECT text, channel_id FROM channel_messages").all().some((row) => row.channel_id === "main" && row.text.includes("Stopped"));
    expect({ retry, stopped, queuedTurns, ownerNotice }).toMatchObject({ retry: { repeated: true }, stopped: { stopped: true }, queuedTurns: 1, ownerNotice: true });
  });

  test("15 distinct sync requests in one chain all run", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const router = makeRouter(Array.from({ length: 15 }, (_, i) => `answer ${i}`), requests);
    for (let i = 0; i < 15; i++) {
      const registry = new ToolRegistry();
      registerHandoffTool(registry, { db, router, settings, emit: () => undefined, signal: new AbortController().signal, threadID: parent.id, currentAgentID: "ea", guardrail: rootGuardrail("ea", "many-chain") });
      const result = await (registry.get("handoff") as unknown as Tool).handler({ toAgentID: "researcher", task: `unique sync ${i}` }, ctx(parent.id)) as Record<string, unknown>;
      expect(result.repeated).toBeUndefined();
      expect(result.stopped).toBeUndefined();
    }
    expect(requests).toHaveLength(15);
  });

  test("async task and completion wake preserve the parent's chain id", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    const chainID = rootGuardrail("ea").chainID;
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea", parentThreadID: parent.id, parentTurnID: "trn_parent", chainID });
    await (registry.get("delegate_task") as unknown as Tool).handler({ toAgentID: "researcher", goal: "Continuity" }, ctx(parent.id));
    const delegated = jobPayloads(db).find(({ payload }) => payload.delegationTaskID)!;
    expect(delegated.payload.chainID).toBe(chainID);
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    registerTurnJob(runner, { db, router: makeRouter(["Done"]), settings, emit: () => undefined });
    await runner.tick();
    const wake = jobPayloads(db).find(({ payload }) => typeof payload.wakeKey === "string")!;
    expect(wake.payload.chainID).toBe(chainID);
  });
});
