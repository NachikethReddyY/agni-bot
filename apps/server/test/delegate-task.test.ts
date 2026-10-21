import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import { getTask, getTaskByJob, cancelDelegation, setDelegationState } from "../src/stores/tasks";
import { getJob } from "../src/stores/jobs";
import { appendMessage, createThread } from "../src/stores/threads";
import { conversationTranscript, ensureConversation } from "../src/stores/conversations";

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

function sseReply(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("async delegation", () => {
  test("delegate_task queues a task and a job, then the job completes it", async () => {
    db = openDatabase(":memory:");
    const emitted: Array<{ type: string }> = [];
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, {
      db,
      emit: (frame) => emitted.push(frame as { type: string }),
      currentAgentID: "ea",
      channelID: "main",
      parentTurnID: "trn_parent",
    });

    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await delegate.handler({
      toAgentID: "researcher",
      goal: "Find the source of the delay",
      constraints: ["cite sources"],
      outputSchema: "three bullets",
    }, { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal })) as {
      taskID: string; jobID: string; state: string;
    };

    expect(result.state).toBe("queued");
    const task = getTask(db, result.taskID)!;
    expect(task.owner_agent_id).toBe("researcher");
    expect(task.origin).toBe("ea_delegated");
    expect(task.delegate_state).toBe("queued");
    expect(task.parent_turn_id).toBe("trn_parent");
    expect(task.job_id).toBe(result.jobID);
    expect(task.brief).toContain("Find the source of the delay");
    expect(getJob(db, result.jobID)?.kind).toBe("turn");
    expect(getTaskByJob(db, result.jobID)?.id).toBe(task.id);
    expect(emitted.some((frame) => frame.type === "status.update")).toBe(true);

    // Run the queued background job.
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = new Router([provider], new HealthTracker(), (async () => sseReply("Research complete.")) as unknown as typeof fetch);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();

    const done = getTask(db, result.taskID)!;
    expect(done.delegate_state).toBe("done");
    expect(done.result).toBe("Research complete.");
  });

  test("the child gets only the brief, never the delegating transcript", async () => {    db = openDatabase(":memory:");
    const parent = createThread(db, "ea");
    appendMessage(db, { threadID: parent.id, role: "user", text: "SECRET-EA-CONTEXT" });
    ensureConversation(db, "ea");

    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await delegate.handler({
      toAgentID: "researcher", goal: "Summarize the findings",
    }, { threadID: parent.id, turnID: "trn_parent", signal: new AbortController().signal })) as { taskID: string };

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = new Router([provider], new HealthTracker(), (async () => sseReply("Findings summarized.")) as unknown as typeof fetch);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();

    const researcher = ensureConversation(db, "researcher");
    const transcript = conversationTranscript(db, researcher.id);
    expect(transcript.some((message) => message.text.includes("Findings summarized."))).toBe(true);
    expect(transcript.some((message) => message.text.includes("SECRET-EA-CONTEXT"))).toBe(false);
    expect(getTask(db, result.taskID)?.delegate_state).toBe("done");
  });

  test("a duplicate goal returns the in-flight task instead of queueing twice", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const ctx = { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal };
    const first = (await delegate.handler({ toAgentID: "researcher", goal: "Same job" }, ctx)) as { taskID: string; jobID: string };
    const second = (await delegate.handler({ toAgentID: "researcher", goal: "Same job" }, ctx)) as { taskID: string; duplicate?: boolean };
    expect(second.taskID).toBe(first.taskID);
    expect(second.duplicate).toBe(true);
    const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get();
    expect(count?.count).toBe(1);
  });

  test("cancel closes the task and removes the queued job", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await delegate.handler(
      { toAgentID: "researcher", goal: "Cancel me" },
      { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal },
    )) as { taskID: string; jobID: string };

    const cancelled = cancelDelegation(db, result.taskID)!;
    expect(cancelled.delegate_state).toBe("failed");
    expect(cancelled.result).toBe("cancelled by user");
    expect(getJob(db, result.jobID)).toBeNull();
  });

  test("a cancelled task does not run even if its job was already claimed", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await delegate.handler(
      { toAgentID: "researcher", goal: "Should not run" },
      { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal },
    )) as { taskID: string };
    // Mark cancelled before the runner sees it.
    cancelDelegation(db, result.taskID);

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = new Router([provider], new HealthTracker(), (async () => sseReply("should never be called")) as unknown as typeof fetch);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    // The job was deleted with the cancellation, so the tick has nothing to run.
    await runner.tick();
    expect(getTask(db, result.taskID)?.delegate_state).toBe("failed");
    expect(getTask(db, result.taskID)?.result).toBe("cancelled by user");
  });

  test("task_status reports the state and result without waiting", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as ToolHandler;
    const ctx = { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal };
    const queued = (await delegate.handler({ toAgentID: "researcher", goal: "Status me" }, ctx)) as { taskID: string };
    const status = registry.get("task_status") as unknown as ToolHandler;
    const before = (await status.handler({ taskID: queued.taskID }, ctx)) as { state: string; terminal: boolean };
    expect(before.state).toBe("queued");
    expect(before.terminal).toBe(false);

    setDelegationState(db, queued.taskID, "done", "All finished.");
    const after = (await status.handler({ taskID: queued.taskID }, ctx)) as { state: string; result: string; terminal: boolean };
    expect(after.state).toBe("done");
    expect(after.result).toBe("All finished.");
    expect(after.terminal).toBe(true);
  });

  test("delegate_wait returns as soon as the task finishes", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as ToolHandler;
    const ctx = { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal };
    const queued = (await delegate.handler({ toAgentID: "researcher", goal: "Wait for me" }, ctx)) as { taskID: string };
    setTimeout(() => setDelegationState(db!, queued.taskID, "done", "Here it is."), 50);

    const wait = registry.get("delegate_wait") as unknown as ToolHandler;
    const result = (await wait.handler({ taskID: queued.taskID, timeoutMs: 2_000 }, ctx)) as {
      state: string; result: string; waitTimedOut: boolean;
    };
    expect(result.state).toBe("done");
    expect(result.result).toBe("Here it is.");
    expect(result.waitTimedOut).toBe(false);
  });

  test("delegate_wait times out without cancelling the specialist", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as ToolHandler;
    const ctx = { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal };
    const queued = (await delegate.handler({ toAgentID: "researcher", goal: "Keep working" }, ctx)) as { taskID: string };

    const wait = registry.get("delegate_wait") as unknown as ToolHandler;
    const result = (await wait.handler({ taskID: queued.taskID, timeoutMs: 1_000 }, ctx)) as {
      state: string; waitTimedOut: boolean;
    };
    expect(result.waitTimedOut).toBe(true);
    expect(result.state).toBe("queued");
    expect(getTask(db, queued.taskID)?.delegate_state).toBe("queued");
  });

  test("task_cancel closes a delegated task", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, { db, emit: () => undefined, currentAgentID: "ea" });
    const delegate = registry.get("delegate_task") as unknown as ToolHandler;
    const ctx = { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal };
    const queued = (await delegate.handler({ toAgentID: "researcher", goal: "Stop me" }, ctx)) as { taskID: string; jobID: string };

    const cancel = registry.get("task_cancel") as unknown as ToolHandler;
    const result = (await cancel.handler({ taskID: queued.taskID }, ctx)) as { state: string; cancelled: boolean };
    expect(result.cancelled).toBe(true);
    expect(result.state).toBe("failed");
    expect(getJob(db, queued.jobID)).toBeNull();
  });
});

type ToolHandler = {
  handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
};
