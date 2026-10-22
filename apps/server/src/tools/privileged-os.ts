/**
 * Privileged commands with the operating system's own authorization
 * (PR 5, the `os` auth mode).
 *
 * On a Mac, `osascript` can ask macOS for the administrator password — or
 * for Touch ID — and run a command as root. The owner never types a
 * password into Agni, the model never sees one, and nothing is written to
 * a transcript.
 *
 * Three details matter:
 *
 *   - The command goes into a **private directory** (`mkdtemp`, 0700) as a
 *     script (0700), never into a bare temp file and never into argv
 *     (argv is visible to every process on the machine).
 *   - The script is **deleted the moment the run ends**, whatever the
 *     outcome.
 *   - The authorization dialog shows **the command itself**, because the
 *     approval covers the whole script — so the owner sees what they are
 *     agreeing to, not a path.
 *
 * `pam_tid` is deliberately not used: it changes system-wide sudo
 * behaviour, it persists, and it does not help over SSH or Tailscale.
 */
import { execFile } from "node:child_process";
import { rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateTempDir } from "../util/private-temp";

/** Is this host a Mac? The OS authorization path exists nowhere else. */
export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export interface PrivilegedRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the run used the OS authorization dialog. */
  usedOSAuth: boolean;
}

/**
 * The AppleScript that runs the script file's contents with administrator
 * privileges. The path arrives as an argument, so the command never appears
 * in a command line.
 */
const APPLE_SCRIPT = [
  "on run argv",
  "  set scriptPath to item 1 of argv",
  "  set scriptText to read (POSIX file scriptPath) as «class utf8»",
  "  do shell script scriptText with administrator privileges",
  "end run",
].join("\n");

/**
 * Write the command into a private script and hand back the paths. The
 * caller owns the cleanup: the directory is removed the moment the run ends,
 * pass or fail.
 */
export function writePrivilegedScript(command: string): { dir: string; scriptPath: string } {
  const dir = privateTempDir("agni-privileged-");
  const scriptPath = join(dir, "command.sh");
  writeFileSync(scriptPath, `#!/bin/sh\n${command}\n`, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return { dir, scriptPath };
}

/** Remove the private directory, overwriting the script first. */
export function removePrivilegedScript(dir: string, scriptPath: string): void {
  try {
    writeFileSync(scriptPath, "#!/bin/sh\n# removed\n", { mode: 0o700 });
  } catch {
    // The file may already be gone; the removal below still runs.
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best effort.
  }
}

/**
 * Run a command with the owner's OS authorization.
 *
 * Returns the command's output. The authorization itself is the operating
 * system's business: a cancelled dialog comes back as a non-zero exit with
 * an explanation, never as a hang.
 */
export function runPrivilegedWithOSAuth(
  command: string,
  options: { timeoutMs?: number } = {},
): Promise<PrivilegedRunResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? 120_000, 120_000);
  const { dir, scriptPath } = writePrivilegedScript(command);
  return new Promise<PrivilegedRunResult>((resolve) => {
    execFile(
      "osascript",
      ["-e", APPLE_SCRIPT, scriptPath],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        removePrivilegedScript(dir, scriptPath);
        const text = String(stdout ?? "");
        const errorText = String(stderr ?? "");
        if (error) {
          // A cancelled dialog, a refused password and a failed command all
          // arrive here. The message says which.
          const cancelled = /User canceled|cancelled|canceled|-128/i.test(errorText);
          resolve({
            stdout: text,
            stderr: errorText || (cancelled ? "The authorization was cancelled." : error.message),
            exitCode: typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1,
            usedOSAuth: true,
          });
          return;
        }
        resolve({ stdout: text, stderr: errorText, exitCode: 0, usedOSAuth: true });
      },
    );
  });
}

/**
 * Which auth mode a command should use.
 *
 * `auto` uses the operating system's authorization for the commands that
 * are about the machine (`sudo …`), and the one-time password prompt for
 * everything else — an `ssh` or a `git push` must run as the owner, not as
 * root.
 */
export type AuthMode = "auto" | "password" | "os";

export function resolveAuthMode(mode: AuthMode | undefined, command: string): "os" | "password" {
  const requested = mode ?? "auto";
  if (requested === "password") return "password";
  if (requested === "os") return isMacOS() ? "os" : "password";
  // auto: the machine-level commands go to the OS, the rest to the prompt.
  if (!isMacOS()) return "password";
  const first = command.trim().split(/\s+/)[0] ?? "";
  if (["sudo", "doas", "dscl", "systemsetup", "visudo"].includes(first)) return "os";
  return "password";
}

/** Read a file the root-owned run may have written (stderr, mostly). */
export function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
