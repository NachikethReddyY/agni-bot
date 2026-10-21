import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import {
  addChannelMember,
  appendChannelMessage,
  createChannel,
  getChannel,
  listChannelMembers,
  listChannelMessages,
  markMessagesCompacted,
  uncompactedMessages,
  upsertChannelSummary,
  getChannelSummary,
} from "../src/stores/channels";
import { putAgentMemory, listAgentMemories, getAgentMemory } from "../src/stores/agent-memories";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("channel schema", () => {
  test("channels carry type/visibility/parent_turn and members use the published key", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db!, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const fetched = getChannel(db!, channel.id);
    expect(fetched?.type).toBe("main");
    expect(fetched?.visibility).toBe("public");
    expect(fetched?.parent_turn_id).toBeNull();
    addChannelMember(db!, channel.id, "agent", "ea", "owner");
    addChannelMember(db!, channel.id, "user", "user", "member");
    const members = listChannelMembers(db!, channel.id);
    expect(members.map((row) => `${row.participant_type}:${row.participant_id}:${row.role}`)).toEqual([
      "agent:ea:owner",
      "user:user:member",
    ]);
  });

  test("channel messages carry sender identity, internal flag, and ui_hint", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db!, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const userRow = appendChannelMessage(db!, {
      channelID: channel.id, fromType: "user", fromID: "dev_1", text: "hello",
    });
    const agentRow = appendChannelMessage(db!, {
      channelID: channel.id, fromType: "agent", fromID: "ea", text: "hi there", internal: true, uiHint: "onboarding_name_prompt",
    });
    const rows = listChannelMessages(db!, channel.id, 10);
    expect(rows.map((row) => row.id)).toEqual([userRow.id, agentRow.id]);
    expect(rows[0]).toMatchObject({ from_type: "user", from_id: "dev_1", internal: 0, ui_hint: null });
    expect(rows[1]).toMatchObject({ from_type: "agent", from_id: "ea", internal: 1, ui_hint: "onboarding_name_prompt" });
  });

  test("compaction marks old messages and keeps recent ones", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db!, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = appendChannelMessage(db!, { channelID: channel.id, fromType: "user", fromID: "u", text: `msg ${i}` });
      ids.push(row.id);
    }
    markMessagesCompacted(db!, ids.slice(0, 3));
    const remaining = uncompactedMessages(db!, channel.id, 100).map((row) => row.id);
    expect(remaining).toEqual(ids.slice(3));
  });

  test("channel summaries upsert on the channel id", () => {
    db = openDatabase(":memory:");
    const channel = createChannel(db!, { type: "main", visibility: "public", name: "Main", agentID: "ea" });
    const first = upsertChannelSummary(db!, channel.id, "first", "chm_1", 100);
    const second = upsertChannelSummary(db!, channel.id, "second", "chm_2", 200);
    // One summary row per channel: the second call updates in place.
    expect(second.id).toBe(first.id);
    expect(getChannelSummary(db!, channel.id)?.summary).toBe("second");
    expect(getChannelSummary(db!, channel.id)?.token_estimate).toBe(200);
  });
});

describe("agent memories schema", () => {
  test("global memories use a NULL agent_id and share a key per scope", () => {
    db = openDatabase(":memory:");
    const global = putAgentMemory(db!, { scope: "global_user", agentID: null, keySlug: "project", content: "Agni", importance: 8 });
    expect(global.agent_id).toBeNull();
    // MEM-002: a changed fact supersedes the old one; the key is not silently
    // overwritten. The old row stays readable by id with its history intact.
    const same = putAgentMemory(db!, { scope: "global_user", agentID: null, keySlug: "project", content: "Agni updated" });
    expect(same.id).not.toBe(global.id);
    expect(same.content).toBe("Agni updated");
    expect(same.supersedes_id).toBe(global.id);
    const perAgent = putAgentMemory(db!, { scope: "agent", agentID: "ea", keySlug: "project", content: "EA scope" });
    expect(perAgent.agent_id).toBe("ea");
    // Same slug, different scope+agent — no collision.
    expect(perAgent.id).not.toBe(global.id);
    // Only live rows are listed; the superseded row is archived.
    expect(listAgentMemories(db!, { scope: "global_user", limit: 10 }).map((row) => row.id)).toEqual([same.id]);
    expect(listAgentMemories(db!, { scope: "agent", agentID: "ea", limit: 10 }).map((row) => row.id)).toEqual([perAgent.id]);
    expect(getAgentMemory(db!, global.id)?.content).toBe("Agni");
    expect(getAgentMemory(db!, global.id)?.valid_to).not.toBeNull();
  });

  test("importance is clamped and tags are normalized", () => {
    db = openDatabase(":memory:");
    const row = putAgentMemory(db!, {
      scope: "global_user", agentID: null, keySlug: "k", content: "c", importance: 99, tags: ["  A ", "a", "B"],
    });
    // Importance is a 0–1 score (schema default 0.5), so 99 clamps to 1.
    expect(row.importance).toBe(1);
    expect(row.tags).toBe("A, B");
  });

  test("invalid content length is rejected", () => {
    db = openDatabase(":memory:");
    expect(() => putAgentMemory(db!, { scope: "global_user", agentID: null, keySlug: "k", content: "x".repeat(20_001) })).toThrow();
    expect(listAgentMemories(db!, { scope: "global_user", limit: 10 })).toEqual([]);
  });
});