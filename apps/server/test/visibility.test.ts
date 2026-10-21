import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { scanForCanaries } from "../src/db/canary";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerHandoffTool } from "../src/tools/handoff-tool";
import { registerDelegateTaskTool } from "../src/tools/delegate-task-tool";
import { defaultResolvedPersona, personaInfo } from "../src/agent/personas";
import { redactForCaller, summarizeText } from "../src/agent/visibility";
import { putAgentMemory, listAgentMemories } from "../src/stores/agent-memories";
import { recallFact } from "../src/tools/facts";
import { createThread } from "../src/stores/threads";
import { ensureConversation, conversationTranscript } from "../src/stores/conversations";
import { getTask } from "../src/stores/tasks";

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

const CANARY = "CANARY-PRIVATE-ANSWER-8f2c";

describe("the redaction choke point", () => {
  test("private gives a receipt, summary gives a line, shared gives the text", () => {
    const text = "The full answer with everything in it.";

    const priv = redactForCaller(text, "vault", "ea", "private");
    expect(priv.text).toBeNull();
    expect(priv.redacted).toBe(true);

    const sum = redactForCaller(text, "vault", "ea", "summary");
    expect(sum.redacted).toBe(false);
    expect(sum.text).toBe(text);
    expect(sum.text!.length).toBeLessThanOrEqual(240);

    const shared = redactForCaller(text, "vault", "ea", "shared");
    expect(shared.text).toBe(text);
    expect(shared.redacted).toBe(false);
  });

  test("the owner always sees the whole thing", () => {
    const own = redactForCaller("anything", "vault", "vault", "private");
    expect(own.text).toBe("anything");
    expect(own.redacted).toBe(false);
    const noCaller = redactForCaller("anything", "vault", null, "private");
    expect(noCaller.text).toBe("anything");
  });

  test("a summary is one bounded line", () => {
    const long = `${"word ".repeat(200)}tail-marker`;
    const summary = summarizeText(long);
    expect(summary!.length).toBeLessThanOrEqual(240);
    expect(summary).not.toContain("tail-marker");
  });
});

describe("EVAL-004 — a private agent's text stays private", () => {
  test("the delegating agent gets a receipt, not the answer", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    const parent = createThread(db, defaultResolvedPersona(db!).id);
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db,
      router: makeRouter([CANARY]),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined,
      signal: new AbortController().signal,
      threadID: parent.id,
      channelID: "main",
      currentAgentID: "ea",
      guardrail: (await import("../src/agent/guardrails")).rootGuardrail("ea"),
    });
    const tool = registry.get("handoff") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await tool.handler(
      { toAgentID: "researcher", task: "Find it" },
      { threadID: parent.id, turnID: "trn_1", signal: new AbortController().signal },
    )) as { text: string | null; redacted: boolean; visibility: string };

    expect(result.text).toBeNull();
    expect(result.redacted).toBe(true);
    expect(result.visibility).toBe("private");
  });

  test("the answer stays in the private agent's own DM and conversation", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    const parent = createThread(db, defaultResolvedPersona(db!).id);
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db,
      router: makeRouter([CANARY]),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined,
      signal: new AbortController().signal,
      threadID: parent.id,
      channelID: "main",
      currentAgentID: "ea",
      guardrail: (await import("../src/agent/guardrails")).rootGuardrail("ea"),
    });
    const tool = registry.get("handoff") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    await tool.handler(
      { toAgentID: "researcher", task: "Find it" },
      { threadID: parent.id, turnID: "trn_1", signal: new AbortController().signal },
    );

    // The owner opens the agent's DM and reads the work: that is the point.
    const dm = db
      .query<{ text: string }, []>("SELECT text FROM channel_messages WHERE channel_id = 'dm:researcher'")
      .all();
    expect(dm.some((row) => row.text.includes(CANARY))).toBe(true);
    const conversation = ensureConversation(db, "researcher");
    expect(conversationTranscript(db, conversation.id).some((message) => message.text.includes(CANARY))).toBe(true);

    // And nowhere else: not the user's channel, not the caller's transcript,
    // not a fact, not a summary, not the log.
    const main = db
      .query<{ text: string }, []>("SELECT text FROM channel_messages WHERE channel_id = 'main'")
      .all();
    expect(main.some((row) => row.text.includes(CANARY))).toBe(false);

    const hits = scanForCanaries(db, [CANARY], { exemptAgentIDs: ["researcher"] });
    expect(hits).toEqual([]);
  });

  test("an async delegation to a private agent reports no result", async () => {
    db = openDatabase(":memory:");
    db.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    const registry = new ToolRegistry();
    registerDelegateTaskTool(registry, {
      db,
      emit: () => undefined,
      currentAgentID: "ea",
      channelID: "main",
    });
    const delegate = registry.get("delegate_task") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const queued = (await delegate.handler(
      { toAgentID: "researcher", goal: "Find the delay" },
      { threadID: "thr_1", turnID: "trn_1", signal: new AbortController().signal },
    )) as { taskID: string };
    const task = getTask(db, queued.taskID)!;
    // Pretend the child finished with a private answer.
    db.run("UPDATE tasks SET delegate_state = 'done', result = ? WHERE id = ?", [CANARY, task.id]);

    const status = registry.get("task_status") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const view = (await status.handler(
      { taskID: task.id },
      { threadID: "thr_1", turnID: "trn_1", signal: new AbortController().signal },
    )) as { result: string | null; resultRedacted: boolean; visibility: string };

    expect(view.result).toBeNull();
    expect(view.resultRedacted).toBe(true);
    expect(view.visibility).toBe("private");
  });
});

describe("one caller-filter for scope and visibility", () => {
  test("scope=agent memory is unreadable by another agent", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "agent",
      agentID: "researcher",
      keySlug: "private-note",
      content: "CANARY-SCOPE-AGENT",
    });

    const otherAgent = listAgentMemories(db, { scope: "agent", agentID: "researcher", callerAgentID: "ea" });
    expect(otherAgent).toEqual([]);

    const owner = listAgentMemories(db, { scope: "agent", agentID: "researcher", callerAgentID: "researcher" });
    expect(owner).toHaveLength(1);

    const recalled = recallFact(db, { scope: "agent", agentID: "researcher", callerAgentID: "ea" });
    expect(recalled.facts).toEqual([]);
  });

  test("a private fact is readable by its owner and by nobody else", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, {
      scope: "global_user",
      agentID: "ea",
      keySlug: "private-fact",
      content: "CANARY-PRIVATE-FACT",
      visibility: "private",
    });

    const owner = recallFact(db, { scope: "global_user", callerAgentID: "ea" });
    expect(owner.facts.map((fact) => fact.fact)).toContain("CANARY-PRIVATE-FACT");

    const other = recallFact(db, { scope: "global_user", callerAgentID: "researcher" });
    expect(other.facts.map((fact) => fact.fact)).not.toContain("CANARY-PRIVATE-FACT");
  });

  test("a global fact stays global", () => {
    db = openDatabase(":memory:");
    putAgentMemory(db, { scope: "global_user", keySlug: "shared-fact", content: "the owner prefers dark mode" });
    const other = recallFact(db, { scope: "global_user", callerAgentID: "researcher" });
    expect(other.facts.map((fact) => fact.fact)).toContain("the owner prefers dark mode");
  });
});

describe("the roster reports visibility", () => {
  test("every agent carries a visibility", () => {
    db = openDatabase(":memory:");
    const agents = personaInfo(db, { includeHidden: true });
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(["private", "summary", "shared"]).toContain(agent.visibility ?? "summary");
    }
  });
});
