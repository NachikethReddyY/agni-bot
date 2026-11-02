/**
 * Search tools. Grep and glob over the scratch directory. The root must
 * really live in scratch (symlinks followed), the walk never follows
 * symlinks, and files visited, bytes read, and the regex are all bounded —
 * these run synchronously, so a timeout cannot interrupt them.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { confineToScratch, scratchDir } from "./write-file";

const MAX_RESULTS = 200;
const MAX_LINE_LENGTH = 2000;
const MAX_ENTRIES = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
// One unbounded quantifier still backtracks O(n²) per line; 500 chars keeps the worst whole walk near a second.
const MAX_TEST_LENGTH = 500;
const MAX_PATTERN_LENGTH = 200;

export interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

export function grep(args: GrepArgs): GrepResult {
  const root = confineToScratch(args.path ?? scratchDir());
  const regex = buildRegex(args.pattern, args.ignoreCase);
  const includeGlob = args.include ? normalizeGlob(args.include) : null;
  const matches: GrepMatch[] = [];
  let bytes = 0;
  const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);

  const truncated = walk(root, (path, size) => {
    if (matches.length >= limit) return false;
    if (includeGlob && !matchGlob(basename(path), includeGlob)) return true;
    if (size > MAX_FILE_BYTES) return true;
    bytes += size;
    if (bytes > MAX_TOTAL_BYTES) return false;
    try {
      const content = readFileSync(path);
      // Skip binary files (null byte = binary)
      if (content.indexOf(0) !== -1) return true;
      const text = content.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= limit) return false;
        const line = lines[i]!;
        if (regex.test(line.slice(0, MAX_TEST_LENGTH))) {
          matches.push({
            path,
            line: i + 1,
            content: line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
          });
        }
      }
    } catch {
      // binary or unreadable — skip
    }
    return true;
  });

  return { matches, truncated };
}

export interface GlobArgs {
  pattern: string;
  path?: string;
  maxResults?: number;
}

export interface GlobResult {
  matches: string[];
  truncated: boolean;
}

export function glob(args: GlobArgs): GlobResult {
  const root = confineToScratch(args.path ?? scratchDir());
  const globRe = normalizeGlob(args.pattern);
  const matches: string[] = [];
  const limit = Math.min(args.maxResults ?? MAX_RESULTS, MAX_RESULTS);

  const truncated = walk(root, (path) => {
    if (matches.length >= limit) return false;
    const rel = path.slice(root.length).replace(/^\/+/, "");
    if (matchGlob(rel, globRe) || matchGlob(basename(path), globRe)) matches.push(rel);
    return true;
  });

  return { matches, truncated };
}

/**
 * The pattern comes from the model, and a sync regex cannot be timed out, so
 * shapes that backtrack catastrophically are refused: quantified groups like
 * `(a+)+`, backreferences, and more than one unbounded quantifier.
 */
function buildRegex(pattern: string, ignoreCase?: boolean): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  const body = pattern.replace(/\\./g, "x");
  if (/\)[*+?{]/.test(body) || /\\[1-9k]/.test(pattern) || (body.match(/[*+]|\{\d*,\}/g) ?? []).length > 1) {
    throw new Error("pattern is too complex: no quantified groups, backreferences, or more than one * or +");
  }
  try {
    return new RegExp(pattern, ignoreCase ? "iu" : "u");
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, ignoreCase ? "iu" : "u");
  }
}

function normalizeGlob(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchGlob(name: string, regex: RegExp): boolean {
  return regex.test(name);
}

/** Walks without following symlinks. Returns true when it stopped early. */
function walk(root: string, visitor: (path: string, size: number) => boolean): boolean {
  const stack: string[] = [root];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return true;
      const full = join(dir, entry);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        stack.push(full);
      } else if (stat.isFile()) {
        if (visitor(full, stat.size) === false) return true;
      }
    }
  }
  return false;
}
