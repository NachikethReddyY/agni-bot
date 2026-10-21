/**
 * PR 5: privileged commands with the operating system's own authorization.
 *
 * The command goes into a private directory, the authorization dialog shows
 * the command itself, and the script is gone the moment the run ends.
 */
import { describe, expect, test } from "bun:test";
import { statSync, readFileSync, existsSync } from "node:fs";
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
      const dirMode = statSync(dir).mode & 0o777;
      const fileMode = statSync(scriptPath).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o700);
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
