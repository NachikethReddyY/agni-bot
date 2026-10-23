/**
 * PR 5: privileged commands with the operating system's own authorization.
 *
 * The command goes into a private directory, the authorization dialog shows
 * the command itself, and the script is gone the moment the run ends.
 */
import { describe, expect, test } from "bun:test";
import { statSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  isMacOS,
  removePrivilegedScript,
  resolveAuthMode,
  writePrivilegedScript,
} from "../src/tools/privileged-os";

describe("the private script", () => {
  test("it lives in a private directory and is not world readable", () => {
    const { dir, scriptPath } = writePrivilegedScript("sudo rm -rf /tmp/thing");
    try {
      if (process.platform === "win32") {
        const identity = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
        const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
        expect(sid).toBeDefined();
        for (const path of [dir, scriptPath]) {
          const aclFile = join(dir, "acl.txt");
          execFileSync("icacls", [path, "/save", aclFile, "/q"], { stdio: "pipe", windowsHide: true });
          const acl = readFileSync(aclFile, "utf16le");
          const entries = acl.match(/\([^)]*\)/g) ?? [];
          expect(entries.length).toBeGreaterThan(0);
          for (const entry of entries) {
            expect(entry.startsWith("(A;")).toBe(true);
            expect(entry).toContain(`;FA;;;${sid})`);
          }
        }
      } else {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(scriptPath).mode & 0o777).toBe(0o700);
      }
      // The command is in the file, not in a command line.
      expect(readFileSync(scriptPath, "utf8")).toContain("sudo rm -rf /tmp/thing");
    } finally {
      removePrivilegedScript(dir, scriptPath);
    }
  });

  test("it is gone the moment the run ends", () => {
    const { dir, scriptPath } = writePrivilegedScript("echo hi");
    expect(existsSync(scriptPath)).toBe(true);
    removePrivilegedScript(dir, scriptPath);
    expect(existsSync(scriptPath)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("two runs never share a directory", () => {
    const first = writePrivilegedScript("echo one");
    const second = writePrivilegedScript("echo two");
    expect(first.dir).not.toBe(second.dir);
    removePrivilegedScript(first.dir, first.scriptPath);
    removePrivilegedScript(second.dir, second.scriptPath);
  });
});

describe("which authorization a command uses", () => {
  test("the owner can ask for the password prompt explicitly", () => {
    expect(resolveAuthMode("password", "sudo ls")).toBe("password");
    expect(resolveAuthMode("password", "git push")).toBe("password");
  });

  test("auto sends machine-level commands to the OS and the rest to the prompt", () => {
    const expected = isMacOS() ? "os" : "password";
    expect(resolveAuthMode("auto", "sudo systemsetup -setpasswd")).toBe(expected);
    // A command that must run as the owner never becomes root.
    expect(resolveAuthMode("auto", "git push origin main")).toBe("password");
    expect(resolveAuthMode("auto", "ssh deploy@example.com")).toBe("password");
  });

  test("os is only available where the operating system offers it", () => {
    const expected = isMacOS() ? "os" : "password";
    expect(resolveAuthMode("os", "sudo ls")).toBe(expected);
  });

  test("auto is the default", () => {
    expect(resolveAuthMode(undefined, "ls")).toBe("password");
  });
});
