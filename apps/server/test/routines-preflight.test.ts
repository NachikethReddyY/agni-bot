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

  test.each(["DELETE FROM x", "SELECT 1; DELETE FROM x", "SELECT * FROM x ATTACH DATABASE 'x' AS y", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c"]) (
    "rejects unsafe SQL: %s", async (query) => {
      const db = openDB();
      try { await expect(runPreflight({ kind: "sql", query }, db, null)).rejects.toThrow(); }
      finally { db.close(); }
    },
  );
});

describe("runPreflight HTTP", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("a redirect to a private address is refused before that hop is requested", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    }) as unknown as typeof fetch;
    const db = new Database(":memory:");
    try {
      await expect(runPreflight({ kind: "http", url: "http://8.8.8.8/status" }, db, null)).rejects.toThrow("private or reserved address blocked");
      expect(requested).toEqual(["http://8.8.8.8/status"]);
    } finally { db.close(); }
  });

  test("a 200 with an ETag uses the ETag as the hash", async () => {
    globalThis.fetch = (async () => new Response("body", { status: 200, headers: { etag: '"v1"' } })) as unknown as typeof fetch;
    const db = new Database(":memory:");
    try {
      expect(await runPreflight({ kind: "http", url: "https://93.184.216.34/" }, db, null)).toEqual({ changed: true, hash: '"v1"' });
    } finally { db.close(); }
  });
});
