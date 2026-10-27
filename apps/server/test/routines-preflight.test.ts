import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight } from "../src/routines/preflight";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function openDB(): Database {
  const dir = mkdtempSync(join(tmpdir(), "agni-preflight-"));
  dirs.push(dir);
  return new Database(join(dir, "test.sqlite"));
}

describe("runPreflight SQL", () => {
  test("unchanged result hash returns changed false", async () => {
    const db = openDB();
    try {
      const first = await runPreflight({ kind: "sql", query: "SELECT 1 AS value" }, db, null);
      expect(first.changed).toBe(true);
      expect(await runPreflight({ kind: "sql", query: "SELECT 1 AS value" }, db, first.hash)).toEqual({ ...first, changed: false });
    } finally { db.close(); }
  });

  test("plain SELECT changes when there is no prior hash", async () => {
    const db = openDB();
    try { expect((await runPreflight({ kind: "sql", query: "SELECT 1" }, db, null)).changed).toBe(true); }
    finally { db.close(); }
  });

  test.each(["DELETE FROM x", "SELECT 1; DELETE FROM x", "SELECT * FROM x ATTACH DATABASE 'x' AS y"]) (
    "rejects unsafe SQL: %s", async (query) => {
      const db = openDB();
      try { await expect(runPreflight({ kind: "sql", query }, db, null)).rejects.toThrow(); }
      finally { db.close(); }
    },
  );
});
