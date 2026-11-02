import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { createThread, createTurn } from "../src/stores/threads";
import { CORE_TOOLS } from "../src/tools/task-registry";
import { MIN_TURNS, reviewHarness, saveProposals, toolUsage } from "../src/jobs/harness-review";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

const NOW = new Date("2026-10-30T12:00:00.000Z");
const RECENT = "2026-10-29T12:00:00.000Z";

function seedTurn(database: Database, threadID: string, index: number, options: { stop?: string; at?: string } = {}): string {
  const id = `trn_${index}`;
  createTurn(database, { id, threadID, agentID: "ea" });
  database.run("UPDATE turns SET state = 'done', stop_reason = ?, started_at = ? WHERE id = ?", [options.stop ?? "end", options.at ?? RECENT, id]);
  return id;
}

let callIndex = 0;
function seedCall(database: Database, threadID: string, turnID: string, tool: string, options: { ok?: boolean; args?: unknown } = {}): void {
  callIndex += 1;
  database.run(
    "INSERT INTO tool_calls (id, thread_id, turn_id, call_id, tool_name, args, result, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    [`tc_${callIndex}`, threadID, turnID, `c${callIndex}`, tool, JSON.stringify(options.args ?? {}), options.ok === false ? 0 : 1, `${RECENT.slice(0, 19)}.${String(callIndex).padStart(3, "0")}Z`],
  );
}

/** 40 turns: mail_search in 10 (8 loaded first), web_fetch failing, a made-up tool, 5 timeouts. */
function seedBusyFortnight(database: Database): void {
  const thread = createThread(database, "ea");
  for (let index = 0; index < 40; index += 1) {
    const turn = seedTurn(database, thread.id, index, { stop: index < 5 ? "timeout" : "end" });
    if (index < 10) {
      if (index < 8) seedCall(database, thread.id, turn, "load_tools", { args: { names: ["mail_search"] } });
      seedCall(database, thread.id, turn, "mail_search");
      seedCall(database, thread.id, turn, "hack_the_planet", { ok: false });
    }
    if (index < 12) seedCall(database, thread.id, turn, "web_fetch", { ok: index >= 5 });
    for (const tool of CORE_TOOLS) if (tool !== "delegate_task" && index === 20) seedCall(database, thread.id, turn, tool);
  }
}

describe("the harness review", () => {
  test("too few turns proposes nothing", () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    for (let index = 0; index < MIN_TURNS - 1; index += 1) {
      seedCall(db, thread.id, seedTurn(db, thread.id, index), "mail_search");
    }
    expect(reviewHarness(db, { now: NOW })).toEqual([]);
  });

  test("usage counts turns, loads, and failures", () => {
    db = openDatabase(":memory:");
    seedBusyFortnight(db);
    const report = toolUsage(db, "2026-10-16T00:00:00.000Z");
    expect(report.turns).toBe(40);
    expect(report.timeouts).toBe(5);
    expect(report.tools.get("mail_search")).toEqual({ turns: 10, loaded: 8, calls: 10, failures: 0 });
    // web_fetch is core, so turn 20 calls it once more.
    expect(report.tools.get("web_fetch")).toEqual({ turns: 13, loaded: 0, calls: 13, failures: 5 });
    expect(report.tools.has("load_tools")).toBe(false);
  });

  test("it proposes from the evidence, and never for a made-up tool", () => {
    db = openDatabase(":memory:");
    seedBusyFortnight(db);
    const proposals = reviewHarness(db, { now: NOW });
    const keys = proposals.map((proposal) => `${proposal.kind}:${proposal.subject}`).sort();
    expect(keys).toEqual([
      "demote_core:delegate_task",
      "promote_core:mail_search",
      "tool_failing:web_fetch",
      "turn_timeouts:*",
    ]);
    expect(proposals.find((proposal) => proposal.kind === "promote_core")?.evidence).toEqual({ turns: 40, used: 10, loaded: 8 });
    expect(keys.some((key) => key.includes("hack_the_planet"))).toBe(false);
  });

  test("turns outside the window are not evidence", () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, "ea");
    for (let index = 0; index < 40; index += 1) {
      seedCall(db, thread.id, seedTurn(db, thread.id, index, { at: "2026-09-01T00:00:00.000Z" }), "mail_search");
    }
    expect(reviewHarness(db, { now: NOW })).toEqual([]);
  });

  test("a pending proposal gets fresh evidence; a rejected one stays rejected", () => {
    db = openDatabase(":memory:");
    saveProposals(db, [
      { kind: "promote_core", subject: "mail_search", evidence: { used: 1 } },
      { kind: "promote_core", subject: "grep", evidence: { used: 1 } },
    ]);
    db.run("UPDATE harness_proposals SET status = 'rejected' WHERE subject = 'grep'");
    saveProposals(db, [
      { kind: "promote_core", subject: "mail_search", evidence: { used: 2 } },
      { kind: "promote_core", subject: "grep", evidence: { used: 2 } },
    ]);
    const rows = db
      .query<{ subject: string; status: string; evidence: string }, []>("SELECT subject, status, evidence FROM harness_proposals ORDER BY subject")
      .all();
    expect(rows).toEqual([
      { subject: "grep", status: "rejected", evidence: '{"used":1}' },
      { subject: "mail_search", status: "pending", evidence: '{"used":2}' },
    ]);
  });
});
