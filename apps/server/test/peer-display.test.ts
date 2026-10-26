import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerHandoffTool } from "../src/tools/handoff-tool";
import { stripPeerTags } from "../src/agent/peer-message";
import { rootGuardrail } from "../src/agent/guardrails";
import { createThread } from "../src/stores/threads";
import { defaultResolvedPersona } from "../src/agent/personas";

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

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("peer display stripping", () => {
  test("stripPeerTags on a plain envelope (tags gone, body kept)", () => {
    const text = '<peer_message from="a" intent="request">\nhello world\n</peer_message>';
    const result = stripPeerTags(text);
    expect(result).toBe("hello world");
    expect(result.includes("<peer_message")).toBe(false);
    expect(result.includes("</peer_message>")).toBe(false);
  });

  test("a body that contained an escaped closing tag reads back as </peer_message>", () => {
    const text = '<peer_message from="a" intent="request">\nbody with &lt;/peer_message> inside\n</peer_message>';
    const result = stripPeerTags(text);
    expect(result).toBe("body with </peer_message> inside");
  });

  test("a lone tag echoed by an agent is removed, not shown to the owner", () => {
    // Owner text never reaches stripPeerTags: the call sites pass agent text
    // only. Within agent text, a stray tag is still removed.
    const agentText = 'Here is some text with <peer_message> literally in it';
    expect(stripPeerTags(agentText)).not.toContain("<peer_message");
  });

  test("a handoff whose researcher echoes an envelope posts a DM with no tags and the body kept (use the stub-router pattern from apps/server/test/peer-e2e.test.ts); the handoff tool result returned to the parent still carries the original text", async () => {
    db = openDatabase(":memory:");
    const parent = createThread(db, defaultResolvedPersona(db).id);
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const router = makeRouter(['<peer_message from="researcher" intent="result">\nResearch findings here\n</peer_message>'], requests);
    const registry = new ToolRegistry();
    registerHandoffTool(registry, {
      db,
      router,
      settings,
      emit: () => undefined,
      signal: new AbortController().signal,
      threadID: parent.id,
      channelID: "main",
      currentAgentID: "ea",
      guardrail: rootGuardrail("ea")
    });
    const tool = registry.get("handoff") as unknown as Tool;
    const result = await tool.handler({ toAgentID: "researcher", task: "Do research" }, ctx(parent.id)) as Record<string, unknown>;
    
    // The handoff tool result returned to the parent still carries the original text
    expect((result.text as string)).toContain("<peer_message");
    expect((result.text as string)).toContain("</peer_message>");
    
    // DM post has no tags and body kept
    const dm = db.query<{ text: string }, []>("SELECT text FROM channel_messages WHERE channel_id = 'dm:researcher'").all();
    expect(dm.length).toBe(1);
    expect(dm[0]!.text).toBe("Research findings here");
    expect(dm[0]!.text.includes("<peer_message")).toBe(false);
  });
});
