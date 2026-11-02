import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  PROTOCOL_VERSION,
  parseServerFrame,
  type ClientFrame,
  type ServerFrame,
} from "@agni/protocol";
import { mintToken } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { startServer, type RunningServer } from "../src/ws/server";
import { PERSONAS } from "../src/agent/personas";

/**
 * End-to-end over a real socket: hello, a streamed turn against a stub
 * provider, the durable reads (`thread.list` / `thread.history`), and resync
 * replay that skips transient replies.
 */

const provider: ProviderConfig = {
  id: "test",
  label: "Test",
  baseUrl: "https://test.local/v1",
  apiKey: "test-key",
  model: "mock-model",
};

const encoder = new TextEncoder();

function sseResponse(...deltas: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function sseToolCall(name: string, args: unknown): Response {
  const event = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `call-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  };
  const body = `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), { status: 200 });
}

class TestClient {
  private readonly frames: ServerFrame[] = [];
  private readonly waiters: Array<{
    type: string;
    match?: (frame: ServerFrame) => boolean;
    resolve: (frame: ServerFrame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseServerFrame(JSON.parse(event.data));
      if (!parsed.ok) return;
      const frame = parsed.frame;
      const waiterIndex = this.waiters.findIndex(
        (waiter) => waiter.type === frame.type && (!waiter.match || waiter.match(frame)),
      );
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
          return;
        }
      }
      this.frames.push(frame);
    });
  }

  static async connect(url: string, token: string, device = "test"): Promise<TestClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    const client = new TestClient(ws);
    client.send({ type: "hello", v: PROTOCOL_VERSION, token, device });
    const hello = await client.next("hello.ok");
    // Real clients resync right after hello; without it the server holds live frames for 1s.
    client.send({ type: "resync", lastSeq: hello.lastSeq });
    await client.next("agents.update");
    return client;
  }

  send(frame: ClientFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  next<T extends ServerFrame["type"]>(
    type: T,
    options: { timeoutMs?: number; match?: (frame: Extract<ServerFrame, { type: T }>) => boolean } = {},
  ): Promise<Extract<ServerFrame, { type: T }>> {
    const { timeoutMs = 3000, match } = options;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        type,
        ...(match ? { match: match as (frame: ServerFrame) => boolean } : {}),
        resolve: resolve as (frame: ServerFrame) => void,
        timer,
      });
    });
  }

  /** Frames received so far that no waiter consumed. */
  seen(): ServerFrame[] {
    return [...this.frames];
  }

  /** Forget unconsumed frames (used to prove what a resync replayed). */
  drain(): void {
    this.frames.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

let client: TestClient | undefined;
let server: RunningServer | undefined;
let db: Database | undefined;
// Bots created here join the process-wide roster; drop them so later files start clean.
const INITIAL_ROSTER = PERSONAS.length;

afterEach(() => {
  PERSONAS.length = INITIAL_ROSTER;
  client?.close();
  client = undefined;
  server?.stop();
  server = undefined;
  db?.close();
  db = undefined;
});

async function startTestServer(fetchMock?: typeof fetch): Promise<void> {
  db = openDatabase(":memory:");
  const { token } = await mintToken(db, "test-device");
  const router = new Router(
    [provider],
    new HealthTracker(),
    fetchMock ?? ((async () => sseResponse("hello ", "there")) as unknown as typeof fetch),
  );
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    dbPath: ":memory:",
    pidPath: "",
    logPath: "",
    providers: [provider],
    firstTokenTimeoutMs: 1000,
    turnTimeoutMs: 5000,
    helloTimeoutMs: 2000,
    frameLogCapacity: 100,
    jobPollMs: 1000,
    maxConcurrentTurns: 4,
    pluginsPath: "",
  };
  server = startServer(config, db, router);
  client = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`, token);
}

describe("websocket end-to-end", () => {
  test("onboards the primary agent and persists channel messages", async () => {
    await startTestServer();
    const prompt = await client!.next("msg.new", { match: (frame) => frame.uiHint === "onboarding_name_prompt" });
    expect(prompt.channelId).toBe("main");
    expect(prompt.fromId).toBe("ea");

    client!.send({ type: "agent.rename", agentId: "ea", name: "Grot Bottis" });
    const updated = await client!.next("agent.updated");
    expect(updated.displayName).toBe("Grot Bottis");
    await client!.next("msg.new", { match: (frame) => frame.text.startsWith("Grot Bottis. Nice to meet you") });

    client!.send({ type: "msg.send", channelId: "main", text: "say hi" });
    const userMessage = await client!.next("msg.new", { match: (frame) => frame.fromType === "user" && frame.text === "say hi" });
    expect(userMessage.channelId).toBe("main");
    const started = await client!.next("turn.start");
    await client!.next("turn.end");
    expect(started.conversationID).toBeTruthy();
    const stored = db!.query<{ from_id: string; text: string }, [string]>(
      "SELECT from_id, text FROM channel_messages WHERE id = ?",
    ).get(userMessage.id);
    expect(stored?.text).toBe("say hi");
    expect(stored?.from_id).toBe(userMessage.fromId);
  });

  test("a lone message dispatches without the batch debounce", async () => {
    await startTestServer();
    client!.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client!.next("agent.updated");
    client!.send({ type: "msg.send", channelId: "main", text: "hi" });
    await client!.next("turn.start");
    await client!.next("turn.end");
    expect(client!.seen().some((frame) => frame.type === "status.update" && String(frame.text).startsWith("Got it"))).toBe(false);
  });

  test("a burst sent during a turn merges into one follow-up turn", async () => {
    const bodies: string[] = [];
    await startTestServer((async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      // Slow enough that the rest of the burst arrives while this turn runs.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return sseResponse("ok");
    }) as unknown as typeof fetch);
    client!.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client!.next("agent.updated");
    client!.send({ type: "msg.send", channelId: "main", text: "first part" });
    client!.send({ type: "msg.send", channelId: "main", text: "second part" });
    client!.send({ type: "msg.send", channelId: "main", text: "third part" });
    await client!.next("turn.end");
    await client!.next("turn.end");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const userTurns = bodies.filter((body) => body.includes("part"));
    expect(userTurns.length).toBe(2);
    expect(userTurns[1]).toContain("second part\\n\\nthird part");
    expect(client!.seen().filter((frame) => frame.type === "turn.end").length).toBe(0);
  });

  test("a secret request crosses the socket and never reaches the transcript", async () => {
    let request = 0;
    const fetchMock = (async () => {
      request += 1;
      return request === 1
        ? sseToolCall("run_privileged", { command: "cat", purpose: "prove the secret stays out" })
        : sseResponse("Done.");
    }) as unknown as typeof fetch;
    await startTestServer(fetchMock);

    client!.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client!.next("agent.updated");
    client!.send({ type: "msg.send", channelId: "main", text: "run the privileged command" });
    await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });

    // run_privileged is not a known-free tool, so the owner approves it first.
    const approval = await client!.next("approval.request", { timeoutMs: 5000 });
    client!.send({ type: "approve.reply", requestID: approval.requestID, decision: "once" });
    const secretRequest = await client!.next("secret.request", { timeoutMs: 5000 });
    expect(secretRequest).toMatchObject({
      purpose: "prove the secret stays out",
      command: "cat",
      kind: "password",
    });
    expect(JSON.stringify(secretRequest)).not.toContain("top-secret-value");

    client!.send({ type: "secret.reply", requestID: secretRequest.requestID, value: "top-secret-value" });
    await client!.next("turn.end", { timeoutMs: 5000 });

    const row = db!.query<{ result: string }, []>(
      "SELECT result FROM tool_calls ORDER BY rowid DESC LIMIT 1",
    ).get();
    expect(row?.result).toContain("[redacted]");
    expect(row?.result).not.toContain("top-secret-value");
    const messageHits = db!.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM messages WHERE text LIKE ?",
    ).get("%top-secret-value%");
    expect(messageHits?.n).toBe(0);
    const channelHits = db!.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM channel_messages WHERE text LIKE ?",
    ).get("%top-secret-value%");
    expect(channelHits?.n).toBe(0);
  });

  test("reports the name prompt as settled once the agent has a name", async () => {
    await startTestServer();
    client!.send({ type: "agent.rename", agentId: "ea", name: "Vision" });
    await client!.next("agent.updated");

    client!.send({ type: "conversation.open", conversationID: "", agentID: "ea" });
    const opened = await client!.next("conversation.ok");
    client!.send({ type: "conversation.history", conversationID: opened.conversationID, limit: 50 });
    const history = await client!.next("conversation.history.ok");

    const prompt = history.messages.find((message) => message.uiHint?.startsWith("onboarding"));
    expect(prompt?.uiHint).toBe("onboarding_completed");
    expect(prompt?.senderName).toBe("Vision");
  });

  test("edits an agent's tag and visibility over the socket", async () => {
    await startTestServer();
    client!.send({ type: "agent.profile", agentId: "ea", role: "chief of staff", visibility: "private" });
    const updated = await client!.next("agent.updated");
    expect(updated.agentId).toBe("ea");
    expect(updated.role).toBe("chief of staff");
    expect(updated.visibility).toBe("private");

    const row = db!.query<{ role_detail: string | null; visibility: string | null }, [string]>(
      "SELECT role_detail, visibility FROM agents WHERE id = 'ea'",
    ).get("ea");
    expect(row?.role_detail).toBe("chief of staff");
    expect(row?.visibility).toBe("private");
  });

  test("refuses a profile edit that changes nothing", async () => {
    await startTestServer();
    client!.send({ type: "agent.profile", agentId: "ea" });
    const error = await client!.next("error");
    expect(error.code).toBe("bad_frame");
  });

  test("creates an agent from the app and puts it in the roster", async () => {
    await startTestServer();
    client!.send({
      type: "agent.create",
      name: "FRIDAY",
      role: "inbox manager",
      prompt: "You read my inbox and draft replies.",
    });
    const roster = await client!.next("agents.update");
    const created = roster.agents.find((agent) => agent.id === "friday");
    expect(created?.name).toBe("FRIDAY");
    expect(created?.role).toBe("inbox manager");
    const row = db!.query<{ display_name: string | null; role_detail: string | null }, [string]>(
      "SELECT display_name, role_detail FROM agents WHERE id = 'friday'",
    ).get("friday");
    expect(row?.display_name).toBe("FRIDAY");
    expect(row?.role_detail).toBe("inbox manager");
  });

  test("a bot made as New bot can be named straight afterwards", async () => {
    await startTestServer();
    // Exactly what the app sends when the roster's "+" makes a bot: nothing
    // is asked for first, the bot simply exists under a placeholder name.
    client!.send({
      type: "agent.create",
      id: "new_bot",
      name: "New bot",
      role: "unnamed",
      prompt: "You are {name}, an agent {user} just created in the app.",
    });
    const roster = await client!.next("agents.update");
    const created = roster.agents.find((agent) => agent.id === "new_bot");
    expect(created?.name).toBe("New bot");
    expect(created?.role).toBe("unnamed");

    // Naming it by telling it in chat is the same rename the profile uses.
    client!.send({ type: "agent.rename", agentId: "new_bot", name: "Bob" });
    const renamed = await client!.next("agent.updated", {
      match: (frame) => frame.agentId === "new_bot" && frame.displayName === "Bob",
    });
    expect(renamed.displayName).toBe("Bob");
    const row = db!
      .query<{ display_name: string | null }, []>("SELECT display_name FROM agents WHERE id = 'new_bot'")
      .get();
    expect(row?.display_name).toBe("Bob");
  });

  test("refuses to create an agent that already exists", async () => {
    await startTestServer();
    client!.send({ type: "agent.create", name: "Vision", id: "ea", prompt: "A second primary agent." });
    const error = await client!.next("error");
    expect(error.code).toBe("bad_frame");
  });

  test("the agent can put a question to the owner, and the answer comes back", async () => {
    let call = 0;
    const fetchMock = (async () => {
      call += 1;
      return call === 1
        ? sseToolCall("ask", { question: "Which one?", options: ["Revenue", "Headcount"] })
        : sseResponse("Chosen.");
    }) as unknown as typeof fetch;
    await startTestServer(fetchMock);

    // Onboard the agent first: until it has a name, a message to the main
    // channel is taken as its name instead of being published.
    client!.send({ type: "agent.rename", agentId: "ea", name: "Vision" });
    await client!.next("agent.updated");
    client!.send({ type: "msg.send", channelId: "main", text: "ask me something" });
    await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });

    const form = await client!.next("form.request", { timeoutMs: 10_000 });
    expect(form.question).toBe("Which one?");
    expect(form.options).toEqual(["Revenue", "Headcount"]);
    expect(form.kind).toBe("choice");

    client!.send({ type: "form.answer", requestID: form.requestID, answer: "Headcount" });
    await client!.next("turn.end", { timeoutMs: 10_000 });

    // The answer reached the model: the tool result carries it.
    const calls = db!.query<{ tool_name: string; result: string }, []>(
      "SELECT tool_name, result FROM tool_calls WHERE tool_name = 'ask'",
    ).all();
    expect(calls.length).toBe(1);
    expect(calls[0]?.result).toContain("Headcount");
  });

  test("an email draft waits for the owner's decision", async () => {
    let call = 0;
    const fetchMock = (async () => {
      call += 1;
      return call === 1
        ? sseToolCall("draft_email", { to: "sarah@acme.com", subject: "Moving the review", body: "Hi Sarah," })
        : sseResponse("Sent.");
    }) as unknown as typeof fetch;
    await startTestServer(fetchMock);

    client!.send({ type: "agent.rename", agentId: "ea", name: "Vision" });
    await client!.next("agent.updated");
    client!.send({ type: "msg.send", channelId: "main", text: "draft that email" });
    await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });

    const form = await client!.next("form.request", { timeoutMs: 10_000 });
    expect(form.kind).toBe("email");
    expect(form.email?.to).toBe("sarah@acme.com");
    expect(form.email?.subject).toBe("Moving the review");

    client!.send({ type: "form.answer", requestID: form.requestID, answer: "Discard" });
    await client!.next("turn.end", { timeoutMs: 10_000 });

    const calls = db!.query<{ tool_name: string; result: string }, []>(
      "SELECT tool_name, result FROM tool_calls WHERE tool_name = 'draft_email'",
    ).all();
    expect(calls[0]?.result).toContain("discard");
  });

  test("opens a direct channel for a specialist", async () => {
    await startTestServer();
    client!.send({ type: "msg.send", channelId: "dm:researcher", toAgentId: "researcher", text: "hello researcher" });
    const userMessage = await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });
    expect(userMessage.channelId).toBe("dm:researcher");
    const started = await client!.next("turn.start");
    await client!.next("turn.end");
    expect(started.agentID).toBe("researcher");
    expect(db!.query("SELECT id FROM channels WHERE id = 'dm:researcher'").get()).toBeTruthy();
  });

  test("a leading @mention routes a main-channel message to that specialist", async () => {
    await startTestServer();
    // No channelId/toAgentId: the mention itself decides where the message goes.
    client!.send({ type: "msg.send", text: "@researcher find the source of the delay" });
    const userMessage = await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });
    expect(userMessage.channelId).toBe("dm:researcher");
    expect(userMessage.text).toBe("find the source of the delay");
    const started = await client!.next("turn.start");
    expect(started.agentID).toBe("researcher");
    await client!.next("turn.end");
  });

  test("an @agni mention stays on the main channel", async () => {
    await startTestServer();
    client!.send({ type: "msg.send", text: "@agni hello" });
    const userMessage = await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });
    expect(userMessage.channelId).toBe("main");
    expect(userMessage.text).toBe("hello");
    await client!.next("turn.end");
    expect(db!.query("SELECT id FROM channels WHERE id = 'dm:ea'").get()).toBeNull();
  });

  test("streams a turn, then serves thread list and history", async () => {
    await startTestServer();

    client!.send({ type: "msg.send", threadID: "", text: "say hi" });
    const started = await client!.next("turn.start");
    const firstDelta = await client!.next("token");
    const end = await client!.next("turn.end");
    expect(end.stopReason).toBe("end");
    expect(firstDelta.delta.length).toBeGreaterThan(0);
    expect(end.threadID).toBe(started.threadID);

    // Durable reads answer the requester.
    client!.send({ type: "thread.list" });
    const list = await client!.next("thread.list.ok");
    expect(list.threads.map((thread) => thread.id)).toContain(started.threadID);
    expect(list.threads[0]?.title).toBe("say hi");

    client!.send({ type: "thread.history", threadID: started.threadID });
    const history = await client!.next("thread.history.ok");
    expect(history.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history.messages[1]?.text).toBe("hello there");
  });

  test("resync replays shared frames but not transient replies", async () => {
    await startTestServer();

    client!.send({ type: "msg.send", threadID: "", text: "one" });
    await client!.next("turn.end");
    client!.send({ type: "thread.list" });
    await client!.next("thread.list.ok");

    // A subscriber starting from zero must see the turn, not the frames that
    // were addressed to this connection's earlier requests.
    client!.drain();
    client!.send({ type: "resync", lastSeq: 0 });
    await Bun.sleep(50);
    const replayed = client!.seen();
    expect(replayed.some((frame) => frame.type === "turn.start")).toBe(true);
    expect(replayed.some((frame) => frame.type === "thread.list.ok")).toBe(false);
    expect(replayed.some((frame) => frame.type === "hello.ok")).toBe(false);
  });

  test("captures memory and task records without calling a model and persists task actions", async () => {
    await startTestServer();
    client!.send({ type: "msg.send", threadID: "", text: "remember: the workshop key is in the blue drawer" });
    const capture = await client!.next("turn.start");
    const memoryReply = (await client!.next("token")).delta;
    await client!.next("turn.end", { match: (frame) => frame.threadID === capture.threadID });
    expect(db!.query<{ count: number }, []>("SELECT count(*) AS count FROM agent_memories WHERE content LIKE '%blue drawer%'").get()?.count).toBe(1);
    // The confirmation speaks like a person: no record ids, no log lines.
    expect(memoryReply.startsWith("Noted")).toBe(true);
    expect(memoryReply).not.toMatch(/mem_/);

    client!.send({ type: "msg.send", threadID: capture.threadID, text: "add task: renew insurance by 2027-01-02 priority: high" });
    await client!.next("turn.start");
    const taskReply = (await client!.next("token")).delta;
    await client!.next("turn.end", { match: (frame) => frame.threadID === capture.threadID });
    expect(taskReply.startsWith("On the list")).toBe(true);
    expect(taskReply).not.toMatch(/tsk_/);
    client!.send({ type: "task.list", status: "open" });
    const tasks = await client!.next("task.list.ok");
    const task = tasks.tasks[0];
    expect(task?.title).toBe("renew insurance");
    expect(task?.priority).toBe("high");
    client!.send({ type: "task.update", taskID: task!.id, action: "snooze", until: "2099-01-01T12:00:00.000Z" });
    expect((await client!.next("task.update.ok")).task.status).toBe("snoozed");
    client!.send({ type: "task.update", taskID: task!.id, action: "done" });
    expect((await client!.next("task.update.ok")).task.status).toBe("done");
  });

  test("reloaded history keeps the user's own messages on the user side", async () => {
    await startTestServer();

    client!.send({ type: "conversation.open", conversationID: "", agentID: "agni" });
    const opened = await client!.next("conversation.ok");

    client!.send({ type: "msg.send", conversationID: opened.conversationID, text: "what is your name" });
    await client!.next("turn.start");
    await client!.next("turn.end");

    // A client message stores the device id in `from_id`, so history must take
    // the role from `from_type` and the label from the device — not from `from_id`.
    client!.send({ type: "conversation.history", conversationID: opened.conversationID });
    const history = await client!.next("conversation.history.ok");
    const mine = history.messages.filter((message) => message.text === "what is your name");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.role).toBe("user");
    expect(mine[0]?.senderName).toBe("test-device");
    expect(history.messages.some((message) => message.senderName?.startsWith("dev_"))).toBe(false);
  });

  test("the conversation model: one chat surface, session blocks, /new never moves the user", async () => {
    await startTestServer();

    // Resolve the agent's one conversation; no block exists yet.
    client!.send({ type: "conversation.open", conversationID: "", agentID: "agni" });
    const opened = await client!.next("conversation.ok");
    expect(opened.agentID).toBe("agni");

    // First message: opens the first block in that conversation.
    client!.send({ type: "msg.send", conversationID: opened.conversationID, text: "what is the plan" });
    const firstTurn = await client!.next("turn.start");
    expect(firstTurn.conversationID).toBe(opened.conversationID);
    await client!.next("turn.end");

    // /new: a session boundary arrives as stream state, the user stays put.
    client!.send({ type: "session.new", conversationID: opened.conversationID });
    const boundary = await client!.next("session.start");
    expect(boundary.conversationID).toBe(opened.conversationID);
    expect(boundary.reason).toBe("manual");
    expect(boundary.sessionID).not.toBe(firstTurn.threadID);

    // The next message continues in the new block — same conversation.
    client!.send({ type: "msg.send", conversationID: opened.conversationID, text: "what were we doing" });
    const secondTurn = await client!.next("turn.start");
    expect(secondTurn.conversationID).toBe(opened.conversationID);
    expect(secondTurn.threadID).toBe(boundary.sessionID);
    const secondEnd = await client!.next("turn.end");
    expect(secondEnd.conversationID).toBe(opened.conversationID);

    // The transcript spans both blocks, sessionID per message for dividers.
    client!.send({ type: "conversation.history", conversationID: opened.conversationID });
    const history = await client!.next("conversation.history.ok");
    expect(history.conversationID).toBe(opened.conversationID);
    const sessionIDs = new Set(history.messages.map((message) => message.sessionID));
    expect(sessionIDs.has(firstTurn.threadID)).toBe(true);
    expect(sessionIDs.has(secondTurn.threadID)).toBe(true);

    // The closed blocks live on as conversation rows, openable and answerable.
    client!.send({ type: "conversation.open", conversationID: opened.conversationID });
    const reopened = await client!.next("conversation.ok");
    expect(reopened.sessionID).toBe(secondTurn.threadID);

    // Unknown conversations answer honestly.
    client!.send({ type: "session.new", conversationID: "cnv_missing" });
    await client!.next("error", { match: (frame) => frame.code === "unknown_conversation" });
  });

  test("a task answer resumes the task, and only once", async () => {
    await startTestServer();
    // A task waiting on a question, with the specialist's own thread.
    const child = db!.query<{ id: string }, []>("SELECT id FROM threads LIMIT 1").get();
    const threadID = createThreadFor(db!, "researcher");
    db!.run(
      `INSERT INTO tasks (id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id,child_thread_id,parent_thread_id,parent_channel_id,parent_agent_id,pending_question,pending_question_id,result_delivered_at,artifact_id)
       VALUES ('tsk_q','Find it',NULL,'normal','open',datetime('now'),datetime('now'),NULL,NULL,'researcher','ea_delegated','needs_input',NULL,NULL,NULL,NULL,?,?,?,NULL,'Which account?',NULL,NULL,NULL)`,
      [threadID, threadID, "main"],
    );

    client!.send({ type: "task.answer", taskID: "tsk_q", questionID: "qst_1", text: "Use the second account" });
    // The question id does not match: refused.
    await client!.next("error", { match: (frame) => frame.code === "bad_task_answer" });

    db!.run("UPDATE tasks SET pending_question_id = 'qst_1' WHERE id = 'tsk_q'");
    client!.send({ type: "task.answer", taskID: "tsk_q", questionID: "qst_1", text: "Use the second account" });
    const ok = await client!.next("task.answer.ok");
    expect(ok.task.id).toBe("tsk_q");
    expect(ok.task.delegateState).toBe("running");

    // A second answer to the same question is refused.
    client!.send({ type: "task.answer", taskID: "tsk_q", questionID: "qst_1", text: "again" });
    await client!.next("error", { match: (frame) => frame.code === "bad_task_answer" });
    expect(child).toBeDefined();
  });

  test("a normal message never resumes a task", async () => {
    await startTestServer();
    const threadID = createThreadFor(db!, "researcher");
    db!.run(
      `INSERT INTO tasks (id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id,child_thread_id,parent_thread_id,parent_channel_id,parent_agent_id,pending_question,pending_question_id,result_delivered_at,artifact_id)
       VALUES ('tsk_q2','Find it',NULL,'normal','open',datetime('now'),datetime('now'),NULL,NULL,'researcher','ea_delegated','needs_input',NULL,NULL,NULL,NULL,?,?,?,NULL,'Which account?','qst_2',NULL,NULL)`,
      [threadID, threadID, "main"],
    );
    // Name the assistant first: the first main-channel message is the answer
    // to its name prompt, not a chat message.
    client!.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client!.next("agent.updated");
    client!.send({ type: "msg.send", channelId: "main", text: "just a normal message" });
    await client!.next("msg.new", { match: (frame) => frame.fromType === "user" });
    const state = db!.query<{ delegate_state: string }, []>("SELECT delegate_state FROM tasks WHERE id = 'tsk_q2'").get();
    expect(state?.delegate_state).toBe("needs_input");
  });

  test("the memory view shows what the caller can recall, and nothing else", async () => {
    await startTestServer();
    // A shared fact, and a private one that belongs to the researcher.
    db!.run(
      `INSERT INTO agent_memories (id,scope,agent_id,type,key_slug,content,tags,importance,created_at,updated_at,kind,valid_from,valid_to,supersedes_id,source_block_id,source_turn_ids,last_used_at,use_count,embedding,confidence,salience,visibility,source,created_at)
       VALUES ('mem_shared','global_user',NULL,'fact','shared-note','The shared note.',NULL,0.5,datetime('now'),datetime('now'),'fact',datetime('now'),NULL,NULL,NULL,NULL,NULL,0,NULL,1.0,0.5,'shared','user',datetime('now'))`,
    );
    db!.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    db!.run(
      `INSERT INTO agent_memories (id,scope,agent_id,type,key_slug,content,tags,importance,created_at,updated_at,kind,valid_from,valid_to,supersedes_id,source_block_id,source_turn_ids,last_used_at,use_count,embedding,confidence,salience,visibility,source,created_at)
       VALUES ('mem_private','global_user','researcher','fact','private-note','The private note.',NULL,0.5,datetime('now'),datetime('now'),'fact',datetime('now'),NULL,NULL,NULL,NULL,NULL,0,NULL,1.0,0.5,'private','user',datetime('now'))`,
    );

    client!.send({ type: "memory.list", scope: "global_user" });
    const listed = await client!.next("memory.list.ok");
    const texts = listed.memories.map((memory) => memory.text);
    expect(texts).toContain("The shared note.");
    expect(texts).not.toContain("The private note.");

    // Editable memory: an edit, a pin, a forget, and another bot's private
    // row is out of reach.
    client!.send({ type: "memory.update", id: "mem_shared", text: "The shared note, edited." });
    const updated = await client!.next("memory.update.ok");
    expect(updated.memory.text).toBe("The shared note, edited.");
    client!.send({ type: "memory.pin", id: updated.memory.id, pinned: true });
    expect((await client!.next("memory.pin.ok")).memory.salience).toBe(1);
    client!.send({ type: "memory.forget", id: "mem_private" });
    expect((await client!.next("error")).code).toBe("unknown_memory");
    client!.send({ type: "memory.forget", id: updated.memory.id });
    expect((await client!.next("memory.forget.ok")).deleted).toBe(true);
  });

  test("a memory conflict can be listed and resolved by keeping the old value", async () => {
    await startTestServer();
    const { applyTaggerItems } = await import("../src/agent/tagger");
    const item = {
      kind: "fact" as const, key: "home-city", scope: "user" as const, visibility: "shared" as const, source: "user" as const,
      salience: 0.6, confidence: 0.9, entities: [], ttl: null, source_turn_ids: [],
    };
    applyTaggerItems(db!, { items: [{ ...item, text: "The owner lives in NYC." }], agentID: "ea" });
    applyTaggerItems(db!, { items: [{ ...item, text: "The owner lives in SF." }], agentID: "ea" });

    client!.send({ type: "memory.conflicts.list" });
    const { conflicts } = await client!.next("memory.conflicts.list.ok");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.previousContent).toBe("The owner lives in NYC.");

    client!.send({ type: "memory.conflict.resolve", id: conflicts[0]!.id, keepId: conflicts[0]!.previousId });
    const resolved = await client!.next("memory.conflict.resolve.ok");
    expect(resolved.memory.text).toBe("The owner lives in NYC.");
    client!.send({ type: "memory.conflicts.list" });
    expect((await client!.next("memory.conflicts.list.ok")).conflicts).toHaveLength(0);
  });

  test("bind.direct answers with the agent's conversation and channel", async () => {
    await startTestServer();
    client!.send({ type: "bind.direct", agentID: "researcher" });
    const bound = await client!.next("bind.direct.ok");
    expect(bound.agentID).toBe("researcher");
    expect(bound.channelID).toBe("dm:researcher");
    expect(bound.conversationID).toBeTruthy();

    // The executive assistant binds to the main channel.
    client!.send({ type: "bind.direct", agentID: "ea" });
    const main = await client!.next("bind.direct.ok");
    expect(main.channelID).toBe("main");
  });

  test("a stop message cancels the running turn and says so", async () => {
    await startTestServer((async (_url: string, init?: RequestInit) => {
      // Hold the turn open until the stop aborts it.
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return sseResponse("never arrives");
    }) as unknown as typeof fetch);

    client!.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client!.next("agent.updated");

    client!.send({ type: "msg.send", channelId: "main", text: "work on the long thing" });
    const started = await client!.next("turn.start");
    // Let the runner register the turn before the stop arrives.
    await new Promise((resolve) => setTimeout(resolve, 60));

    client!.send({ type: "msg.send", channelId: "main", text: "stop" });
    const ack = await client!.next("status.update", { match: (frame) => frame.text === "Stopped." });
    expect(ack.transient).toBe(true);

    const end = await client!.next("turn.end", { match: (frame) => frame.turnID === started.turnID });
    expect(end.stopReason).toBe("cancelled");
  });

  test("a message sent mid-turn waits instead of cancelling the turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    await startTestServer((async () => {
      call += 1;
      if (call === 1) await gate;
      return sseResponse(call === 1 ? "first answer" : "second answer");
    }) as unknown as typeof fetch);

    client!.send({ type: "agent.rename", agentId: "ea", name: "Agni" });
    await client!.next("agent.updated");

    client!.send({ type: "msg.send", channelId: "main", text: "the first thing" });
    const first = await client!.next("turn.start");

    // A second message while the first is still running joins the queue.
    client!.send({ type: "msg.send", channelId: "main", text: "the second thing" });
    await client!.next("status.update", { match: (frame) => frame.text.startsWith("Queued") });

    release();
    const firstEnd = await client!.next("turn.end", { match: (frame) => frame.turnID === first.turnID });
    expect(firstEnd.stopReason).toBe("end");

    const second = await client!.next("turn.start", { match: (frame) => frame.turnID !== first.turnID });
    const secondEnd = await client!.next("turn.end", { match: (frame) => frame.turnID === second.turnID });
    expect(secondEnd.stopReason).toBe("end");
  });
});

/** A thread for an agent, the way a background delegation gets one. */
function createThreadFor(db: Database, agentID: string): string {
  const id = `thr_${agentID}_${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    "INSERT INTO threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, '', datetime('now'), datetime('now'))",
    [id, agentID],
  );
  return id;
}

