/**
 * File read tool. Reads a file from the scratch directory and returns its
 * contents (truncated to a sane size). Paths whose real location (symlinks
 * followed) is outside scratch are rejected, so `~/.agni` secrets stay out.
 */
import { readFileSync, statSync } from "node:fs";
import { confineToScratch } from "./write-file";

const MAX_BYTES = 256 * 1024;

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadFileResult {
  path: string;
  size: number;
  content: string;
  truncated: boolean;
  offset: number;
  lines: number;
}

export function readFile(args: ReadFileArgs): ReadFileResult {
  const real = confineToScratch(args.path);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${args.path} is not a file`);
  const content = readFileSync(real, "utf8");
  const lines = content.split("\n");
  const start = Math.max(0, args.offset ?? 0);
  const count = args.limit ?? lines.length;
  const slice = lines.slice(start, start + count).join("\n");
  const truncated = content.length > MAX_BYTES || slice.length >= MAX_BYTES;
  return {
    path: args.path,
    size: stat.size,
    content: slice.length > MAX_BYTES ? `${slice.slice(0, MAX_BYTES)}\n…[truncated]` : slice,
    truncated,
    offset: start,
    lines: lines.length,
  };
}