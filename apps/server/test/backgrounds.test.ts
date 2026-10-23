import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken } from "../src/auth/tokens";
import { backgroundRequest } from "../src/appearance/http";
import { openDatabase } from "../src/db";
import { saveAppearanceProfile } from "../src/stores/appearance";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const png = () => new File([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")], "pixel.png", { type: "image/png" });

test("background images require auth and cannot be deleted while a theme uses them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agni-background-test-")); paths.push(directory);
  const dbPath = join(directory, "agni.sqlite");
  const db = openDatabase(dbPath);
  try {
    const { token } = await mintToken(db, "background-test");
    expect((await backgroundRequest(new Request("http://localhost/backgrounds"), db, dbPath)).status).toBe(401);
    const body = new FormData(); body.append("file", png());
    const uploaded = await backgroundRequest(new Request("http://localhost/backgrounds", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body }), db, dbPath);
    expect(uploaded.status).toBe(201);
    const { id } = await uploaded.json() as { id: string };
    const authorized = { Authorization: `Bearer ${token}` };
    expect((await backgroundRequest(new Request(`http://localhost/backgrounds/${id}`, { headers: authorized }), db, dbPath)).status).toBe(200);
    saveAppearanceProfile(db, { version: 1, id: "theme_image", name: "Image", mode: "dark", preset: "agni", accent: "ember", background: { kind: "image", assetID: id, fit: "cover", positionX: 50, positionY: 50, dim: 0.7, blur: 0 }, textScale: "default", density: "comfortable", corners: "standard", motion: "system", agentTint: "full", updatedAt: "2026-10-23T00:00:00.000Z" });
    expect((await backgroundRequest(new Request(`http://localhost/backgrounds/${id}`, { method: "DELETE", headers: authorized }), db, dbPath)).status).toBe(409);
  } finally { db.close(); }
});
