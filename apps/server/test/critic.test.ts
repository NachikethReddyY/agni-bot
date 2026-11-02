import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { ToolRegistry } from "../src/tools/registry";
import { registerDraftEmailTool } from "../src/tools/ask-tool";
import { FormBroker, answerFormAndWake } from "../src/agent/form-broker";
import { criticReview } from "../src/agent/critic";
import { resolvePersona, updatePersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const router = () => new Router(
  [{ id: "t", label: "T", baseUrl: "https://t.local/v1", apiKey: "k", model: "m" }], new HealthTracker(),
  (async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fix the date in line 2." } }] })}\n\ndata: [DONE]\n\n`)) as unknown as typeof fetch,
);

async function draft(database: Database): Promise<{ question: string; result: Record<string, unknown> }> {
  let question = "";
  const broker = new FormBroker({
    db: database,
    emit: (frame: ServerFrameBody) => {
      if (frame.type !== "form.request") return;
      question = frame.question;
      answerFormAndWake(database, frame.requestID, "send");
    },
  });
  const registry = new ToolRegistry();
  registerDraftEmailTool(registry, { db: database, broker, review: criticReview(database, router(), 1000, resolvePersona(database, "ea")!) });
  const tool = registry.get("draft_email") as unknown as { handler: (args: unknown, ctx: unknown) => Promise<Record<string, unknown>> };
  const result = await tool.handler({ to: "a@b.c", subject: "Hi", body: "See you on the 31st." }, { threadID: createThread(database, "ea").id, turnID: "u", signal: new AbortController().signal });
  return { question, result };
}

describe("critic pass", () => {
  test("off by default: the card is unchanged", async () => {
    db = openDatabase(":memory:");
    expect(criticReview(db, router(), 1000, resolvePersona(db, "ea")!)).toBeUndefined();
    expect((await draft(db)).question).toBe("Send this email?");
  });

  test("an opted-in bot's draft carries the critic's notes to the owner and the drafter", async () => {
    db = openDatabase(":memory:");
    updatePersona(db, "ea", { critic: "researcher" });
    updatePersona(db, "researcher", { visibility: "shared" });
    const { question, result } = await draft(db);
    expect(question).toContain("Reviewed by Researcher: Fix the date in line 2.");
    expect(result.review).toBe("Fix the date in line 2.");
    expect(result.decision).toBe("send");
  });

  test("a private critic's notes reach the owner only", async () => {
    db = openDatabase(":memory:");
    updatePersona(db, "ea", { critic: "researcher" });
    updatePersona(db, "researcher", { visibility: "private" });
    const { question, result } = await draft(db);
    expect(question).toContain("Fix the date");
    expect(result.review).toBeUndefined();
  });

  test("a bot cannot be its own critic", () => {
    db = openDatabase(":memory:");
    expect(() => updatePersona(db!, "ea", { critic: "ea" })).toThrow();
  });
});
