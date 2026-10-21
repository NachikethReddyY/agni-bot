import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { bypassesBatch, classifyTurn } from "../src/agent/gate";
import { appendChannelMessage, createChannel, listChannelMessages, uncompactedMessages } from "../src/stores/channels";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("turn gate", () => {
  test("a short standalone question is ephemeral", () => {
    const gate = classifyTurn("what port is postgres on?");
    expect(gate.category).toBe("ephemeral");
    expect(gate.salience).toBe("temp");
  });

  test("a bare follow-up is deictic and not ephemeral", () => {
    const gate = classifyTurn("and tomorrow?", "what is the weather today?");
    expect(gate.deictic).toBe(true);
    expect(gate.salience).toBe("recent_turns");
  });

  test("explicit remember and add task bypass batching", () => {
    expect(classifyTurn("remember: I prefer dark mode").category).toBe("explicit_remember");
    expect(classifyTurn("add task: buy milk").category).toBe("explicit_remember");
    expect(bypassesBatch("explicit_remember")).toBe(true);
    expect(bypassesBatch("ephemeral")).toBe(false);
  });

  test("an action request is task intent, not a durable fact", () => {
    const gate = classifyTurn("please schedule a meeting with the design team tomorrow");
    expect(gate.category).toBe("task_intent");
    expect(gate.salience).toBe("recent_turns");
  });

  test("a first-person preference is a durable candidate", () => {
    const gate = classifyTurn("I prefer concise answers without preamble");
    expect(gate.category).toBe("durable_candidate");
  });

  test("greetings and acknowledgements are ephemeral", () => {
    expect(classifyTurn("thanks!").salience).toBe("temp");
    expect(classifyTurn("got it").salience).toBe("temp");
  });
});

describe("salience persistence", () => {
  test("temp turns stay in the transcript but are skipped by compaction", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const kept = appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "u", text: "explain the plan", salience: "recent_turns" });
    const temp = appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "u", text: "thanks!", salience: "temp" });

    expect(listChannelMessages(db, channel.id, 10).map((row) => row.id)).toEqual([kept.id, temp.id]);
    expect(uncompactedMessages(db, channel.id, 10).map((row) => row.id)).toEqual([kept.id]);
  });

  test("messages default to recent_turns when the gate does not classify", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const row = appendChannelMessage(db, { channelID: channel.id, fromType: "user", fromID: "u", text: "hello" });
    expect(row.salience).toBe("recent_turns");
  });
});
