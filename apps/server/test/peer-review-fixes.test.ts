import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { compactChannelHistory } from "../src/agent/compactor";
import { appendChannelMessage, uncompactedMessages } from "../src/stores/channels";

const provider: ProviderConfig = { id: "peer-test", label: "Peer test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock" };

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("peer rows never starve or feed compaction", () => {
  test("system rows are excluded before the limit, so real messages still compact", () => {
    db = openDatabase(":memory:");
    for (let index = 0; index < 200; index += 1) {
      appendChannelMessage(db, { channelID: "main", fromType: "system", fromID: "ea", text: `brief ${index}`, uiHint: "normal" });
    }
    appendChannelMessage(db, { channelID: "main", fromType: "user", fromID: "owner", text: "real message", uiHint: "normal" });
    expect(uncompactedMessages(db, "main", 200).map((row) => row.text)).toEqual(["real message"]);
  });

  test("a peer-influenced turn gets no compaction at all", async () => {
    db = openDatabase(":memory:");
    let modelCalled = false;
    const fetchStub = async (): Promise<Response> => {
      modelCalled = true;
      return new Response("", { status: 500 });
    };
    const router = new Router([provider], new HealthTracker(), fetchStub as unknown as typeof fetch);
    await compactChannelHistory(db, router, "main", "ea", true);
    expect(modelCalled).toBe(false);
  });
});
