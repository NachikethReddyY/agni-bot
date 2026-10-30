import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginsFile, savePluginsFile } from "../src/plugins/config";

const dir = () => mkdtempSync(join(tmpdir(), "agni-plugins-config-"));

describe("plugins.json", () => {
  test("a corrupt file loads empty but is never saved over", () => {
    const path = join(dir(), "plugins.json");
    writeFileSync(path, '{"version":1,"plugins":{"gmail":{"auth":{"pass":"se');
    const config = loadPluginsFile(path);
    expect(config.plugins).toEqual({});
    expect(() => savePluginsFile(path, config)).toThrow(/refusing/);
    expect(readFileSync(path, "utf-8")).toContain('"pass":"se');
    expect(readFileSync(`${path}.corrupt`, "utf-8")).toContain('"pass":"se');
  });

  test("save creates a private dir and forces the file to 0600, even if it was 0644", () => {
    const path = join(dir(), "nested", "plugins.json");
    savePluginsFile(path, { version: 1, plugins: {} });
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    writeFileSync(path, "{}", { mode: 0o644 });
    chmodSync(path, 0o644);
    savePluginsFile(path, { version: 1, plugins: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadPluginsFile(path).version).toBe(1);
  });
});
