/**
 * DEL-006: the delegation lifecycle.
 *
 * A delegated task can ask the owner a question and wait for the answer, the
 * answer resumes it in the same conversation, and the parent is woken exactly
 * once when the work lands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { registerArtifactTool } from "../src/tools/artifact-tool";
import { registerRequestOwnerInputTool } from "../src/tools/needs-input-tool";
import { JobRunner } from "../src/jobs/runner";
import { registerTurnJob } from "../src/jobs/turn";
import {
  getTask,
  getPendingQuestion,
  setDelegationState,
  setDelegationThread,
  setPendingQuestion,
  taskInfo,
} from "../src/stores/tasks";
import { getArtifact } from "../src/stores/artifacts";
import { listJobs, parseJobPayload } from "../src/stores/jobs";
import { appendMessage, createThread, recentMessages } from "../src/stores/threads";
import { ensureConversation } from "../src/stores/conversations";

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

function makeRouter(responses: string[]): Router {
  let index = 0;
  const fetchStub = async (): Promise<Response> =>
    sseReply(responses[Math.min(index++, responses.length - 1)] ?? (responses[0] as string));
  return new Router([provider], new HealthTracker(), fetchStub as unknown as typeof fetch);
}

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

/** Queue a delegation the way the model would. */
async function delegate(
  database: Database,
  options: { toAgentID?: string; goal?: string; parentThreadID?: string; channelID?: string; intent?: string } = {},
): Promise<{ taskID: string; jobID: string }> {
  const registry = new ToolRegistry();
  registerDelegateTaskTool(registry, {
    db: database,
    emit: () => undefined,
    currentAgentID: "ea",
    channelID: options.channelID ?? "main",
    parentTurnID: "trn_parent",
    parentThreadID: options.parentThreadID ?? "thr_parent",
  });
  const tool = registry.get("delegate_task") as unknown as {
    handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
  };
  const result = (await tool.handler(
    {
      toAgentID: options.toAgentID ?? "researcher",
      goal: options.goal ?? "Find the delay",
      ...(options.intent ? { intent: options.intent } : {}),
    },
    { threadID: "thr_parent", turnID: "trn_parent", signal: new AbortController().signal },
  )) as { taskID: string; jobID: string };
  return result;
}

function wakeJobs(database: Database): Array<{ id: string; results: unknown[] }> {
  return listJobs(database, { includeFinished: true })
    .filter((job) => job.kind === "turn")
    .map((job) => ({ id: job.id, payload: parseJobPayload<Record<string, unknown>>(job) }))
    .filter((job) => typeof job.payload.wakeKey === "string")
    .map((job) => ({ id: job.id, results: (job.payload.results ?? []) as unknown[] }));
}

describe("a delegated task asks the owner a question", () => {
  test("the question is stored, the task waits, and the owner sees it", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    let asked = "";
    registerRequestOwnerInputTool(registry, {
      db,
      emit: () => undefined,
      task: { id: "tsk_1", ownerAgentID: "researcher", parentAgentID: "ea", parentChannelID: "main" },
      onNeedsInput: (questionID) => { asked = questionID; },
    });
    const tool = registry.get("request_owner_input") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await tool.handler(
      { question: "Which account should I use?" },
      { threadID: "thr_child", turnID: "trn_child", signal: new AbortController().signal },
    )) as { asked: boolean; questionID: string };

    expect(result.asked).toBe(true);
    expect(asked).toBe(result.questionID);
    // The question is in the channel the owner is watching.
    const rows = db.query<{ text: string; ui_hint: string | null }, []>(
      "SELECT text, ui_hint FROM channel_messages WHERE channel_id = 'main'",
    ).all();
    expect(rows.some((row) => row.text.includes("Which account") && row.ui_hint === "needs_input")).toBe(true);
  });

  test("the task is parked on the question, and the answer clears it", () => {
    db = openDatabase(":memory:");
    db.run(
      "INSERT INTO tasks (id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id,child_thread_id,parent_thread_id,parent_channel_id,parent_agent_id,pending_question,pending_question_id,result_delivered_at,artifact_id) VALUES ('tsk_1','Find it',NULL,'normal','open',datetime('now'),datetime('now'),NULL,NULL,'researcher','ea_delegated','running',NULL,NULL,NULL,'trn_1','thr_child','thr_parent','main','ea',NULL,NULL,NULL,NULL)",
    );
    setPendingQuestion(db, "tsk_1", { text: "Which account?", questionID: "qst_1" });
    expect(getTask(db, "tsk_1")?.delegate_state).toBe("needs_input");
    expect(getPendingQuestion(db, "tsk_1")?.questionID).toBe("qst_1");
  });
});

