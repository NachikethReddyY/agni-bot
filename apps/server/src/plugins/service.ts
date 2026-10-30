/**
 * Plugin service: the logic behind the `plugin.*` frames and the OAuth
 * callback route. Holds the catalog's frame-facing truth (every catalog row
 * becomes a PluginInfo), runs connect/disconnect, and emits `plugin.state`
 * snapshots to every client whenever a connection changes.
 */
import type { Database } from "bun:sqlite";
import type { PluginAccount, PluginInfo, PluginStatus, ServerFrameBody } from "@agni/protocol";
import type { Config } from "../config";
import { CATALOG, manifestFor, type PluginManifest } from "./catalog";
import * as oauth from "./oauth";
import { mcpHub } from "./mcp";
import {
  completeConnect,
  deleteConnection,
  getConnection,
  getConnectionByState,
  getConnectionFor,
  getConnections,
  markError,
  startPending,
  type PluginConnectionRow,
  type TokenBlob,
  updateTokens,
} from "./store";
import {
  loadPluginsFile,
  savePluginsFile,
  getPluginEntry,
  isPluginEnabled,
  upsertPlugin,
  removePlugin,
  enabledPluginIDs,
  type PluginsFile,
  type PluginEntry,
} from "./config";

export interface PluginDeps {
  config: Config;
  db: Database;
  /** Path to plugins.json (the single source of truth for plugin auth). */
  pluginsPath: string;
  /** Fan out to every authed session (the `plugin.state` snapshot). */
  emit: (body: ServerFrameBody) => void;
}

export class PluginService {
  private deps: PluginDeps;
  /** Test hook: injected fetch for Google endpoints. */
  fetchOverride?: typeof fetch;
  /** In-memory view of plugins.json, loaded on construction. */
  private pluginsFile: PluginsFile;

  constructor(deps: PluginDeps) {
    this.deps = deps;
    this.pluginsFile = loadPluginsFile(deps.pluginsPath);
  }

  private oauthDeps(): oauth.OAuthDeps {
    const client = this.pluginsFile.oauthClients?.google;
    return {
      config: this.deps.config,
      clientID: client?.clientID ?? "",
      clientSecret: client?.clientSecret ?? "",
      ...(this.fetchOverride ? { fetch: this.fetchOverride } : {}),
    };
  }

  /** Mark a plugin as enabled in plugins.json and persist. */
  private markEnabledInFile(pluginID: string, account: PluginAccount, label: string): void {
    const existing = this.pluginsFile.plugins[pluginID];
    if (existing) {
      existing.enabled = true;
      existing.label = label;
      existing.connectedAt = Date.now();
    } else {
      upsertPlugin(this.pluginsFile, pluginID, {
        account,
        enabled: true,
        auth: { kind: "oauth" },
        label,
        connectedAt: Date.now(),
      });
    }
    this.save();
  }

  /** Read a plugin's auth entry from plugins.json. */
  private authFor(pluginID: string): PluginEntry | undefined {
    return getPluginEntry(this.pluginsFile, pluginID);
  }

  /** Persist the in-memory plugins.json to disk (mode-600). */
  private save(): void {
    savePluginsFile(this.deps.pluginsPath, this.pluginsFile);
  }

  /** The full settings-pane snapshot: every catalog row, live status merged in. */
  list(): PluginInfo[] {
    const connections = getConnections(this.deps.db);
    const infos: PluginInfo[] = [];
    for (const manifest of CATALOG) {
      for (const role of manifest.roles) {
        const row = connections.find((entry) => entry.plugin_id === manifest.id && entry.account === role.account);
        infos.push(toInfo(manifest, role.account, row));
      }
    }
    // A connection row whose manifest moved on (catalog edited) still shows —
    // as an error, never silently missing.
    for (const row of connections) {
      if (infos.some((info) => info.id === row.plugin_id && info.account === row.account)) continue;
      infos.push({
        id: row.plugin_id,
        name: row.plugin_id,
        category: "mcp",
        description: "This plugin is no longer in the catalog; disconnect it to clean up.",
        authKind: "mcp",
        account: row.account,
        scopes: [],
        capabilities: [],
        available: false,
        connectionID: row.id,
        status: row.status as PluginStatus,
        ...(row.account_label ? { accountLabel: row.account_label } : {}),
        ...(row.error ? { error: row.error } : {}),
      });
    }
    return infos;
  }

