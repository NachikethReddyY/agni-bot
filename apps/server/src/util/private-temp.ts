import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Secure the directory before writing credentials or privileged scripts. */
export function privateTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    if (process.platform === "win32") {
      const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
      const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error("Could not identify the owner of the private directory.");
      execFileSync("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { stdio: "pipe", windowsHide: true });
    } else {
      chmodSync(directory, 0o700);
    }
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
