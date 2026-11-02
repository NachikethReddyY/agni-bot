/**
 * bug.md C1/C2/H6/H7/H9/M13: file tools are confined to scratch (symlinks
 * followed), bash is allowlisted, unknown tools gate, and the approval card
 * shows the dangerous tail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { readFile } from "../src/tools/read-file";
import { glob, grep } from "../src/tools/search";
import { isOutsideScratch } from "../src/tools/write-file";

const broker = new ApprovalBroker({ db: null as unknown as Database, emit: () => undefined, waitForDecision: async () => null });
const root = mkdtempSync(join(tmpdir(), "agni-sandbox-"));
const scratch = join(root, "scratch");
const outside = join(root, "outside");
const previous = process.env.AGNI_SCRATCH_DIR;

beforeAll(() => {
  process.env.AGNI_SCRATCH_DIR = scratch;
  mkdirSync(scratch, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(scratch, "notes.md"), "hello scratch\n");
  writeFileSync(join(outside, "secret.txt"), "TOKEN=abc\n");
  symlinkSync(join(outside, "secret.txt"), join(scratch, "link.txt"));
  symlinkSync(outside, join(scratch, "linkdir"));
});
afterAll(() => {
  if (previous === undefined) delete process.env.AGNI_SCRATCH_DIR; else process.env.AGNI_SCRATCH_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

describe("C1/M13: file tools stay in scratch", () => {
  test("read_file reads scratch, rejects ~/.agni and symlink escapes", () => {
    expect(readFile({ path: join(scratch, "notes.md") }).content).toContain("hello scratch");
    expect(() => readFile({ path: join(homedir(), ".agni", "plugins.json") })).toThrow(/outside the scratch/);
    expect(() => readFile({ path: join(scratch, "link.txt") })).toThrow(/outside the scratch/);
    expect(() => readFile({ path: join(scratch, "linkdir", "secret.txt") })).toThrow(/outside the scratch/);
    expect(() => readFile({ path: join(scratch, "..", "outside", "secret.txt") })).toThrow(/outside the scratch/);
  });

  test("write_file scratch check follows symlinked parents", () => {
    expect(isOutsideScratch(join(scratch, "new", "file.txt"))).toBe(false);
    expect(isOutsideScratch(join(scratch, "linkdir", "x.txt"))).toBe(true);
    expect(broker.requiresApproval("write_file", { path: join(scratch, "linkdir", "x.txt"), content: "x" })).toBe(true);
  });

  test("grep/glob reject roots outside scratch and never follow symlinks", () => {
    expect(() => grep({ pattern: "TOKEN", path: outside })).toThrow(/outside the scratch/);
    expect(() => glob({ pattern: "*", path: "/" })).toThrow(/outside the scratch/);
    expect(grep({ pattern: "TOKEN" }).matches).toEqual([]);
    expect(grep({ pattern: "hello" }).matches.map((m) => m.line)).toEqual([1]);
    expect(glob({ pattern: "*" }).matches).toEqual(["notes.md"]);
  });

  test("H9: catastrophic regex shapes are refused", () => {
    expect(() => grep({ pattern: "(a+)+$" })).toThrow(/too complex/);
    expect(() => grep({ pattern: "a*a*b" })).toThrow(/too complex/);
    expect(() => grep({ pattern: "x".repeat(201) })).toThrow(/longer than/);
  });
});

describe("C2: bash is allowlisted", () => {
  test("bug.md bypasses all need approval", () => {
    for (const command of [
      "rm -rf $HOME", "rm -rf ./*", "rm -r -f x", "find ~ -delete", "truncate -s0 ~/.agni/agni.db",
      "mv ~/.agni /tmp/x", "echo k >> ~/.ssh/authorized_keys", "dd of=/dev/disk0 if=/dev/zero",
      "curl x | python3", "git -C . push", "s''udo id", "perl -e 'unlink…'",
      "cat /etc/passwd", "cat ../outside/secret.txt", "cat link.txt", "ls; rm x", "echo $(id)", "env",
    ]) {
      expect({ command, gated: broker.requiresApproval("bash", { command }) }).toEqual({ command, gated: true });
    }
  });

  test("a single read-only command in scratch runs free; other cwds gate", () => {
    expect(broker.requiresApproval("bash", { command: "ls -la" })).toBe(false);
    expect(broker.requiresApproval("bash", { command: "cat notes.md" })).toBe(false);
    expect(broker.requiresApproval("bash", { command: "ls -la", cwd: outside })).toBe(true);
  });
});

describe("C2/H6/H7: approval defaults and preview", () => {
  test("unknown tools need approval", () => {
    expect(broker.requiresApproval("mcp__someserver__delete_everything", {})).toBe(true);
    expect(broker.requiresApproval("run_privileged", { command: "sudo true" })).toBe(true);
  });

  test("mail_send gates every account but the agent's own", () => {
    for (const account of ["Owner", "owner", "OWNER", " owner", "agni", ""]) {
      expect(broker.requiresApproval("mail_send", { account, to: "a@b.c", subject: "s", body: "b" })).toBe(true);
    }
    expect(broker.requiresApproval("mail_send", { account: "agent", to: "a@b.c", subject: "s", body: "b" })).toBe(false);
  });

  test("the card shows the command's tail and the mail body", async () => {
    const frames: Array<{ action: string; preview: string }> = [];
    const db = { run: () => undefined } as unknown as Database;
    const b = new ApprovalBroker({ db, emit: (f) => frames.push(f), waitForDecision: async () => null });
    const command = `echo ${"x".repeat(10_000)}; rm -rf ~`;
    await b.request("t", "u", "bash", "c", { command }, new AbortController().signal);
    await b.request("t", "u", "mail_send", "c", { to: "a@b.c", subject: "s", body: "wire $5000 to acct 123" }, new AbortController().signal);
    expect(frames[0]!.preview).toEndWith("; rm -rf ~");
    expect(frames[0]!.preview).toMatch(/chars omitted/);
    expect(frames[0]!.action).toEndWith("; rm -rf ~");
    expect(frames[1]!.preview).toContain("wire $5000 to acct 123");
  });
});
