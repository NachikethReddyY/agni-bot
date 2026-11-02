/**
 * File write tool. Writes content to any path, creating parent directories as
 * needed. There is no enforced sandbox here — the guard is policy, not
 * mechanism: `ApprovalBroker.requiresApproval` routes writes *outside* the
 * scratch tree through the approval card, and lets scratch writes run free
 * (AGENTS.md). `isOutsideScratch` is the boundary check both sides share.
 */
import { lstatSync, mkdirSync, realpathSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homePath } from "../home";

const MAX_BYTES = 1024 * 1024;

/**
 * The tree the owner has declared safe for ungated writes. Defaults to
 * `~/.agni/scratch`; `AGNI_SCRATCH_DIR` overrides it (bb-1 keeps scratch on a
 * separate volume). An absolute `AGNI_SCRATCH_DIR` is used as given.
 */
export function scratchDir(): string {
  const configured = process.env.AGNI_SCRATCH_DIR;
  return resolve(configured && configured.length > 0 ? configured : homePath("scratch"));
}

/**
 * The real path `path` names: symlinks are followed through its nearest
 * existing ancestor, and the missing tail is appended. Null for a dangling
 * symlink, whose real target cannot be known. Relative paths resolve against
 * the process cwd, like the file tools themselves.
 */
function realTarget(path: string): string | null {
  let target = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(target), ...tail.reverse());
    } catch {
      try { lstatSync(target); return null; } catch { /* missing: walk up */ }
    }
    const parent = dirname(target);
    if (parent === target) return join(target, ...tail.reverse());
    tail.push(basename(target));
    target = parent;
  }
}

/** True when `path` really lives outside the scratch tree (symlinks followed). */
export function isOutsideScratch(path: string): boolean {
  if (path.trim().length === 0) return true;
  const target = realTarget(path);
  const scratch = realTarget(scratchDir());
  if (!target || !scratch) return true;
  return target !== scratch && !target.startsWith(scratch.endsWith(sep) ? scratch : scratch + sep);
}

/** The real path of `path`, or a throw when it escapes the scratch tree. */
export function confineToScratch(path: string): string {
  if (isOutsideScratch(path)) throw new Error(`${path} is outside the scratch directory`);
  return realTarget(path)!;
}

export interface WriteFileArgs {
  path: string;
  content: string;
  append?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export function writeFile(args: WriteFileArgs): WriteFileResult {
  if (args.content.length > MAX_BYTES) throw new Error("content exceeds 1 MB");
  let created = false;
  try { statSync(args.path); } catch { created = true; }
  mkdirSync(join(args.path, ".."), { recursive: true });
  if (args.append) {
    const existing = created ? "" : require("node:fs").readFileSync(args.path, "utf8");
    writeFileSync(args.path, existing + args.content, { flag: "w" });
  } else {
    writeFileSync(args.path, args.content, { flag: "w" });
  }
  return { path: args.path, bytesWritten: args.content.length, created };
}