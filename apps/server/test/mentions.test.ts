import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { resolveAgentMention } from "../src/agent/mentions";
import { renameAgent } from "../src/agent/identity";

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

describe("agent mentions", () => {
  test("a leading @id routes to that agent and strips the mention", () => {
    db = openDatabase(":memory:");
    const mention = resolveAgentMention(db, "@researcher find the source of the delay");
    expect(mention?.agentID).toBe("researcher");
    expect(mention?.text).toBe("find the source of the delay");
  });

  test("the live display name and punctuation both work", () => {
    db = openDatabase(":memory:");
    renameAgent(db, "researcher", "Friday");
    const mention = resolveAgentMention(db, "  @Friday, write the email for me");
    expect(mention?.agentID).toBe("researcher");
    expect(mention?.text).toBe("write the email for me");
  });

  test("the longest name wins, so multi-word names are not truncated", () => {
    db = openDatabase(":memory:");
    renameAgent(db, "researcher", "Research Bot");
    const mention = resolveAgentMention(db, "@Research Bot summarize this");
    expect(mention?.agentID).toBe("researcher");
    expect(mention?.text).toBe("summarize this");
  });

  test("the legacy agni alias resolves to the executive assistant", () => {
    db = openDatabase(":memory:");
    expect(resolveAgentMention(db, "@agni hi")?.agentID).toBe("ea");
  });

  test("an unknown mention or a longer word is not a route", () => {
    db = openDatabase(":memory:");
    expect(resolveAgentMention(db, "@nobody hi")).toBeNull();
    expect(resolveAgentMention(db, "@researcherish hi")).toBeNull();
    expect(resolveAgentMention(db, "email @researcher")).toBeNull();
  });
});