  /**
   * Store a plugin's credentials and connect it.
   *
   * The secrets arrive over the authenticated socket and go straight into
   * plugins.json (mode 600) on the daemon host. Nothing is echoed back, and
   * the app keeps no copy — the same rule the provider keys follow.
   */
  configure(
    pluginID: string,
    account: PluginAccount,
    credentials: {
      user?: string;
      pass?: string;
      key?: string;
      url?: string;
      clientID?: string;
      clientSecret?: string;
    },
  ): { authorizeURL?: string; error?: { code: string; message: string } } {
    const manifest = manifestFor(pluginID);
    if (!manifest) return { error: { code: "unknown_plugin", message: `no plugin "${pluginID}" in the catalog` } };
    const role = manifest.roles.find((entry) => entry.account === account);
    if (!role) {
      return { error: { code: "unknown_plugin", message: `plugin "${pluginID}" does not offer an ${account} connection` } };
    }

    if (manifest.authKind === "app-password") {
      const user = credentials.user?.trim() ?? "";
      const pass = credentials.pass ?? "";
      if (!user || !pass) {
        return {
          error: { code: "plugin_not_configured", message: "Enter the account email and its app password." },
        };
      }
      upsertPlugin(this.pluginsFile, pluginID, {
        account,
        enabled: true,
        auth: { kind: "app-password", user, pass },
        label: user,
        connectedAt: Date.now(),
      });
      this.save();
      return this.connect(pluginID, account);
    }

    if (manifest.authKind === "api-key") {
      const key = credentials.key?.trim() ?? "";
      const url = credentials.url?.trim() ?? "";
      if (!key && !url) {
        return {
          error: { code: "plugin_not_configured", message: "Enter an API key, or the URL of a self-hosted instance." },
        };
      }
      upsertPlugin(this.pluginsFile, pluginID, {
        account,
        enabled: true,
        auth: { kind: "api-key", key: key || undefined, url: url || undefined },
        label: url ? `self-hosted (${url})` : "cloud",
        connectedAt: Date.now(),
      });
      this.save();
      return this.connect(pluginID, account);
    }

    if (manifest.authKind === "mcp") {
      // The bearer token (if the server needs one) goes to plugins.json only.
      upsertPlugin(this.pluginsFile, pluginID, {
        account,
        enabled: true,
        auth: { kind: "mcp", key: credentials.key?.trim() || undefined, url: credentials.url?.trim() || undefined },
        connectedAt: Date.now(),
      });
      this.save();
      return this.connect(pluginID, account);
    }

    if (manifest.authKind === "oauth") {
      const clientID = credentials.clientID?.trim() ?? "";
      const clientSecret = credentials.clientSecret?.trim() ?? "";
      if (!clientID || !clientSecret) {
        return {
          error: { code: "plugin_not_configured", message: "Enter the Google client ID and client secret." },
        };
      }
      this.pluginsFile.oauthClients = {
        ...(this.pluginsFile.oauthClients ?? {}),
        google: { clientID, clientSecret },
      };
      this.save();
      return this.connect(pluginID, account);
    }

    return this.connect(pluginID, account);
  }

