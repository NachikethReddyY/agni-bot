import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { putAgentMemory, listAgentMemories, deleteAgentMemory } from "../src/stores/agent-memories";
import { saveLink, searchLinks, updateLink, deleteLink } from "../src/stores/links";
import { createTask, listTasks, setTaskStatus, snoozeTask } from "../src/stores/tasks";
import { fetchPage } from "../src/tools/fetch-url";
import { JobRunner } from "../src/jobs/runner";
import { registerBriefJob, nextBriefRunAt } from "../src/jobs/brief";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("P2 stores", () => {
  test("memory writes and deletes stay queryable", () => {
    db = openDatabase(":memory:");
    const memory = putAgentMemory(db!, { scope: "global_user", agentID: null, keySlug: "passport-renewal", content: "Passport renewal in March", tags: ["travel"] });
    const rows = listAgentMemories(db!, { scope: "global_user", limit: 50 });
    expect(rows.some((row) => row.content.includes("Passport") && row.id === memory.id)).toBe(true);
    expect(deleteAgentMemory(db!, memory.id)).toBe(true);
    expect(listAgentMemories(db!, { scope: "global_user", limit: 50 })).toEqual([]);
  });

  test("memory writes roll back together when the insert fails", () => {
    db = openDatabase(":memory:");
    expect(() => putAgentMemory(db!, { scope: "global_user", agentID: null, keySlug: "x", content: "a".repeat(20_001) })).toThrow();
    expect(db!.query<{ count: number }, []>("SELECT count(*) AS count FROM agent_memories").get()?.count).toBe(0);
  });

  test("links canonicalize and merge duplicate notes while indexing updates", () => {
    db = openDatabase(":memory:");
    const first = saveLink(db, { url: "https://Example.com/article/#section", title: "Article", note: "Read this" });
    const duplicate = saveLink(db, { url: "https://example.com/article", note: "Check chart", tags: ["research"] });
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.note).toBe("Read this\nCheck chart");
    expect(searchLinks(db, "chart")[0]?.url).toBe("https://example.com/article");
    updateLink(db, first.id, { title: "Updated article" });
    expect(searchLinks(db, "Updated")[0]?.id).toBe(first.id);
    expect(deleteLink(db, first.id)).toBe(true);
    expect(searchLinks(db, "Updated")).toEqual([]);
  });

  test("tasks validate values, order due dates, and persist transitions", () => {
    db = openDatabase(":memory:");
    const later = createTask(db, { title: "Later", dueAt: "2027-01-02T12:00:00Z" });
    const sooner = createTask(db, { title: "Sooner", dueAt: "2027-01-01T12:00:00Z", priority: "high" });
    expect(listTasks(db).map((row) => row.id)).toEqual([sooner.id, later.id]);
    expect(() => createTask(db!, { title: "Bad", priority: "critical" as never })).toThrow("invalid task priority");
    const snoozed = snoozeTask(db, sooner.id, "2099-01-01T12:00:00Z");
    expect(snoozed?.status).toBe("snoozed");
    expect(setTaskStatus(db, sooner.id, "done")?.status).toBe("done");
    expect(setTaskStatus(db, sooner.id, "open")?.snoozed_until).toBeNull();
  });

  test("page fetch rejects loopback URLs before making a request", async () => {
    await expect(fetchPage("http://127.0.0.1/private")).rejects.toThrow("private or reserved address blocked");
  });

  test("brief runs once per local date and includes due tasks", async () => {
    db = openDatabase(":memory:");
    createTask(db, { title: "Renew insurance", dueAt: "2026-10-17T10:00:00Z" });
    const emitted: unknown[] = [];
    const runner = new JobRunner(db, (frame) => emitted.push(frame), { pollMs: 1000 });
    registerBriefJob(runner, { db, emit: (frame) => emitted.push(frame), timeZone: "Asia/Singapore" });
    db.run("UPDATE jobs SET run_at=? WHERE kind='brief'", [new Date().toISOString()]);
    await runner.tick();
    const message = db.query<{ text: string }, []>("SELECT text FROM messages WHERE text LIKE 'Morning brief%' LIMIT 1").get();
    expect(message?.text).toContain("Renew insurance");
    expect(emitted.filter((frame) => (frame as { type?: string }).type === "notify")).toHaveLength(1);
    const threadCount = db.query<{ count: number }, []>("SELECT count(*) AS count FROM threads").get()?.count;
    db.run("UPDATE jobs SET run_at=? WHERE kind='brief'", [new Date().toISOString()]);
    await runner.tick();
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM threads").get()?.count).toBe(threadCount);
    expect(emitted.filter((frame) => (frame as { type?: string }).type === "notify")).toHaveLength(1);
  });

  test("brief schedule follows the configured local timezone", () => {
    const runAt = nextBriefRunAt(new Date("2026-10-16T00:00:00Z"), "Asia/Singapore");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(runAt))).toBe("07:55");
  });
});
