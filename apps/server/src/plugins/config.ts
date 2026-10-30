/**
 * plugins.json — the single source of truth for plugin auth, tokens, and
 * activation state. Replaces plugin credentials in .env: the daemon reads
 * this file on startup, and the agent can manage its own plugins here in the
 * future (plugin.create / plugin.configure tools).
 *
 * File location: ~/.agni/plugins.json by default (`AGNI_PLUGINS_PATH`;
 * server-side only, mode 600).
 *
 * Schema:
 * {
 *   "version": 1,
 *   "plugins": {
 *     "<pluginID>": {
 *       "account": "agent" | "owner",
 *       "enabled": true,
 *       "auth": { ... }   // kind-specific credentials
 *     }
 *   }
 * }
 *
 * Auth kinds:
 *   app-password: { kind, user, pass }
 *   api-key:       { kind, key?, url? }        // key = cloud API key, url = self-hosted
 *   oauth:         { kind, refresh_token?, access_token?, expires_at? }
 *   mcp:           { kind }                     // browser OAuth, no stored creds
 */
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log";

/** Configs loaded from an unreadable file: saving one would wipe the stored credentials. */
const unreadable = new WeakSet<PluginsFile>();

export interface PluginAuth {
  kind: "app-password" | "api-key" | "oauth" | "mcp";
  // app-password
  user?: string;
  pass?: string;
  // api-key
  key?: string;
  url?: string;
  // oauth
  refresh_token?: string;
  access_token?: string;
  expires_at?: number;
}

export interface PluginEntry {
  account: "agent" | "owner";
  enabled: boolean;
  auth: PluginAuth;
  /** Display label (e.g. the signed-in email), set at connect time. */
  label?: string;
  /** Epoch ms of the last successful connect. */
  connectedAt?: number;
}

export interface OAuthClient {
  clientID: string;
  clientSecret: string;
}

export interface PluginsFile {
  version: number;
  /** OAuth client credentials keyed by provider (e.g. "google"). */
  oauthClients?: Record<string, OAuthClient>;
  plugins: Record<string, PluginEntry>;
}

export function emptyPluginsFile(): PluginsFile {
  return { version: 1, plugins: {} };
}

export function loadPluginsFile(path: string): PluginsFile {
  if (!existsSync(path)) return emptyPluginsFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PluginsFile;
    if (parsed.version === 1 && parsed.plugins && typeof parsed.plugins === "object") return parsed;
  } catch {
    // fall through: treat as unreadable below
  }
  // Run with no plugins, but never save over the file: it may hold the only copy of the tokens.
  try { copyFileSync(path, `${path}.corrupt`); chmodSync(`${path}.corrupt`, 0o600); } catch { /* best effort */ }
  log.error(`plugins file ${path} is unreadable; kept a copy at ${path}.corrupt and will not overwrite it`);
  const empty = emptyPluginsFile();
  unreadable.add(empty);
  return empty;
}

export function savePluginsFile(path: string, config: PluginsFile): void {
  if (unreadable.has(config)) {
    throw new Error(`refusing to overwrite unreadable ${path}; fix or remove it and restart`);
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write a private temp file, flush it, then rename: a crash leaves the old file or the new one, never half.
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600); // a stale tmp from a crash keeps its old mode on open
  renameSync(tmp, path);
}

export function getPluginEntry(config: PluginsFile, pluginID: string): PluginEntry | undefined {
  return config.plugins[pluginID];
}

export function isPluginEnabled(config: PluginsFile, pluginID: string): boolean {
  return config.plugins[pluginID]?.enabled ?? false;
}

/** Merge a plugin entry into the config (create or update). */
export function upsertPlugin(config: PluginsFile, pluginID: string, entry: PluginEntry): void {
  config.plugins[pluginID] = entry;
}

export function removePlugin(config: PluginsFile, pluginID: string): void {
  delete config.plugins[pluginID];
}

/** All plugin IDs that are enabled, for auto-connect on daemon start. */
export function enabledPluginIDs(config: PluginsFile): string[] {
  return Object.entries(config.plugins)
    .filter(([, entry]) => entry.enabled)
    .map(([id]) => id);
}