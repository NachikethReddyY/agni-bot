/**
 * Shell tool. Executes a command (cwd defaults to the scratch directory) and
 * streams stdout/stderr back to the caller. Every command goes through the
 * approval broker (see agent/approval-broker.ts) unless `isReadOnlyCommand`
 * proves it is one read-only program touching only scratch.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { privateTempDir } from "../util/private-temp";
import { isOutsideScratch, scratchDir } from "./write-file";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface BashArgs {
  command: string;
  timeoutMs?: number;
  cwd?: string;
  /**
   * Internal only. `run_privileged` supplies the owner's one-time secret; the
   * model never sees or sets this field.
   */
  secret?: string;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Known-dangerous shapes, kept for warnings only. A denylist cannot gate a
 * shell (`s''udo`, `$HOME`, pipes into interpreters all slip past it); the
 * gate is `isReadOnlyCommand`.
 */
export const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f?|[^-]\S*)\s+\/?(\*|\.\.\/?|~\/?|\/)/, // rm -rf style
  /\brm\s+(-[a-zA-Z]*f?|[^-]\S*)\s+-r/i, // rm -r
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/,
  /\bkill\s+-9\b/, /\bkillall\b/, /\bpkill\b/,
  /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b/, /\bgit\s+checkout\b/,
  /\bchmod\s+777\b/, /\bchown\b/,
  /\bcurl\b.*\|\s*(sudo|bash|sh)\b/, /\bwget\b.*\|\s*(sudo|bash|sh)\b/,
  /\bsudo\b/, /\bsu\b/,
  /\bmount\b/, /\bumount\b/,
  /\bapt(-get)?\s+(install|remove|upgrade)\b/, /\byum\s+(install|remove)\b/, /\bdnf\s+(install|remove)\b/,
  /\bnpm\s+(install|ci|audit)\b/, /\byarn\s+add\b/, /\bpip\s+install\b/,
  /\bgit\s+init\b.*\./,
];

export function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

/** Programs that only read. `env` is out: the daemon's env holds provider keys. */
const READ_ONLY_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "date", "whoami", "uname", "which", "file", "stat", "du", "df"]);
/** Plain words only: no quotes, `$`, `~`, globs, redirection, pipes, or separators. */
const SAFE_WORD = /^[A-Za-z0-9._,:@%+\/-]+$/;
const SAFE_FLAG = /^--?[A-Za-z0-9-]+$/;

/**
 * True only for one simple command whose program is read-only and whose
 * every operand really lives in scratch (relative to `cwd`, symlinks
 * followed). Anything else needs the owner's click.
 */
export function isReadOnlyCommand(command: string, cwd?: string): boolean {
  const dir = cwd ?? scratchDir();
  if (isOutsideScratch(dir)) return false;
  const words = command.trim().split(/[ \t]+/);
  if (!READ_ONLY_PROGRAMS.has(words[0] ?? "")) return false;
  return words.slice(1).every((word) =>
    word.startsWith("-") ? SAFE_FLAG.test(word) : SAFE_WORD.test(word) && !isOutsideScratch(resolve(dir, word)));
}

interface SecretEnv {
  env: Record<string, string>;
  cleanup: () => void;
}

function bashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  // The Windows system32 bash launcher requires WSL. Use the host-native
  // Git Bash so cwd, temporary files, and askpass share the host filesystem.
  const git = Bun.which("git");
  const roots = [
    git ? join(dirname(git), "..") : undefined,
    process.env.ProgramW6432 ? join(process.env.ProgramW6432, "Git") : undefined,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git") : undefined,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Git") : undefined,
  ].filter((path): path is string => !!path);
  const bash = roots.flatMap((root) => [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]).find(existsSync);
  if (!bash) throw new Error("Shell tools on Windows require Git Bash. Install Git for Windows and restart Agni.");
  return bash;
}

function shellPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/**
 * Build a short-lived environment that lets sudo/ssh/git read the owner's
 * password without putting it in argv or the environment. The secret lives in
 * a 0600 file inside a 0700 temp dir; the askpass helper cats it. The dir is
 * removed as soon as the child exits.
 *
 * This is not a boundary against a same-user attacker (nothing in-process is),
 * but it keeps the value out of the model, the transcript, the frame log, and
 * `ps`.
 */
function secretEnv(secret: string): SecretEnv {
  const dir = privateTempDir("agni-secret-");
  const secretPath = join(dir, "secret");
  const askpass = join(dir, "askpass.sh");
  const sudoWrapper = join(dir, "sudo");
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  writeFileSync(askpass, `#!/bin/sh\ncat ${shellQuote(shellPath(secretPath))}\n`, { mode: 0o700 });
  writeFileSync(sudoWrapper, `#!/bin/sh\nexec /usr/bin/sudo -A "$@"\n`, { mode: 0o700 });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    SUDO_ASKPASS: shellPath(askpass),
    SSH_ASKPASS: shellPath(askpass),
    SSH_ASKPASS_REQUIRE: "force",
    GIT_ASKPASS: shellPath(askpass),
  };
  return {
    env,
    cleanup: () => {
      try {
        // Best effort: overwrite before unlinking, then drop the directory.
        writeFileSync(secretPath, Buffer.alloc(Math.max(secret.length, 1)), { mode: 0o600 });
      } catch {
        // The child may already have removed it; the unlink below still runs.
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Temp cleanup is best effort.
      }
    },
  };
}

function redact(text: string, secret: string): string {
  if (!secret) return text;
  const variants = new Set([
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
  ]);
  let result = text;
  for (const variant of variants) {
    if (variant) result = result.split(variant).join("[redacted]");
  }
  return result;
}

export async function runBash(args: BashArgs): Promise<BashResult> {
  const cwd = args.cwd ?? scratchDir();
  // Only scratch is ours to create; any other cwd must already exist.
  if (!isOutsideScratch(cwd)) mkdirSync(cwd, { recursive: true });
  const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000);
  const startedAt = Date.now();
  const executable = bashExecutable();
  const secret = args.secret;
  const secretSetup = secret ? secretEnv(secret) : null;

  return await new Promise<BashResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, ["-c", args.command], {
      cwd,
      env: secretSetup?.env ?? { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as unknown as ChildProcessWithoutNullStreams;

    if (secret) {
      // `sudo -S` and friends read the password from stdin; askpass covers
      // brew/ssh/git. A command that never reads stdin gets EPIPE, ignored.
      child.stdin.on("error", () => {});
      child.stdin.end(`${secret}\n`);
    } else {
      child.stdin.end();
    }

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secretSetup?.cleanup();
      resolve({
        stdout: redact(stdout.trimEnd(), secret ?? ""),
        stderr: redact(stderr.trimEnd(), secret ?? ""),
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]";
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n…[truncated]";
    });
    child.on("error", (error) => {
      stderr += `\n${error instanceof Error ? error.message : String(error)}`;
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