describe("group channels (Phase 4)", () => {
  async function startGroupServer(bodies: string[]): Promise<void> {
    await startTestServer((async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (!body.includes("The owner now says:")) return sseResponse("{}");
      bodies.push(body);
      return sseResponse(body.includes("reveal the code") ? "The code is SECRET-XYZ." : "Noted.");
    }) as unknown as typeof fetch);
  }

  test("the owner creates and lists a group of two or more bots", async () => {
    await startTestServer();
    client!.send({ type: "channel.create", name: "Launch", agentIds: ["ea", "researcher"] });
    const created = await client!.next("channel.created");
    expect(created.channel).toMatchObject({ name: "Launch", type: "group", agentIds: ["ea", "researcher"] });
    client!.send({ type: "channel.list" });
    const listed = await client!.next("channel.list.ok");
    expect(listed.channels.map((channel) => channel.id)).toEqual([created.channel.id]);
    client!.send({ type: "channel.create", name: "Solo", agentIds: ["ea", "ea"] });
    expect((await client!.next("error")).code).toBe("bad_frame");
  });

  test("floor rule: the primary answers, an @named member takes the floor, and the room stays the room", async () => {
    const bodies: string[] = [];
    await startGroupServer(bodies);
    client!.send({ type: "channel.create", name: "Launch", agentIds: ["ea", "researcher"] });
    const { channel } = await client!.next("channel.created");

    client!.send({ type: "msg.send", channelId: channel.id, text: "plan the launch" });
    expect((await client!.next("turn.start")).agentID).toBe("ea");
    await client!.next("turn.end");

    client!.send({ type: "msg.send", channelId: channel.id, text: "@Researcher find venues" });
    expect((await client!.next("turn.start")).agentID).toBe("researcher");
    await client!.next("turn.end");
    // The researcher sees the room: the owner's first message and the primary's reply.
    expect(bodies[1]).toContain("owner: plan the launch");
    expect(bodies[1]).toContain("Noted.");
    // Every message, both bots' answers included, lives in the group channel.
    const rows = db!.query<{ from_id: string; to_agent_id: string | null }, [string]>(
      "SELECT from_id, to_agent_id FROM channel_messages WHERE channel_id = ? ORDER BY rowid",
    ).all(channel.id);
    expect(rows.filter((row) => row.from_id === "researcher")).toHaveLength(1);
    expect(rows.some((row) => row.to_agent_id === "researcher")).toBe(true);
    client!.send({ type: "channel.history", channelId: channel.id });
    const history = await client!.next("channel.history.ok");
    expect(history.messages.map((message) => message.text)).toContain("find venues");
  });

  test("a private bot's words in the room do not reach the other bots", async () => {
    const bodies: string[] = [];
    await startGroupServer(bodies);
    db!.run("UPDATE agents SET visibility = 'private' WHERE id = 'researcher'");
    client!.send({ type: "channel.create", name: "Ops", agentIds: ["ea", "researcher"] });
    const { channel } = await client!.next("channel.created");
    client!.send({ type: "msg.send", channelId: channel.id, text: "@Researcher reveal the code" });
    await client!.next("turn.end");
    client!.send({ type: "msg.send", channelId: channel.id, text: "what did it say?" });
    expect((await client!.next("turn.start")).agentID).toBe("ea");
    await client!.next("turn.end");
    const eaBody = bodies.at(-1)!;
    expect(eaBody).toContain("(replied; private)");
    expect(eaBody).not.toContain("SECRET-XYZ");
  });
});
