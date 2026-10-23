import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { activateAppearanceProfile, deleteAppearanceProfile, listAppearanceProfiles, saveAppearanceProfile } from "../src/stores/appearance";
import type { AppearanceProfile } from "@agni/protocol";

const profile = (id: string, name: string): AppearanceProfile => ({
  version: 1, id, name, mode: "system", preset: "agni", accent: "ember",
  background: { kind: "none" }, textScale: "default", density: "comfortable",
  corners: "standard", motion: "system", agentTint: "full", updatedAt: "2026-10-23T00:00:00.000Z",
});

describe("appearance profiles", () => {
  let db: Database | null = null;
  afterEach(() => { db?.close(); db = null; });

  test("saves, activates, updates, and deletes named profiles", () => {
    db = openDatabase(":memory:");
    saveAppearanceProfile(db, profile("theme_one", "One"));
    saveAppearanceProfile(db, profile("theme_two", "Two"), false);
    expect(listAppearanceProfiles(db).activeID).toBe("theme_one");
    activateAppearanceProfile(db, "theme_two");
    expect(listAppearanceProfiles(db)).toMatchObject({ activeID: "theme_two", profiles: [{ name: "One" }, { name: "Two" }] });
    deleteAppearanceProfile(db, "theme_two");
    expect(listAppearanceProfiles(db)).toMatchObject({ activeID: null, profiles: [{ id: "theme_one" }] });
  });
});
