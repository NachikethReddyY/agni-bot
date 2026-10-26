import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { buildTaskToolRegistry } from "../src/tools/task-registry";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

function ctx(peerInput: boolean) {
  return { threadID: "thr_test", turnID: "trn_test", signal: AbortSignal.timeout(1_000), peerInput };
}

function countMemories(): number {
  return db!.query<{ count: number }, []>("SELECT count(*) AS count FROM agent_memories").get()?.count ?? 0;
}

describe("peer-influenced turns refuse durable memory writes", () => {
  test("memory_write with peerInput true returns error and writes nothing", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const tool = registry.get("memory_write");
    if (!tool) throw new Error("memory_write not registered");
    const before = countMemories();
    const result = (await tool.handler({ text: "peer fact", tags: ["t"] } as never, ctx(true))) as Record<string, unknown>;
    expect(result.error).toBe("not saved: this turn started from another agent's message");
    expect(countMemories()).toBe(before);
  });

  test("memory_write with peerInput false writes a row", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const tool = registry.get("memory_write");
    if (!tool) throw new Error("memory_write not registered");
    const before = countMemories();
    const result = (await tool.handler({ text: "owner fact", tags: ["t"] } as never, ctx(false))) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(countMemories()).toBe(before + 1);
  });

  test("remember_fact with peerInput true returns error and writes nothing", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const tool = registry.get("remember_fact");
    if (!tool) throw new Error("remember_fact not registered");
    const before = countMemories();
    const result = (await tool.handler({ fact: "peer remembered fact" } as never, ctx(true))) as Record<string, unknown>;
    expect(result.error).toBe("not saved: this turn started from another agent's message");
    expect(countMemories()).toBe(before);
  });

  test("remember_fact with peerInput false writes a row", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const tool = registry.get("remember_fact");
    if (!tool) throw new Error("remember_fact not registered");
    const before = countMemories();
    const result = (await tool.handler({ fact: "owner remembered fact" } as never, ctx(false))) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(countMemories()).toBe(before + 1);
  });

  test("forget_fact with peerInput true returns error and does not delete", async () => {
    db = openDatabase(":memory:");
    const registry = buildTaskToolRegistry(db);
    const remember = registry.get("remember_fact");
    const forget = registry.get("forget_fact");
    if (!remember || !forget) throw new Error("tools not registered");
    const created = (await remember.handler({ fact: "to be forgotten" } as never, ctx(false))) as { id: string };
    const before = countMemories();
    const result = (await forget.handler({ id: created.id } as never, ctx(true))) as Record<string, unknown>;
    expect(result.error).toBe("not saved: this turn started from another agent's message");
    expect(countMemories()).toBe(before);
  });
});