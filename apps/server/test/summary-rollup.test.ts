/**
 * CMP-001: summaries in levels.
 *
 * A block summary says what happened in one session block; a day summary
 * says what happened in a day; an epoch summary says what happened over a
 * week. The rollup is deterministic and idempotent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { compose, rollupSummaries, weekOf } from "../src/jobs/summary-rollup";
import { listSummaries, saveSummary } from "../src/stores/summaries";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("the rollup", () => {
  test("a day summary is the union of the day's block summaries", () => {
    db = openDatabase(":memory:");
    saveSummary(db, {
      conversationID: "cnv_1",
      agentID: "ea",
      level: "block",
      title: "Block one",
      text: "Decided: use SQLite for the ledger. Still open: the Northwind invoice.",
      day: "2026-10-20",
    });
    saveSummary(db, {
      conversationID: "cnv_1",
      agentID: "ea",
      level: "block",
      title: "Block two",
      text: "Decided: use SQLite for the ledger. Decided: ship on Tuesday.",
      day: "2026-10-20",
    });
    const result = rollupSummaries(db);
    expect(result.days).toBe(1);

    const days = listSummaries(db, { conversationID: "cnv_1", level: "day" });
    expect(days).toHaveLength(1);
    expect(days[0]?.text).toContain("ship on Tuesday");
    // The same fact twice is one fact.
    expect(days[0]?.text?.match(/use SQLite/g)?.length).toBe(1);
  });

  test("it is idempotent", () => {
    db = openDatabase(":memory:");
    saveSummary(db, {
      conversationID: "cnv_1",
      agentID: "ea",
      level: "block",
      title: "Block one",
      text: "Decided: use SQLite for the ledger.",
      day: "2026-10-20",
    });
    expect(rollupSummaries(db).days).toBe(1);
    expect(rollupSummaries(db).days).toBe(0);
    expect(listSummaries(db, { level: "day" })).toHaveLength(1);
  });

  test("the days of a week roll up into an epoch", () => {
    db = openDatabase(":memory:");
    for (const day of ["2026-10-19", "2026-10-20", "2026-10-21"]) {
      saveSummary(db, {
        conversationID: "cnv_1",
        agentID: "ea",
        level: "block",
        title: `Block ${day}`,
        text: `Decided: something happened on ${day}.`,
        day,
      });
    }
    rollupSummaries(db);
    const epochs = listSummaries(db, { level: "epoch" });
    expect(epochs).toHaveLength(1);
    expect(epochs[0]?.text).toContain("something happened");
  });

  test("the composition keeps the text bounded and deduplicated", () => {
    const text = compose([
      "Decided: ship on Tuesday morning. Decided: ship on Tuesday morning.",
      "Still open: the invoice.",
    ]);
    expect(text.match(/ship on Tuesday morning/gi)?.length).toBe(1);
    expect(text).toContain("the invoice");
  });

  test("a week starts on Monday", () => {
    expect(weekOf("2026-10-20")).toBe("2026-10-19");
    expect(weekOf("2026-10-25")).toBe("2026-10-19");
    expect(weekOf("2026-10-26")).toBe("2026-10-26");
  });
});
