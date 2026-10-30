/**
 * Device tokens. The plaintext token leaves the server exactly once (at
 * `pair`); only its SHA-256 hash is stored. Revocation is a single column.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

const TOKEN_PREFIX = "agni_";

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

export async function mintToken(db: Database, name: string): Promise<{ device: Device; token: string }> {
  const token = `${TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const device: Device = {
    id: newID("dev"),
    name,
    created_at: nowISO(),
    last_seen_at: null,
    revoked_at: null,
  };
  db.run("INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)", [
    device.id,
    device.name,
    await hashToken(token),
    device.created_at,
  ]);
  return { device, token };
}

export async function verifyToken(db: Database, token: string): Promise<Device | null> {
  const row = db
    .query<Device, [string]>(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE token_hash = ?",
    )
    .get(await hashToken(token));
  if (!row || row.revoked_at) return null;
  db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [nowISO(), row.id]);
  return row;
}

export function revokeDevice(db: Database, idOrPrefix: string): Device | null {
  const row = db
    .query<Device, [string, string]>(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE id = ? OR id LIKE ? LIMIT 1",
    )
    .get(idOrPrefix, `${idOrPrefix}%`);
  if (!row) return null;
  if (!row.revoked_at) {
    db.run("UPDATE devices SET revoked_at = ? WHERE id = ?", [nowISO(), row.id]);
    row.revoked_at = nowISO();
  }
  return row;
}

/** True when the device is gone or revoked: an open session must not outlive its token. */
export function isDeviceRevoked(db: Database, deviceID: string): boolean {
  const row = db.query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM devices WHERE id = ?").get(deviceID);
  return !row || row.revoked_at !== null;
}

export function listDevices(db: Database): Device[] {
  return db
    .query<Device, []>(
      "SELECT id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at ASC",
    )
    .all();
}
