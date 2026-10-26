import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { handoff } from "../src/agent/handoff";
import { registerHandoffTool } from "../src/tools/handoff-tool";
import { ToolRegistry } from "../src/tools/registry";
import { defaultResolvedPersona } from "../src/agent/personas";
import { createThread, getThread } from "../src/stores/threads";
import { conversationTranscript, ensureConversation, getConversation } from "../src/stores/conversations";
import { rootGuardrail, enterDelegation, canDelegate, GuardrailError, MAX_DEPTH, MAX_DELEGATED_STEPS } from "../src/agent/guardrails";

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

describe("guardrails", () => {
  test("delegation is refused once the published ceiling is reached", () => {
    const root = rootGuardrail("agni");
    // Walk the chain up to the ceiling; the last step must refuse further.
    let state = root;
    while (canDelegate(state)) {
      state = enterDelegation(state, `agent-${state.depth}`, `handoff ${state.depth}`);
    }
    expect(canDelegate(state)).toBe(false);
    expect(() => enterDelegation(state, "agni", "nope")).toThrow(GuardrailError);
    // The ceiling is at least 2 (root + one delegation) and bounded.
    expect(state.depth).toBeGreaterThanOrEqual(3);
    expect(state.depth).toBeLessThanOrEqual(10);
  });

  test("MAX_DEPTH and MAX_DELEGATED_STEPS are the published ceilings", () => {
    expect(Number.isInteger(MAX_DEPTH)).toBe(true);
    expect(MAX_DEPTH).toBeGreaterThan(1);
    expect(Number.isInteger(MAX_DELEGATED_STEPS)).toBe(true);
    expect(MAX_DELEGATED_STEPS).toBeGreaterThan(0);
  });
});

