/**
 * The owner's rule (2026-10-19): ask about destructive things, and nothing
 * else. These tests pin the boundary from both sides — the reversible actions
 * an assistant performs constantly must run free, and the irreversible ones
 * must still stop for a click.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { isOutsideScratch, scratchDir } from "../src/tools/write-file";

const broker = new ApprovalBroker({
  db: null as unknown as Database,
  emit: () => undefined,
  waitForDecision: async () => null,
});

describe("approval policy: destructive only", () => {
  test("reversible actions never ask", () => {
    const free: Array<[string, Record<string, unknown>]> = [
      ["rename_agent", { name: "Baahu" }],
      ["deep_research", { query: "grok bot" }],
      ["handoff", { toAgentID: "researcher", task: "research grok bot" }],
      ["web_fetch", { url: "https://example.com" }],
      ["web_search", { query: "grok" }],
      ["memory_write", { text: "prefers short answers" }],
      ["remember_fact", { fact: "likes tea" }],
      ["link_save", { url: "https://example.com" }],
      ["task_create", { title: "file taxes" }],
      ["task_update", { id: "task_1", action: "done" }],
      ["tasks_list", {}],
      // Free because the tools themselves refuse paths outside scratch.
      ["read_file", { path: "/etc/hosts" }],
      ["grep", { pattern: "foo" }],
      ["mail_read", { id: "msg_1" }],
      // The agent's own mailbox is ungated by owner decision (2026-10-17).
      ["mail_send", { account: "agent", to: "a@b.c", subject: "hi" }],
      ["mail_send", { to: "a@b.c", subject: "hi" }],
      // Only a single read-only command inside scratch runs free.
      ["bash", { command: "ls -la" }],
      // Writes inside the declared scratch tree are free.
      ["write_file", { path: join(scratchDir(), "notes.md"), content: "hi" }],
    ] as Array<[string, Record<string, unknown>]>;
    for (const [tool, args] of free) {
      expect({ tool, gated: broker.requiresApproval(tool, args) }).toEqual({ tool, gated: false });
    }
  });

  test("destructive actions still gate", () => {
    const gated: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "rm -rf /tmp/everything" }],
      ["bash", { command: "git clean -fdx" }],
      ["bash", { command: "git push --force origin main" }],
      // Shell is allowlisted, not denylisted: anything not provably read-only asks.
      ["bash", { command: "git status" }],
      ["mail_send", { account: "agni", to: "a@b.c", subject: "hi" }],
      ["write_file", { path: "/etc/hosts", content: "127.0.0.1" }],
      ["write_file", { path: "apps/server/src/index.ts", content: "// clobber" }],
      ["mail_send", { account: "owner", to: "a@b.c", subject: "hi" }],
    ] as Array<[string, Record<string, unknown>]>;
    for (const [tool, args] of gated) {
      expect({ tool, gated: broker.requiresApproval(tool, args) }).toEqual({ tool, gated: true });
    }
  });

  test("scratch membership is a real path test, not a string prefix", () => {
    const scratch = scratchDir();
    expect(isOutsideScratch(join(scratch, "a", "b.txt"))).toBe(false);
    expect(isOutsideScratch(scratch)).toBe(false);
    // A sibling directory that merely shares a prefix must not count as scratch.
    expect(isOutsideScratch(`${scratch}-elsewhere/x.txt`)).toBe(true);
    expect(isOutsideScratch("/")).toBe(true);
    expect(isOutsideScratch("")).toBe(true);
  });
});
