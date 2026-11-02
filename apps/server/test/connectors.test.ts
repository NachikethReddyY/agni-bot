import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ApprovalBroker } from "../src/agent/approval-broker";
import { createGoogleTools } from "../src/tools/google";
import { McpHub, MCP_FREE_TOOLS } from "../src/plugins/mcp";
import { CATALOG } from "../src/plugins/catalog";
import { firecrawlFromPlugins } from "../src/plugins/credentials";
import { buildTaskToolRegistry } from "../src/tools/task-registry";
import { openDatabase } from "../src/db";

function pluginsFile(plugins: Record<string, unknown>): string {
  const path = join(mkdtempSync(join(tmpdir(), "agni-conn-")), "plugins.json");
  writeFileSync(path, JSON.stringify({ version: 1, oauthClients: { google: { clientID: "c", clientSecret: "s" } }, plugins }));
  return path;
}
const oauth = (account: "agent" | "owner") => ({ account, enabled: true, auth: { kind: "oauth", access_token: "tok", expires_at: Date.now() + 3_600_000 } });

function recorder(answer: (url: string) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer(String(url));
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const tool = (tools: ReturnType<typeof createGoogleTools>, name: string) => tools.find((t) => t.name === name)!;
const ctx = {} as any;

describe("calendar tools", () => {
  test("list reads events with the stored token; not connected is a plain error", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ items: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-11-01T09:00:00Z" }, end: { dateTime: "2026-11-01T09:15:00Z" } }] }));
    const tools = createGoogleTools(pluginsFile({ calendar: oauth("agent") }), fetchImpl);
    const out = await tool(tools, "calendar_list").handler({ timeMin: "2026-11-01T00:00:00Z", timeMax: "2026-11-02T00:00:00Z" }, ctx);
    expect(out.events[0]).toMatchObject({ id: "e1", summary: "Standup" });
    expect(calls[0]!.url).toContain("/calendars/primary/events?");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const none = await tool(createGoogleTools(pluginsFile({}), fetchImpl), "calendar_list").handler({ timeMin: "a", timeMax: "b", account: "owner" }, ctx);
    expect(none.error).toContain("not connected");
    expect(await tool(tools, "calendar_list").handler({ account: "bob", timeMin: "a", timeMax: "b" }, ctx)).toEqual({ error: 'account must be exactly "agent" or "owner"' });
  });

  test("create posts, update patches", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ id: "e2", summary: "Lunch" }));
    const tools = createGoogleTools(pluginsFile({ calendar: oauth("agent") }), fetchImpl);
    await tool(tools, "calendar_create").handler({ summary: "Lunch", start: "2026-11-01T12:00:00Z", end: "2026-11-01T13:00:00Z" }, ctx);
    expect(calls[0]!.init!.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init!.body)).start).toEqual({ dateTime: "2026-11-01T12:00:00Z" });
    await tool(tools, "calendar_update").handler({ eventId: "e2", summary: "Brunch" }, ctx);
    expect(calls[1]!.init!.method).toBe("PATCH");
    expect(calls[1]!.url).toEndWith("/events/e2");
    expect((await tool(tools, "calendar_update").handler({ eventId: "../x" }, ctx)).error).toBe("invalid eventId");
  });

  test("gating mirrors mail_send", () => {
    const broker = new ApprovalBroker({} as any);
    for (const name of ["calendar_create", "calendar_update"]) {
      expect(broker.requiresApproval(name, {})).toBe(false);
      expect(broker.requiresApproval(name, { account: "agent" })).toBe(false);
      expect(broker.requiresApproval(name, { account: "owner" })).toBe(true);
    }
    for (const name of ["calendar_list", "drive_search", "drive_read"]) expect(broker.requiresApproval(name, { account: "owner" })).toBe(false);
  });
});

describe("drive tools", () => {
  test("search escapes the query", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ files: [{ id: "f1", name: "Plan", mimeType: "text/plain" }] }));
    const tools = createGoogleTools(pluginsFile({ drive: oauth("owner") }), fetchImpl);
    const out = await tool(tools, "drive_search").handler({ query: "o'brien" }, ctx);
    expect(out.files[0].id).toBe("f1");
    expect(new URL(calls[0]!.url).searchParams.get("q")!).toContain("fullText contains 'o\\'brien'");
  });

  test("read exports Docs as text, caps length, refuses binaries", async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.includes("/export") ? new Response("x".repeat(5000)) : Response.json({ name: "Doc", mimeType: url.includes("bin1") ? "application/pdf" : "application/vnd.google-apps.document" }));
    const tools = createGoogleTools(pluginsFile({ drive: oauth("owner") }), fetchImpl);
    const out = await tool(tools, "drive_read").handler({ fileId: "doc1", maxChars: 1000 }, ctx);
    expect(out.text.length).toBe(1000);
    expect(out.truncated).toBe(true);
    expect(out.untrusted).toBeTruthy();
    expect(calls[1]!.url).toContain("export?mimeType=text%2Fplain");
    expect((await tool(tools, "drive_read").handler({ fileId: "bin1" }, ctx)).error).toContain("cannot read");
  });
});

describe("MCP hub", () => {
  async function server() {
    const mcp = new McpServer({ name: "fake", version: "1" });
    mcp.registerTool("search", { description: "find notes", inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } }, async ({ q }) => ({ content: [{ type: "text", text: `found ${q}` }] }));
    mcp.registerTool("create_page", { description: "write", inputSchema: { title: z.string() } }, async ({ title }) => ({ content: [{ type: "text", text: `made ${title}` }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    return clientSide;
  }

  test("exposes namespaced tools; read-only is free, writes ask", async () => {
    const hub = new McpHub();
    expect(await hub.connect("notion", "http://unused", undefined, await server())).toBe(2);
    const names = hub.tools().map((t) => t.name).sort();
    expect(names).toEqual(["mcp_notion_create_page", "mcp_notion_search"]);
    const broker = new ApprovalBroker({} as any);
    expect(broker.requiresApproval("mcp_notion_search", {})).toBe(false);
    expect(broker.requiresApproval("mcp_notion_create_page", {})).toBe(true);
    const out = await hub.tools().find((t) => t.name === "mcp_notion_search")!.handler({ q: "x" }, ctx);
    expect(out).toMatchObject({ text: "found x" });
    expect(out.untrusted).toBeTruthy();
    await hub.disconnect("notion");
    expect(MCP_FREE_TOOLS.has("mcp_notion_search")).toBe(false);
  });

  test("a read-only server (granola) gates its non-read tools", async () => {
    const hub = new McpHub();
    await hub.connect("granola", "http://unused", undefined, await server());
    expect(MCP_FREE_TOOLS.has("mcp_granola_search")).toBe(true);
    expect(MCP_FREE_TOOLS.has("mcp_granola_create_page")).toBe(false);
    await hub.disconnect("granola");
  });
});

describe("catalog and firecrawl", () => {
  test("catalog toolNames are real registered tools (or an mcp_ prefix)", () => {
    const registered = new Set(buildTaskToolRegistry(openDatabase(":memory:")).list().map((t) => t.name));
    for (const plugin of CATALOG) for (const name of plugin.toolNames) {
      expect(name.endsWith("*") || registered.has(name)).toBe(true);
    }
  });

  test("firecrawl credential comes from plugins.json", () => {
    const path = pluginsFile({ firecrawl: { account: "owner", enabled: true, auth: { kind: "api-key", key: "fc-123" } } });
    expect(firecrawlFromPlugins(path)).toEqual({ key: "fc-123", url: undefined });
    expect(firecrawlFromPlugins(pluginsFile({}))).toBeNull();
  });
});
