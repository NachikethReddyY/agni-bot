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
  test("keeps recent messages, updates the summary, and extracts durable facts", async () => {
    const testDB = openDatabase(":memory:");
    db = testDB;
    for (let index = 0; index < 37; index++) {
      appendChannelMessage(testDB, {
        channelID: "main", fromType: index % 2 ? "agent" : "user",
        fromID: index % 2 ? "ea" : "user", text: "message " + index,
      });
    }
    const router = {
      route: async () => ({ text: JSON.stringify({
        updated_summary: "The user is building Agni.",
        upserted_facts: [{ scope: "global_user", type: "fact", key_slug: "project_name", content: "The user's project is Agni.", importance: 0.9 }],
      }) }),
    } as unknown as Router;

    await compactChannelHistory(testDB, router, "main", "ea");

    expect(getChannelSummary(testDB, "main")?.summary).toBe("The user is building Agni.");
    expect(uncompactedMessages(testDB, "main")).toHaveLength(13);
    // TAG-002: what the conversation implies is the agent's own note, never a
    // fact about the owner — the channel holds tool output and web text too.
    const note = listAgentMemories(testDB, { scope: "agent", agentID: "ea", limit: 10 })[0];
    expect(note?.key_slug).toBe("project-name");
    expect(note?.source).toBe("compaction");
    expect(listAgentMemories(testDB, { scope: "global_user", limit: 10 })).toHaveLength(0);
  });
});
