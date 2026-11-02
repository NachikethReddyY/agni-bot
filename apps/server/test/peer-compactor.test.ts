import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Router } from "../src/models/router";
import { compactChannelHistory } from "../src/agent/compactor";
import { openDatabase } from "../src/db";
import { appendChannelMessage } from "../src/stores/channels";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("peer compactor filtering", () => {
  test("system-role row with marker must not appear in prompt sent to model", async () => {
    const testDB = openDatabase(":memory:");
    db = testDB;
    // Add enough messages to trigger compaction (> COMPACT_AT)
    for (let index = 0; index < 40; index++) {
      if (index === 2) {
        appendChannelMessage(testDB, {
          channelID: "main",
          fromType: "system",
          fromID: "sys",
          text: `E2E-COMPACT-BRIEF`,
        });
      } else if (index === 3) {
        appendChannelMessage(testDB, {
          channelID: "main",
          fromType: "user",
          fromID: "user",
          text: "OWNER-NOTE",
        });
      } else {
        appendChannelMessage(testDB, {
          channelID: "main",
          fromType: index % 2 ? "agent" : "user",
          fromID: index % 2 ? "ea" : "user",
          text: `message ${index}`,
        });
      }
    }
    let capturedPrompt = "";
    const router = {
      route: async (req: any) => {
        capturedPrompt = req.messages?.[0]?.content ?? "";
        return { text: JSON.stringify({ updated_summary: "Summary.", upserted_facts: [] }) };
      },
    } as unknown as Router;

    await compactChannelHistory(testDB, router, "main", "ea");

    expect(capturedPrompt.includes("E2E-COMPACT-BRIEF")).toBe(false);
    expect(capturedPrompt.includes("OWNER-NOTE")).toBe(true);
  });
});