  /** Begin a connect flow; answers the authorize URL for the browser, or an error. */
  connect(pluginID: string, account: PluginAccount): { authorizeURL?: string; error?: { code: string; message: string } } {
    const manifest = manifestFor(pluginID);
    if (!manifest) return { error: { code: "unknown_plugin", message: `no plugin "${pluginID}" in the catalog` } };
    const role = manifest.roles.find((entry) => entry.account === account);
    if (!role) {
      return { error: { code: "unknown_plugin", message: `plugin "${pluginID}" does not offer an ${account} connection` } };
    }

    // App-password plugins: credentials from plugins.json.
    if (manifest.authKind === "app-password") {
      const entry = this.authFor(pluginID);
      const user = entry?.auth.user ?? "";
      const pass = entry?.auth.pass ?? "";
      if (!user || !pass) {
        return {
          error: {
            code: "plugin_not_configured",
            message: `Enable this plugin in Settings → Plugins (credentials are stored in plugins.json, not .env).`,
          },
        };
      }
      try {
        const pending = startPending(this.deps.db, {
          pluginID,
          account,
          scopes: [],
          capabilities: role.capabilities,
        });
        completeConnect(this.deps.db, pending.id, { access_token: pass }, user);
        this.markEnabledInFile(pluginID, account, user);
        this.emitState();
        return {};
      } catch (error) {
        return { error: { code: "plugin_connect_failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }

    // API-key plugins (Firecrawl): key or URL from plugins.json.
    if (manifest.authKind === "api-key") {
      const entry = this.authFor(pluginID);
      const url = entry?.auth.url ?? "";
      const key = entry?.auth.key ?? "";
      if (!url && !key) {
        return {
          error: {
            code: "plugin_not_configured",
            message: `Enable this plugin in Settings → Plugins (set a self-hosted URL or cloud API key in plugins.json).`,
          },
        };
      }
      try {
        const label = url ? `self-hosted (${url})` : "cloud";
        const pending = startPending(this.deps.db, {
          pluginID,
          account,
          scopes: [],
          capabilities: role.capabilities,
        });
        completeConnect(this.deps.db, pending.id, { access_token: key || "self-hosted" }, label);
        this.markEnabledInFile(pluginID, account, label);
        this.emitState();
        return {};
      } catch (error) {
        return { error: { code: "plugin_connect_failed", message: error instanceof Error ? error.message : String(error) } };
      }
    }

    if (manifest.authKind === "mcp") return this.connectMcp(manifest, role.capabilities, account);
    if (manifest.authKind !== "oauth") {
      return { error: { code: "plugin_unavailable", message: `${manifest.name} cannot be connected from here` } };
    }
    const oauthClient = this.oauthDeps();
    if (!oauth.isConfigured(oauthClient)) {
      return {
        error: {
          code: "plugin_not_configured",
          message: "Set google.clientID and google.clientSecret in plugins.json (or via Settings → Plugins) and restart the daemon.",
        },
      };
    }

    try {
      const pending = startPending(this.deps.db, {
        pluginID,
        account,
        scopes: role.scopes,
        capabilities: role.capabilities,
      });
      this.emitState();
      const tokens = readTokens(pending);
      return { authorizeURL: oauth.authorizeURL(oauthClient, this.deps.config, role.scopes, tokens.state ?? "") };
    } catch (error) {
      return { error: { code: "plugin_connect_failed", message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * MCP plugins: mark connected now, then reach the server in the background;
   * a failure flips the row to an error the pane shows. The bearer token never
   * leaves plugins.json.
   */
  private connectMcp(manifest: PluginManifest, capabilities: PluginManifest["roles"][number]["capabilities"], account: PluginAccount): { error?: { code: string; message: string } } {
    const entry = this.authFor(manifest.id);
    const url = entry?.auth.url || manifest.mcpUrl || "";
    try {
      new URL(url);
    } catch {
      return { error: { code: "plugin_not_configured", message: "Enter the MCP server URL." } };
    }
    const pending = startPending(this.deps.db, { pluginID: manifest.id, account, scopes: [], capabilities });
    completeConnect(this.deps.db, pending.id, {}, new URL(url).host);
    if (!entry) upsertPlugin(this.pluginsFile, manifest.id, { account, enabled: true, auth: { kind: "mcp" }, connectedAt: Date.now() });
    else entry.label = new URL(url).host;
    this.save();
    this.emitState();
    void this.reachMcp(manifest.id, pending.id, url, entry?.auth.key);
    return {};
  }

  private async reachMcp(pluginID: string, connectionID: string, url: string, token?: string): Promise<void> {
    try {
      await mcpHub.connect(pluginID, url, token);
    } catch (error) {
      markError(this.deps.db, connectionID, error instanceof Error ? error.message : String(error));
      this.emitState();
    }
  }

  /** The loopback route's landing: finish the grant for whichever state this is. */
  async completeSignIn(state: string, code: string): Promise<{ plugin?: string; error?: string }> {
    const pending = getConnectionByState(this.deps.db, state);
    if (!pending) {
      return { error: "This sign-in is stale or was already completed. Connect again from the settings pane." };
    }
    try {
      const tokens = await oauth.exchangeCode(this.oauthDeps(), this.deps.config, code);
      if (!tokens.access_token) throw new Error("Google returned no access token");
      const { email } = await oauth.whoami(this.oauthDeps(), tokens.access_token);
      completeConnect(this.deps.db, pending.id, tokens, email ?? "Google account");
      // Persist tokens to plugins.json so they survive daemon restarts.
      const entry = this.authFor(pending.plugin_id);
      if (entry) {
        entry.auth = { ...entry.auth, ...tokens };
        entry.label = email ?? "Google account";
        entry.connectedAt = Date.now();
      } else {
        upsertPlugin(this.pluginsFile, pending.plugin_id, {
          account: pending.account,
          enabled: true,
          auth: { kind: "oauth", ...tokens },
          label: email ?? "Google account",
          connectedAt: Date.now(),
        });
      }
      this.save();
      this.emitState();
      return { plugin: pending.plugin_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markError(this.deps.db, pending.id, message);
      this.emitState();
      return { error: message };
    }
  }

  /** Disconnect: revoke with Google, then drop the row so a re-connect starts clean. */
  async disconnect(connectionID: string): Promise<{ error?: { code: string; message: string } }> {
    const row = getConnection(this.deps.db, connectionID);
    if (!row) return { error: { code: "unknown_connection", message: `no connection ${connectionID}` } };

    const entry = this.authFor(row.plugin_id);
    const tokens = entry?.auth;
    try {
      const target = tokens?.refresh_token ?? tokens?.access_token;
      if (target) await oauth.revoke(this.oauthDeps(), target);
    } catch {
      // A Google-side failure must not strand the credential locally.
    }
    deleteConnection(this.deps.db, row.id);
    await mcpHub.disconnect(row.plugin_id);
    // Clear tokens from plugins.json.
    if (entry) {
      entry.auth = { kind: manifestFor(row.plugin_id)?.authKind === "mcp" ? "mcp" : "oauth" };
      entry.label = undefined;
      entry.connectedAt = undefined;
      this.save();
    }
    this.emitState();
    return {};
  }

  /** A stored, still-valid access token for API clients (PS3+). */
  async accessTokenFor(pluginID: string, account: PluginAccount): Promise<string> {
    const entry = this.authFor(pluginID);
    if (!entry || entry.auth.kind !== "oauth") throw new Error(`plugin ${pluginID}/${account} is not connected`);
    const tokens = entry.auth;
    const token = await oauth.ensureAccessToken(this.oauthDeps(), tokens);
    // Persist the fresh access token so the next turn does not redo the exchange.
    if (tokens.access_token !== token) {
      entry.auth = { ...tokens, access_token: token };
      this.save();
    }
    return token;
  }

  /** Auto-connect app-password and api-key plugins from plugins.json on daemon start. */
  autoConnect(): void {
    for (const manifest of CATALOG) {
      if (manifest.authKind === "mcp") {
        const entry = this.authFor(manifest.id);
        const url = entry?.auth.url || manifest.mcpUrl;
        if (entry?.enabled && url) void this.reachMcp(manifest.id, getConnectionFor(this.deps.db, manifest.id, entry.account)?.id ?? "", url, entry.auth.key);
        continue;
      }
      if (manifest.authKind !== "app-password" && manifest.authKind !== "api-key") continue;
      for (const role of manifest.roles) {
        const entry = this.authFor(manifest.id);
        if (!entry?.enabled) continue;
        const user = entry.auth.user ?? entry.auth.url ?? "";
        const pass = entry.auth.pass ?? entry.auth.key ?? "";
        if (!user || !pass) continue;
        const existing = getConnectionFor(this.deps.db, manifest.id, role.account);
        if (existing?.status === "connected") continue;
        try {
          const pending = startPending(this.deps.db, {
            pluginID: manifest.id,
            account: role.account,
            scopes: [],
            capabilities: role.capabilities,
          });
          completeConnect(this.deps.db, pending.id, { access_token: pass }, user);
        } catch {
          // Non-fatal: the plugin shows as disconnected.
        }
      }
    }
    this.emitState();
  }

  private emitState(): void {
    this.deps.emit({ type: "plugin.state", plugins: this.list() });
  }

}

function readTokens(row: PluginConnectionRow): TokenBlob {
  if (!row.tokens) return {};
  try {
    return JSON.parse(row.tokens) as TokenBlob;
  } catch {
    return {};
  }
}

function toInfo(manifest: PluginManifest, account: PluginAccount, row?: PluginConnectionRow): PluginInfo {
  const role = manifest.roles.find((entry) => entry.account === account)!;
  return {
    id: manifest.id,
    name: manifest.name,
    category: manifest.category,
    description: manifest.description,
    authKind: manifest.authKind,
    account,
    scopes: role.scopes,
    capabilities: role.capabilities,
    // OAuth kinds are reachable once the daemon has Google creds configured.
    available: true,
    ...(row?.id ? { connectionID: row.id } : {}),
    ...(row?.status ? { status: row.status as PluginStatus } : {}),
    ...(row?.account_label ? { accountLabel: row.account_label } : {}),
    ...(row?.error ? { error: row.error } : {}),
    ...(row?.connected_at ? { connectedAt: row.connected_at } : {}),
  };
}
