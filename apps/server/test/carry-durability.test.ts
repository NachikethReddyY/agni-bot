/** H30/M41: the carry keeps early decisions; the rollup ladder is not frozen or duplicated. */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import type { Router } from "../src/models/router";
import { CARRY_SUMMARY_CHARS, clampCarry, summarizeBlock } from "../src/agent/rollover";
import { ensureConversation, getConversation, openSession, updateSummary } from "../src/stores/conversations";
import { appendMessage } from "../src/stores/threads";
import { rollupSummaries } from "../src/jobs/summary-rollup";
import { listSummaries, saveSummary } from "../src/stores/summaries";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("the carry", () => {
  test("keeps an early decision after 10 rollovers", async () => {
    db = openDatabase(":memory:");
    // A fake summarizer that does what the prompt asks: merge the running summary with the new block.
    let n = 0;
    const router = {
      route: async (req: { messages: { content: string }[] }) => {
        n += 1;
        const user = req.messages[1]!.content;
        const running = /Running summary so far:\n(.*)/.exec(user)?.[1] ?? "";
        const kept = running.replace(/^Decided: /, "").split("; ").filter(Boolean);
        kept.push(n === 1 ? "EARLY-DECISION use SQLite" : `decision ${n} ${"x".repeat(150)}`);
        return { text: JSON.stringify({ decisions: kept, open_loops: [], entities: [], tone: "", source_turn_range: null }) };
      },
    } as unknown as Router;
    const conversation = ensureConversation(db, "ea");
    for (let i = 0; i < 10; i++) {
      const block = openSession(db, getConversation(db, conversation.id)!, "context", null);
      appendMessage(db, { threadID: block.id, role: "user", text: `turn ${i}` });
      const current = getConversation(db, conversation.id)!;
      const summary = await summarizeBlock({ db, router, firstTokenTimeoutMs: 1000 }, current, block);
      updateSummary(db, conversation.id, summary!.text);
    }
    const carry = getConversation(db, conversation.id)!.summary!;
    expect(carry).toContain("EARLY-DECISION");
    expect(carry).toContain("decision 10");
    expect(carry.length).toBeLessThanOrEqual(CARRY_SUMMARY_CHARS);
  });

  test("clamping keeps head and tail", () => {
    const text = `HEAD ${"a ".repeat(5000)} TAIL`;
    const out = clampCarry(text)!;
    expect(out.length).toBeLessThanOrEqual(CARRY_SUMMARY_CHARS);
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("middle omitted");
  });
});

describe("the rollup ladder", () => {
  const block = (day: string) => ({
    conversationID: "cnv_1", agentID: "ea", level: "block" as const, title: day,
    text: `Decided: something happened on ${day}.`, day,
  });

  test("a partial day is not rolled up", () => {
    db = openDatabase(":memory:");
    saveSummary(db, block("2026-10-30"));
    expect(rollupSummaries(db, { now: new Date("2026-10-30T15:00:00Z") }).days).toBe(0);
    expect(rollupSummaries(db, { now: new Date("2026-10-31T00:30:00Z") }).days).toBe(1);
  });

  test("days past 50 are not duplicated", () => {
    db = openDatabase(":memory:");
    for (let i = 0; i < 70; i++) {
      saveSummary(db, block(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)));
    }
    const now = new Date("2026-12-31T00:00:00Z");
    expect(rollupSummaries(db, { now }).days).toBe(70);
    expect(rollupSummaries(db, { now }).days).toBe(0);
    expect(listSummaries(db, { level: "day", limit: 200 })).toHaveLength(70);
  });
});
