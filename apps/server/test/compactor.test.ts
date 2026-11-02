import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Router } from "../src/models/router";
import { compactChannelHistory } from "../src/agent/compactor";
import { openDatabase } from "../src/db";
import { getChannelSummary, uncompactedMessages, appendChannelMessage } from "../src/stores/channels";
import { listAgentMemories } from "../src/stores/agent-memories";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("channel compaction", () => {
  test("keeps recent messages and updates the summary; facts are the tagger's job", async () => {
    const testDB = openDatabase(":memory:");
    db = testDB;
    fill(testDB);
    const router = {
      // A fenced answer is still JSON (B6).
      route: async () => ({ text: "```json\n" + JSON.stringify({ updated_summary: "The user is building Agni." }) + "\n```" }),
    } as unknown as Router;

    await compactChannelHistory(testDB, router, "main", "ea");

    expect(getChannelSummary(testDB, "main")?.summary).toBe("The user is building Agni.");
    expect(uncompactedMessages(testDB, "main")).toHaveLength(13);
    // One extractor: the compactor writes no memories at all.
    expect(listAgentMemories(testDB, { scope: "agent", agentID: "ea", limit: 10 })).toHaveLength(0);
    expect(listAgentMemories(testDB, { scope: "global_user", limit: 10 })).toHaveLength(0);
  });

  test("a failed parse backs off, and overlapping runs make one call (B6)", async () => {
    const testDB = openDatabase(":memory:");
    db = testDB;
    fill(testDB);
    let calls = 0;
    const bad = { route: async () => { calls += 1; return { text: "not json" }; } } as unknown as Router;
    await compactChannelHistory(testDB, bad, "main", "ea");
    await compactChannelHistory(testDB, bad, "main", "ea");
    expect(calls).toBe(1);

    const other = openDatabase(":memory:");
    fill(other);
    let release!: () => void;
    let slowCalls = 0;
    const slow = {
      route: async () => {
        slowCalls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { text: JSON.stringify({ updated_summary: "s" }) };
      },
    } as unknown as Router;
    const first = compactChannelHistory(other, slow, "main", "ea");
    await compactChannelHistory(other, slow, "main", "ea");
    release();
    await first;
    expect(slowCalls).toBe(1);
    other.close();
  });
});

function fill(testDB: Database): void {
  for (let index = 0; index < 37; index++) {
    appendChannelMessage(testDB, {
      channelID: "main", fromType: index % 2 ? "agent" : "user",
      fromID: index % 2 ? "ea" : "user", text: "message " + index,
    });
  }
}
