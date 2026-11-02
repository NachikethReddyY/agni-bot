import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHomeEnv, migrateHomeLayout, parseEnvFile } from "../src/home";

describe("parseEnvFile", () => {
  test("reads keys, strips comments and quotes", () => {
    expect(parseEnvFile([
      "# comment",
      "AGNI_HOST=127.0.0.1          # dev: loopback",
      'A="quoted # kept"',
      "export B='x'",
      "EMPTY=",
      "not a line",
    ].join("\n"))).toEqual({ AGNI_HOST: "127.0.0.1", A: "quoted # kept", B: "x", EMPTY: "" });
  });
});

describe("loadHomeEnv", () => {
  test("fills unset or empty keys only", () => {
    const home = mkdtempSync(join(tmpdir(), "agni-home-"));
    writeFileSync(join(home, "config.env"), "SET=file\nEMPTY=file\nNEW=file\n");
    const env: Record<string, string | undefined> = { AGNI_HOME: home, SET: "shell", EMPTY: "" };
    loadHomeEnv(env);
    expect(env).toMatchObject({ SET: "shell", EMPTY: "file", NEW: "file" });
  });
});

describe("migrateHomeLayout", () => {
  test("moves the old layout into place once", () => {
    const home = mkdtempSync(join(tmpdir(), "agni-home-"));
    const repo = mkdtempSync(join(tmpdir(), "agni-repo-"));
    writeFileSync(join(home, "agni.sqlite"), "db");
    writeFileSync(join(home, "agni.log"), "log");
    mkdirSync(join(repo, "data"));
    writeFileSync(join(repo, "data", "providers.json"), "{}");
    mkdirSync(join(repo, "scratch"));

    const result = migrateHomeLayout({ AGNI_HOME: home }, repo);
    expect(result.movedFrom.length).toBe(4);
    for (const path of ["data/agni.sqlite", "logs/agni.log", "providers.json", "scratch"]) {
      expect(existsSync(join(home, path))).toBe(true);
    }
    expect(existsSync(join(home, "agni.sqlite"))).toBe(false);
    expect(migrateHomeLayout({ AGNI_HOME: home }, repo).movedFrom).toEqual([]);
  });

  test("respects explicit path overrides and a live old daemon", () => {
    const home = mkdtempSync(join(tmpdir(), "agni-home-"));
    writeFileSync(join(home, "agni.sqlite"), "db");
    expect(migrateHomeLayout({ AGNI_HOME: home, AGNI_DB_PATH: "/x.sqlite" }, home).movedFrom).toEqual([]);

    writeFileSync(join(home, "agni.pid"), JSON.stringify({ pid: process.pid }));
    expect(migrateHomeLayout({ AGNI_HOME: home }, home).blockedByPid).toBe(process.pid);
    expect(existsSync(join(home, "agni.sqlite"))).toBe(true);
  });
});