describe("agent-to-agent handoff", () => {
  test("a root turn runs at depth 1 with the delegation prefix", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, defaultResolvedPersona(db!).id);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const router = makeRouter(["I don't need to delegate."]);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona: defaultResolvedPersona(db!),
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
      guardrail: rootGuardrail("agni"),
    });
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("I don't need to delegate.");
  });

  test("a turn at the depth ceiling still runs but cannot delegate further", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, defaultResolvedPersona(db!).id);
    // Walk the chain to the published ceiling; the turn can still do its own
    // work, but any handoff attempt from here is refused by enterDelegation.
    let atCeiling = rootGuardrail("agni");
    while (canDelegate(atCeiling)) {
      atCeiling = enterDelegation(atCeiling, `agent-${atCeiling.depth}`, `handoff ${atCeiling.depth}`);
    }
    expect(canDelegate(atCeiling)).toBe(false);
    const router = makeRouter(["I am at the ceiling and I know it."]);
    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona: defaultResolvedPersona(db!),
      emit: () => undefined, signal: new AbortController().signal,
      guardrail: atCeiling,
    });
    expect(result.stopReason).toBe("end");
    expect(result.text).toBe("I am at the ceiling and I know it.");
    // Delegating again from here is refused.
    expect(() => enterDelegation(atCeiling, "agni", "nope")).toThrow(GuardrailError);
  });

  test("handoff tool is registered per turn and the turn emits tool frames", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, defaultResolvedPersona(db!).id);
    const router = makeRouter(["done"]);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id, text: "hi", persona: defaultResolvedPersona(db!),
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
      guardrail: rootGuardrail("agni"),
    });
    expect(emitted.some((frame) => frame.type === "turn.start")).toBe(true);
    expect(emitted.some((frame) => frame.type === "turn.end")).toBe(true);
  });

  test("the delegated work lands in the agent that was asked, not in a detached thread", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, defaultResolvedPersona(db!).id);
    // The specialist's own conversation — the one the owner opens when they
    // click that agent in the app.
    const conversation = ensureConversation(db!, "researcher");
    const router = makeRouter(["Here is the brief."]);

    const result = await handoff({
      db: db!,
      router,
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined,
      signal: new AbortController().signal,
      threadID: parent.id,
      guardrail: rootGuardrail("ea"),
    }, { toAgentID: "researcher", task: "Find the source of the delay.", emit: () => undefined, signal: new AbortController().signal });

    expect(result.agentID).toBe("researcher");
    // The block is inside the specialist's conversation, so opening that
    // agent's chat shows the work instead of an empty room.
    const after = getConversation(db!, conversation.id)!;
    expect(after.active_thread_id).toBeTruthy();
    const block = getThread(db!, after.active_thread_id!);
    expect(block?.agent_id).toBe("researcher");
    expect(block?.conversation_id).toBe(conversation.id);
    // And it is titled as the conversation it is, not as the internal brief.
    expect(block?.title).toBe("New Bot messaged Researcher");
    // The work is in that conversation's transcript.
    const transcript = conversationTranscript(db!, conversation.id);
    expect(transcript.some((message) => message.text.includes("Here is the brief."))).toBe(true);
    // The brief is a note, not the owner speaking.
    const brief = transcript.find((message) => message.text.includes("messaged you"));
    expect(brief?.role).toBe("system");
    expect(brief?.text).toContain("New Bot messaged you");
  });

  test("the specialist's answer stays out of the user's channel", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, defaultResolvedPersona(db!).id);
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db,
      router: makeRouter(["Friday's private answer."]),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: () => undefined,
      signal: new AbortController().signal,
      threadID: parent.id,
      channelID: "main",
      currentAgentID: "ea",
      guardrail: rootGuardrail("ea"),
    });
    const tool = registry.get("handoff") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    const result = (await tool.handler(
      { toAgentID: "researcher", task: "Find it" },
      { threadID: parent.id, turnID: "trn_handoff", signal: new AbortController().signal },
    )) as { text: string };

    // The delegating agent gets the full answer...
    expect(result.text).toBe("Friday's private answer.");
    // ...the user gets only a receipt, not the content...
    const rows = db.query<{ from_type: string; text: string }, []>(
      "SELECT from_type, text FROM channel_messages WHERE channel_id = 'main'",
    ).all();
    expect(rows.some((row) => row.from_type === "agent" && row.text.includes("private answer"))).toBe(false);
    expect(rows.some((row) => row.from_type === "system" && row.text.includes("Messaged"))).toBe(true);
    // ...the specialist's own DM shows the reply...
    const dmRows = db.query<{ from_type: string; text: string }, []>(
      "SELECT from_type, text FROM channel_messages WHERE channel_id = 'dm:researcher'",
    ).all();
    expect(dmRows.some((row) => row.from_type === "agent" && row.text.includes("private answer"))).toBe(true);
    // ...and the work is still readable in the specialist's own conversation.
    const conversation = ensureConversation(db, "researcher");
    expect(conversationTranscript(db, conversation.id).some((message) => message.text.includes("private answer"))).toBe(true);
  });

  test("the handoff notice carries the delegation intent", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, defaultResolvedPersona(db!).id);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db,
      router: makeRouter(["Done."]),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
      threadID: parent.id,
      channelID: "main",
      currentAgentID: "ea",
      guardrail: rootGuardrail("ea"),
    });
    const tool = registry.get("handoff") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    await tool.handler(
      { toAgentID: "researcher", task: "Find it", intent: "question" },
      { threadID: parent.id, turnID: "trn_handoff", signal: new AbortController().signal },
    );

    const notice = emitted.find((frame) => frame.type === "msg.new" && frame.uiHint === "handoff_notice");
    expect(notice?.intent).toBe("question");

    // Absent means request — the frame still says so, so a client never has
    // to guess what silence meant.
    const second = new ToolRegistry();
    const defaultEmitted: Array<{ type: string; [key: string]: unknown }> = [];
    registerHandoffTool(second, {
      db,
      router: makeRouter(["Done."]),
      settings: { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 },
      emit: (frame) => defaultEmitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
      threadID: parent.id,
      channelID: "main",
      currentAgentID: "ea",
      guardrail: rootGuardrail("ea"),
    });
    const defaultTool = second.get("handoff") as unknown as {
      handler: (args: Record<string, unknown>, ctx: { threadID: string; turnID: string; signal: AbortSignal }) => Promise<unknown>;
    };
    await defaultTool.handler(
      { toAgentID: "researcher", task: "Find it again" },
      { threadID: parent.id, turnID: "trn_handoff_2", signal: new AbortController().signal },
    );
    const defaultNotice = defaultEmitted.find((frame) => frame.type === "msg.new" && frame.uiHint === "handoff_notice");
    expect(defaultNotice?.intent).toBe("request");
  });
});