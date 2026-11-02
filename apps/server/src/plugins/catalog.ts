/**
 * The plugin catalog: what can be connected, per account, with the scopes it
 * asks Google for and the policy grid the owner's rules give it.
 *
 * Scopes and capabilities are deliberately separate. A scope is what Google
 * grants; a capability mode is what the server then allows the agent to do:
 * `free` runs without asking, `approval` asks first, `off` refuses. Keeping
 * them apart means one shared scope grant can carry two very different rule
 * sets — Agni's own account runs free, your accounts ask first.
 *
 * Every plugin×account pair here becomes one settings-pane row and one
 * potential `plugin_connections` row.
 */
import type { PluginAccount, PluginCapability } from "@agni/protocol";

export type CapabilityMode = PluginCapability["mode"];
export type CapabilityName = PluginCapability["capability"];

export interface PluginRole {
  account: PluginAccount;
  scopes: string[];
  capabilities: PluginCapability[];
}

export interface PluginManifest {
  id: string;
  name: string;
  category: "google" | "mcp";
  description: string;
  authKind: "oauth" | "mcp" | "app-password" | "api-key";
  /** Registered tool names this plugin contributes once connected (`mcp_<id>_*` for MCP servers). */
  toolNames: string[];
  /** MCP plugins: the default streamable-HTTP endpoint. */
  mcpUrl?: string;
  roles: PluginRole[];
}

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function capabilities(entries: Partial<Record<CapabilityName, CapabilityMode>>): PluginCapability[] {
  const order: CapabilityName[] = ["read", "draft", "send", "create", "share", "modify"];
  return order
    .filter((name) => entries[name] !== undefined)
    .map((name) => ({ capability: name, mode: entries[name] as CapabilityMode }));
}

export const CATALOG: PluginManifest[] = [
  {
    id: "gmail",
    name: "Agni's Gmail",
    category: "google",
    description: "Search, read, draft, send and label mail — Agni's own mailbox. Uses an app password (2FA required on the account) so no Google verification is needed.",
    authKind: "app-password",
    toolNames: ["mail_search", "mail_read", "mail_send"],
    roles: [
      {
        account: "agent",
        scopes: [],
        capabilities: capabilities({ read: "free", draft: "free", send: "free", modify: "free" }),
      },
    ],
  },
  {
    id: "gmail-owner",
    name: "Your Gmail",
    category: "google",
    description: "Search and read your mail, draft replies; sends always ask first. App password on your account.",
    authKind: "app-password",
    toolNames: ["mail_search", "mail_read", "mail_send"],
    roles: [
      {
        account: "owner",
        scopes: [],
        capabilities: capabilities({ read: "free", draft: "free", send: "approval", modify: "approval" }),
      },
    ],
  },
  {
    id: "calendar",
    name: "Agni's Calendar",
    category: "google",
    description: "Search, create and invite on Agni's own calendar — scheduling it wants to do is its own to do.",
    authKind: "oauth",
    toolNames: ["calendar_list", "calendar_create", "calendar_update"],
    roles: [
      {
        account: "agent",
        scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/userinfo.email"],
        capabilities: capabilities({ read: "free", create: "free", share: "free", modify: "free" }),
      },
    ],
  },
  {
    id: "calendar-owner",
    name: "Your Calendar",
    category: "google",
    description: "Search your calendar any time; creating events and inviting people asks first.",
    authKind: "oauth",
    toolNames: ["calendar_list", "calendar_create", "calendar_update"],
    roles: [
      {
        account: "owner",
        scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/userinfo.email"],
        capabilities: capabilities({ read: "free", create: "approval", share: "approval", modify: "approval" }),
      },
    ],
  },
  {
    id: "drive",
    name: "Your Drive",
    category: "google",
    description: "Search and read your files; creating new files is allowed, sharing existing files asks first. Uses sensitive scopes only — no Google verification needed.",
    authKind: "oauth",
    toolNames: ["drive_search", "drive_read"],
    roles: [
      {
        account: "owner",
        scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/userinfo.email"],
        capabilities: capabilities({ read: "free", create: "approval", share: "approval", modify: "approval" }),
      },
    ],
  },
  {
    id: "granola",
    name: "Granola",
    category: "mcp",
    description: "Meeting notes, transcripts and action items via the official Granola MCP server. Read-only by design: the doing happens through the other plugins.",
    authKind: "mcp",
    toolNames: ["mcp_granola_*"], mcpUrl: "https://mcp.granola.ai/mcp",
    roles: [
      {
        account: "owner",
        scopes: [],
        capabilities: capabilities({ read: "free" }),
      },
    ],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "mcp",
    description: "Web scraping and search. Cloud (free tier 500 credits/mo) or self-hosted (unlimited, runs locally).",
    authKind: "api-key",
    toolNames: ["web_search", "web_fetch", "deep_research"],
    roles: [
      {
        account: "owner",
        scopes: [],
        capabilities: capabilities({ read: "free" }),
      },
    ],
  },
  {
    id: "notion",
    name: "Notion",
    category: "mcp",
    description: "Search, read and write pages and databases via the official Notion MCP server, plus the Notion skills bundle.",
    authKind: "mcp",
    toolNames: ["mcp_notion_*"], mcpUrl: "https://mcp.notion.com/mcp",
    roles: [
      {
        account: "owner",
        scopes: [],
        capabilities: capabilities({ read: "free", modify: "approval" }),
      },
    ],
  },
];

export function manifestFor(pluginID: string): PluginManifest | undefined {
  return CATALOG.find((plugin) => plugin.id === pluginID);
}