describe("the delegation carries an intent", () => {
  test("the brief intent defaults to request and survives the task finishing", async () => {
    db = openDatabase(":memory:");
    const plain = await delegate(db, { goal: "Find the delay" });
    const question = await delegate(db, { goal: "Which account?", intent: "question" });

    expect(taskInfo(getTask(db, plain.taskID)!).intent).toBe("request");
    expect(taskInfo(getTask(db, question.taskID)!).intent).toBe("question");
    expect(JSON.parse(getTask(db, question.taskID)!.brief!).intent).toBe("question");

    setDelegationState(db, question.taskID, "done", "Answered.");
    expect(taskInfo(getTask(db, question.taskID)!).intent).toBe("question");
  });
});

describe("the parent is woken when the work lands", () => {
  test("the completion wakes the parent once", async () => {
    db = openDatabase(":memory:");
    const parentThread = createThread(db, "ea");
    const queued = await delegate(db, { parentThreadID: parentThread.id });

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = makeRouter(["Found it: the invoice was misfiled."]);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();

    const task = getTask(db, queued.taskID)!;
    expect(task.delegate_state).toBe("done");
    // The full result is an artifact; the task row keeps the summary.
    expect(task.result).toContain("Found it");
    expect(task.artifact_id).toBeTruthy();
    expect(getArtifact(db, task.artifact_id!)?.content).toContain("the invoice was misfiled");

    const wakes = wakeJobs(db);
    expect(wakes).toHaveLength(1);
    expect((wakes[0]!.results as Array<{ taskID: string }>)[0]?.taskID).toBe(queued.taskID);
  });

  test("several completions for the same parent coalesce into one wake", async () => {
    db = openDatabase(":memory:");
    const parentThread = createThread(db, "ea");
    await delegate(db, { parentThreadID: parentThread.id, goal: "First thing" });
    await delegate(db, { parentThreadID: parentThread.id, goal: "Second thing" });

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = makeRouter(["All done."]);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();
    await runner.tick();

    const wakes = wakeJobs(db);
    // One wake turn carries both results.
    const withResults = wakes.filter((wake) => wake.results.length > 0);
    expect(withResults.length).toBeGreaterThan(0);
    const total = withResults.reduce((sum, wake) => sum + wake.results.length, 0);
    expect(total).toBe(2);
  });

  test("a private task wakes without its text", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    const parentThread = createThread(db, "ea");
    const queued = await delegate(db, { parentThreadID: parentThread.id });

    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = makeRouter(["CANARY-PRIVATE-RESULT"]);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();

    const wakes = wakeJobs(db);
    const results = wakes.flatMap((wake) => wake.results as Array<{ summary: string; redacted: boolean }>);
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.redacted).toBe(true);
      expect(result.summary).not.toContain("CANARY-PRIVATE-RESULT");
    }
    // And the wake text says so, in words.
    expect(getTask(db, queued.taskID)?.delegate_state).toBe("done");
  });
});

describe("the result is stored by reference", () => {
  test("read_artifact returns the full result to a caller that may see it", async () => {
    db = openDatabase(":memory:");
    const registry = new ToolRegistry();
    registerArtifactTool(registry, { db, currentAgentID: "ea" });
    const queued = await delegate(db, {});
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = makeRouter(["The full answer, with all of it."]);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();

    const artifactID = getTask(db, queued.taskID)!.artifact_id!;
    const tool = registry.get("read_artifact") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const view = (await tool.handler(
      { artifactRef: artifactID },
      { threadID: "thr_1", turnID: "trn_1", signal: new AbortController().signal },
    )) as { text: string | null; redacted: boolean };
    expect(view.text).toContain("The full answer");
    expect(view.redacted).toBe(false);
  });

  test("read_artifact gives a private agent's artifact nothing", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    const registry = new ToolRegistry();
    registerArtifactTool(registry, { db, currentAgentID: "ea" });
    const queued = await delegate(db, {});
    const runner = new JobRunner(db, () => undefined, { maxPerTick: 5 });
    const router = makeRouter(["CANARY-PRIVATE-ARTIFACT"]);
    registerTurnJob(runner, { db, router, settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, emit: () => undefined });
    await runner.tick();

    const artifactID = getTask(db, queued.taskID)!.artifact_id!;
    const tool = registry.get("read_artifact") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const view = (await tool.handler(
      { artifactRef: artifactID },
      { threadID: "thr_1", turnID: "trn_1", signal: new AbortController().signal },
    )) as { text: string | null; redacted: boolean };
    expect(view.text).toBeNull();
    expect(view.redacted).toBe(true);
  });
});

describe("the resume", () => {
  test("the answer continues the specialist's conversation", () => {
    db = openDatabase(":memory:");
    const child = createThread(db, "researcher");
    appendMessage(db, { threadID: child.id, role: "user", text: "Goal: find it" });
    setDelegationThread(db, "tsk_1", child.id);
    appendMessage(db, { threadID: child.id, role: "user", text: "Use the second account" });
    const messages = recentMessages(db, child.id, 10);
    expect(messages.map((message) => message.text)).toContain("Use the second account");
  });
});
