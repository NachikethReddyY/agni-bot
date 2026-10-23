import type { Database } from "bun:sqlite";
import { AppearanceProfileSchema, type AppearanceProfile } from "@agni/protocol";

interface ProfileRow { id: string; profile_json: string }

export function listAppearanceProfiles(db: Database): { profiles: AppearanceProfile[]; activeID: string | null } {
  const profiles = db.query<ProfileRow, []>("SELECT id, profile_json FROM appearance_profiles ORDER BY updated_at DESC").all()
    .flatMap((row) => {
      try { return [AppearanceProfileSchema.parse(JSON.parse(row.profile_json))]; }
      catch { return []; }
    });
  const state = db.query<{ active_profile_id: string | null }, []>("SELECT active_profile_id FROM appearance_state WHERE singleton = 1").get();
  return { profiles, activeID: state?.active_profile_id ?? null };
}

export function saveAppearanceProfile(db: Database, profile: AppearanceProfile, activate = true): void {
  const parsed = AppearanceProfileSchema.parse(profile);
  db.transaction(() => {
    db.run(`INSERT INTO appearance_profiles (id, profile_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
      [parsed.id, JSON.stringify(parsed), parsed.updatedAt]);
    if (activate) db.run("UPDATE appearance_state SET active_profile_id = ? WHERE singleton = 1", [parsed.id]);
  })();
}

export function activateAppearanceProfile(db: Database, id: string): void {
  if (!db.query("SELECT 1 FROM appearance_profiles WHERE id = ?").get(id)) throw new Error("Appearance profile not found.");
  db.run("UPDATE appearance_state SET active_profile_id = ? WHERE singleton = 1", [id]);
}

export function deleteAppearanceProfile(db: Database, id: string): void {
  db.run("DELETE FROM appearance_profiles WHERE id = ?", [id]);
}
