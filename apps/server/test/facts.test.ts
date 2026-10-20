import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import {
  forgetFact,
  getFact,
  recallFact,
  rememberFact,
  updateFact,
} from "../src/tools/facts";
import { memorySearch } from "../src/tools/stores";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("durable facts", () => {
  test("remember_fact writes a tagged fact and recall_fact finds it", () => {
    db = openDatabase(":memory:");
    const created = rememberFact(db, { fact: "User prefers dark mode", tags: ["ui"] });
    expect(created.fact).toBe("User prefers dark mode");
    const found = recallFact(db, { query: "dark mode" });
    expect(found.facts.map((row) => row.fact)).toContain("User prefers dark mode");
    const row = getFact(db, created.id);
    expect(row?.tags).toContain("fact");
    expect(row?.tags).toContain("ui");
  });

  test("recall_fact with no query returns the most recent facts", () => {
    db = openDatabase(":memory:");
    rememberFact(db, { fact: "first" });
    rememberFact(db, { fact: "second" });
    const found = recallFact(db, {});
    expect(found.facts.map((row) => row.fact)).toEqual(["second", "first"]);
  });

  test("forget_fact deletes the fact and recall no longer returns it", () => {
    db = openDatabase(":memory:");
    const created = rememberFact(db, { fact: "temporary" });
    expect(forgetFact(db, { id: created.id }).deleted).toBe(true);
    expect(getFact(db, created.id)).toBeNull();
    expect(recallFact(db, { query: "temporary" }).facts).toEqual([]);
  });

  test("update_fact rewrites text and re-tags", () => {
    db = openDatabase(":memory:");
    const created = rememberFact(db, { fact: "old value" });
    const updated = updateFact(db, created.id, { fact: "new value", tags: ["x"] });
    expect(updated?.fact).toBe("new value");
    expect(getFact(db, created.id)?.tags).toContain("fact");
    expect(getFact(db, created.id)?.tags).toContain("x");
  });

  test("facts land in the semantic agent_memories store", () => {
    db = openDatabase(":memory:");
    const created = rememberFact(db, { fact: "User likes concise answers", keySlug: "answer_style" });
    const updated = rememberFact(db, { fact: "User prefers concise replies", keySlug: "answer_style" });
    expect(updated.id).toBe(created.id);
    const rows = db.query<{ count: number }, []>("SELECT count(*) AS count FROM agent_memories").get();
    expect(rows?.count).toBe(1);
  });

  test("fact text is bounded and empty facts are rejected", () => {
    db = openDatabase(":memory:");
    expect(() => rememberFact(db!, { fact: "" })).toThrow();
    expect(() => rememberFact(db!, { fact: "x".repeat(9_000) })).toThrow();
  });
});

describe("recall beyond the newest 200", () => {
  test("recall_fact and memory search still find the oldest of 201 facts", () => {
    db = openDatabase(":memory:");
    rememberFact(db, { fact: "oldest needle fact" });
    for (let i = 0; i < 200; i++) rememberFact(db, { fact: `filler ${i}` });
    expect(recallFact(db, { query: "needle" }).facts.map((row) => row.fact)).toEqual(["oldest needle fact"]);
    expect(memorySearch(db, { query: "needle" }).memories.map((row) => row.text)).toEqual(["oldest needle fact"]);
  });

  test("query wildcards are matched literally", () => {
    db = openDatabase(":memory:");
    rememberFact(db, { fact: "battery at 100% now" });
    rememberFact(db, { fact: "battery at 1000 now" });
    expect(recallFact(db, { query: "100%" }).facts.map((row) => row.fact)).toEqual(["battery at 100% now"]);
  });
});
