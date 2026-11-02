/**
 * Plugin-stored credentials, read at the moment a tool needs them.
 *
 * The Plugins pane writes secrets into the daemon's mode-600 plugins.json.
 * The tools read them from there — not from .env — so that what the owner
 * connects in the UI is exactly what the agent can use. A mailbox connected
 * in Settings → Plugins has to work, or the connect is a lie.
 */
import { loadPluginsFile, savePluginsFile } from "./config";
import { manifestFor } from "./catalog";
import { refresh, type OAuthDeps } from "./oauth";

export interface MailAccount {
  /** The account email (IMAP user). */
  user: string;
  /** The app password. */
  pass: string;
}

/** The catalog plugin that owns each mailbox account. */
const MAIL_PLUGIN: Record<"agent" | "owner", string> = { agent: "gmail", owner: "gmail-owner" };

/** Resolves the mailbox credentials for an account, or null when not connected. */
export type MailAccountResolver = (account: "agent" | "owner") => MailAccount | null;

/** The mailbox credentials the owner connected for `account`, if any. */
export function mailCredentialsFromPlugins(pluginsPath: string, account: "agent" | "owner"): MailAccount | null {
  if (!pluginsPath) return null;
  const entry = loadPluginsFile(pluginsPath).plugins[MAIL_PLUGIN[account]];
  if (!entry?.enabled) return null;
  if (entry.auth.kind !== "app-password") return null;
  const user = entry.auth.user?.trim() ?? "";
  const pass = entry.auth.pass ?? "";
  if (!user || !pass) return null;
  return { user, pass };
}

/**
 * A resolver that reads the connected plugin's credentials from disk on every
 * call: a connect made in the UI has to take effect on the next tool call,
 * not on the next daemon restart.
 */
export function pluginMailResolver(pluginsPath: string): MailAccountResolver {
  return (account) => mailCredentialsFromPlugins(pluginsPath, account);
}

/** The catalog mode for a capability on a plugin's first role, or "off" when absent. */
export function modeFor(pluginID: string, capability: string, absent: "free" | "approval" | "off" = "off"): "free" | "approval" | "off" {
  const caps = manifestFor(pluginID)?.roles[0]?.capabilities ?? [];
  return caps.find((c) => c.capability === capability)?.mode ?? absent;
}

/**
 * A fresh Google access token for a connected OAuth plugin, read from
 * plugins.json on every call and written back after a refresh. Server-side
 * only: the model never sees it.
 */
export async function pluginAccessToken(pluginsPath: string, pluginID: string, fetchImpl?: typeof fetch): Promise<string> {
  const file = loadPluginsFile(pluginsPath);
  const entry = file.plugins[pluginID];
  if (!entry?.enabled || entry.auth.kind !== "oauth" || !(entry.auth.access_token || entry.auth.refresh_token)) {
    throw new Error(`${pluginID} is not connected. The owner connects it in Settings → Plugins.`);
  }
  const { access_token, refresh_token, expires_at } = entry.auth;
  if (access_token && expires_at && expires_at - 60_000 > Date.now()) return access_token;
  if (!refresh_token) throw new Error(`${pluginID} has no refresh token; the owner must reconnect it`);
  const client = file.oauthClients?.google;
  // refresh() only needs the client id/secret and fetch, not the daemon config.
  const deps = { clientID: client?.clientID ?? "", clientSecret: client?.clientSecret ?? "", ...(fetchImpl ? { fetch: fetchImpl } : {}) } as OAuthDeps;
  const fresh = await refresh(deps, refresh_token);
  entry.auth = { ...entry.auth, access_token: fresh.access_token, expires_at: fresh.expires_at };
  savePluginsFile(pluginsPath, file);
  return fresh.access_token!;
}

/** Firecrawl settings from the Plugins pane (cloud key and/or self-hosted URL). */
export function firecrawlFromPlugins(pluginsPath: string): { key?: string; url?: string } | null {
  if (!pluginsPath) return null;
  const entry = loadPluginsFile(pluginsPath).plugins.firecrawl;
  if (!entry?.enabled || entry.auth.kind !== "api-key") return null;
  return { key: entry.auth.key || undefined, url: entry.auth.url || undefined };
}
