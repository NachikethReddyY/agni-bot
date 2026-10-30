import { describe, expect, test } from "bun:test";
import type { PluginInfo, ServerFrameBody } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { PluginService } from "../src/plugins/service";
import { authorizeURL, isConfigured, redirectURI } from "../src/plugins/oauth";
import {
  completeConnect,
  getConnection,
  getConnectionByState,
  getConnectionFor,
  getConnections,
  startPending,
} from "../src/plugins/store";
import { CATALOG, manifestFor } from "../src/plugins/catalog";
import { mailCredentialsFromPlugins, pluginMailResolver } from "../src/plugins/credentials";
import { resolveMailConfig } from "../src/tools/mail";
import type { Config } from "../src/config";
import { readFileSync, writeFileSync } from "node:fs";

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 8787,
    dbPath: ":memory:",
    pidPath: "",
    logPath: "",
    providers: [],
    firstTokenTimeoutMs: 1000,
    turnTimeoutMs: 5000,
    helloTimeoutMs: 2000,
    frameLogCapacity: 100,
    jobPollMs: 1000,
    maxConcurrentTurns: 4,
    pluginsPath: ":memory:",
    ...overrides,
  };
}

interface Harness {
  service: PluginService;
  states: ServerFrameBody[];
  calls: { url: string; init?: RequestInit }[];
}

/** Service against an in-memory db, with fetch stubbed to record + answer. */
function harness(
  fetchPlan: (url: string, step: number, init?: RequestInit) => Response | Promise<Response> = () => Response.json({}),
): Harness {
  const db = openDatabase(":memory:");
  const states: ServerFrameBody[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let step = 0;
  const pluginsPath = "/tmp/agni-plugins-test.json";
  writeFileSync(pluginsPath, JSON.stringify({
    version: 1,
    oauthClients: { google: { clientID: "test-client-id", clientSecret: "test-client-secret" } },
    plugins: {},
  }));
  const service = new PluginService({ config: fakeConfig(), db, emit: (body) => states.push(body), pluginsPath });
  service.fetchOverride = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    step += 1;
    return Promise.resolve(fetchPlan(url.toString(), step, init));
  }) as typeof fetch;
  return { service, states, calls };
}

// --- catalog -----------------------------------------------------------------

describe("plugin catalog", () => {
  test("every manifest × account pair is unique and policy-complete", () => {
    const seen = new Set<string>();
    for (const plugin of CATALOG) {
      expect(plugin.toolNames.length).toBeGreaterThan(0);
      for (const role of plugin.roles) {
        const key = `${plugin.id}/${role.account}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(role.capabilities.length).toBeGreaterThan(0);
        for (const capability of role.capabilities) {
          expect(["free", "approval", "off"]).toContain(capability.mode);
        }
      }
    }
  });

  test("the agent's own accounts run free; the owner's sends/creates ask first", () => {
    const gmailAgent = manifestFor("gmail")!.roles[0]!;
    expect(gmailAgent.capabilities.find((c) => c.capability === "send")?.mode).toBe("free");
    const gmailOwner = manifestFor("gmail-owner")!.roles[0]!;
    expect(gmailOwner.capabilities.find((c) => c.capability === "send")?.mode).toBe("approval");
    const calendarOwner = manifestFor("calendar-owner")!.roles[0]!;
    expect(calendarOwner.capabilities.find((c) => c.capability === "create")?.mode).toBe("approval");
  });

  test("list() carries one row per manifest × account, connected state merged", () => {
    const { service } = harness();
    const rows = service.list();
    expect(rows.length).toBe(CATALOG.reduce((sum, plugin) => sum + plugin.roles.length, 0));
    const gmailAgent = rows.find((row) => row.id === "gmail")!;
    expect(gmailAgent.account).toBe("agent");
    expect(gmailAgent.available).toBe(true);
    expect(gmailAgent.status).toBeUndefined();
    const granola = rows.find((row) => row.id === "granola")!;
    expect(granola.available).toBe(true);
    expect(granola.authKind).toBe("mcp");
  });
});

// --- connect flow ------------------------------------------------------------

describe("plugin connect flow", () => {
  test("connect refuses OAuth plugins until credentials exist in plugins.json", () => {
    const db = openDatabase(":memory:");
    const service = new PluginService({ config: fakeConfig(), db, emit: () => {}, pluginsPath: ":memory:" });
    const result = service.connect("calendar", "agent");
    expect(result.error?.code).toBe("plugin_not_configured");
    db.close();
  });

  test("configuring an app-password plugin stores the credentials and connects it", () => {
    const db = openDatabase(":memory:");
    const pluginsPath = "/tmp/agni-plugins-configure-test.json";
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins: {} }));
    const service = new PluginService({ config: fakeConfig(), db, emit: () => {}, pluginsPath });

    const result = service.configure("gmail", "agent", { user: "agni@example.com", pass: "app-pass" });
    expect(result.error).toBeUndefined();

    const stored = JSON.parse(readFileSync(pluginsPath, "utf8")) as {
      plugins: Record<string, { enabled: boolean; auth: { kind: string; user?: string; pass?: string } }>;
    };
    expect(stored.plugins.gmail?.enabled).toBe(true);
    expect(stored.plugins.gmail?.auth.user).toBe("agni@example.com");
    expect(stored.plugins.gmail?.auth.pass).toBe("app-pass");

    const connection = getConnectionFor(db, "gmail", "agent");
    expect(connection?.status).toBe("connected");
    expect(connection?.account_label).toBe("agni@example.com");
    db.close();
  });

  test("configuring without the required fields is refused, and nothing is stored", () => {
    const db = openDatabase(":memory:");
    const pluginsPath = "/tmp/agni-plugins-configure-empty-test.json";
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins: {} }));
    const service = new PluginService({ config: fakeConfig(), db, emit: () => {}, pluginsPath });

    const result = service.configure("gmail", "agent", { user: "agni@example.com" });
    expect(result.error?.code).toBe("plugin_not_configured");

    const stored = JSON.parse(readFileSync(pluginsPath, "utf8")) as { plugins: Record<string, unknown> };
    expect(stored.plugins.gmail).toBeUndefined();
    db.close();
  });

  test("configuring an OAuth plugin stores the Google client and starts the grant", () => {
    const db = openDatabase(":memory:");
    const pluginsPath = "/tmp/agni-plugins-configure-oauth-test.json";
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins: {} }));
    const service = new PluginService({ config: fakeConfig(), db, emit: () => {}, pluginsPath });

    const result = service.configure("calendar", "agent", {
      clientID: "client-id",
      clientSecret: "client-secret",
    });
    expect(result.error).toBeUndefined();
    expect(result.authorizeURL).toContain("client_id=client-id");

    const stored = JSON.parse(readFileSync(pluginsPath, "utf8")) as {
      oauthClients?: Record<string, { clientID: string; clientSecret: string }>;
    };
    expect(stored.oauthClients?.google?.clientID).toBe("client-id");
    expect(stored.oauthClients?.google?.clientSecret).toBe("client-secret");
    db.close();
  });

  test("connect creates a pending row and answers an authorize URL with the state", () => {
    const { service, states } = harness();
    const result = service.connect("calendar", "agent");
    expect(result.error).toBeUndefined();
    const url = new URL(result.authorizeURL!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8787/oauth/callback");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("calendar");
    const state = url.searchParams.get("state")!;
    expect(state).not.toBe("");
    // A pending connection is live stream state clients render immediately.
    const snapshot = states.at(-1) as { type: string; plugins: PluginInfo[] };
    expect(snapshot.type).toBe("plugin.state");
    const row = snapshot.plugins.find((entry) => entry.id === "calendar")!;
    expect(row.status).toBe("pending");
    expect(row.connectionID).toBeTruthy();
  });

  test("re-connecting the same pair resets the grant instead of stacking rows", () => {
    const { service } = harness();
    service.connect("calendar", "agent");
    service.connect("calendar", "agent");
    const db = service["deps"].db;
    expect(getConnections(db).filter((row) => row.plugin_id === "calendar")).toHaveLength(1);
    expect(getConnectionFor(db, "calendar", "agent")!.status).toBe("pending");
  });

  test("MCP plugins need a valid server URL to connect", () => {
    const { service } = harness();
    const result = service.configure("granola", "owner", { url: "not a url" });
    expect(result.error?.code).toBe("plugin_not_configured");
  });

  test("unknown plugin accounts refuse cleanly", () => {
    const { service } = harness();
    expect(service.connect("calendar", "owner")!.error?.code).toBe("unknown_plugin");
    expect(service.connect("drive", "agent")!.error?.code).toBe("unknown_plugin");
  });
});

// --- OAuth callback ----------------------------------------------------------

describe("oauth callback", () => {
  test("completes the grant: tokens stored, email recorded, state consumed", async () => {
    const { service, states, calls } = harness((url) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 });
      }
      return Response.json({ email: "hey.agnibot@gmail.com" });
    });
    const connect = service.connect("calendar", "agent");
    const state = new URL(connect.authorizeURL!).searchParams.get("state")!;

    const result = await service.completeSignIn(state, "auth-code-1");
    expect(result.plugin).toBe("calendar");
    expect(result.error).toBeUndefined();

    const db = service["deps"].db;
    const row = getConnectionFor(db, "calendar", "agent")!;
    expect(row.status).toBe("connected");
    expect(row.account_label).toBe("hey.agnibot@gmail.com");
    const tokens = JSON.parse(row.tokens!) as { refresh_token?: string };
    expect(tokens.refresh_token).toBe("rt_1");

    // The callback is keyed on state, not on the connection the frame opened.
    expect(getConnectionByState(db, state)).toBeNull(); // consumed
    // Snapshot fan-out ends at connected.
    const snapshot = states.at(-1) as { plugins: PluginInfo[] };
    expect(snapshot.plugins.find((entry) => entry.id === "calendar")!.status).toBe("connected");
    // Token endpoint got the exact redirect URI Google must have registered.
    const tokenCall = calls.find((call) => call.url.includes("/token"))!;
    const body = (tokenCall.init?.body as URLSearchParams).toString();
    expect(body).toContain("redirect_uri=http%3A%2F%2F127.0.0.1%3A8787%2Foauth%2Fcallback");
  });

  test("a failed exchange marks the row error, never connected", async () => {
    const { service } = harness(() => new Response("bad_client", { status: 401 }));
    const connect = service.connect("calendar", "agent");
    const state = new URL(connect.authorizeURL!).searchParams.get("state")!;
    const result = await service.completeSignIn(state, "auth-code-2");
    expect(result.plugin).toBeUndefined();
    expect(result.error).toContain("failed");
    const row = getConnectionFor(service["deps"].db, "calendar", "agent")!;
    expect(row.status).toBe("error");
    expect(JSON.parse(row.tokens!) as object).not.toHaveProperty("refresh_token");
  });

  test("a stale or unknown state is refused, not invented", async () => {
    const { service } = harness();
    service.connect("calendar", "agent");
    const result = await service.completeSignIn("st_nope", "code");
    expect(result.error).toContain("stale");
  });

  test("state survives a fresh service over the same database", async () => {
    const db = openDatabase(":memory:");
    const states: ServerFrameBody[] = [];
    const pluginsPath = "/tmp/agni-plugins-test.json";
    writeFileSync(pluginsPath, JSON.stringify({
      version: 1,
      oauthClients: { google: { clientID: "test-client-id", clientSecret: "test-client-secret" } },
      plugins: {},
    }));
    const first = new PluginService({ config: fakeConfig(), db, emit: (body) => states.push(body), pluginsPath });
    const connect = first.connect("calendar", "agent");
    const state = new URL(connect.authorizeURL!).searchParams.get("state")!;

    // A daemon restart: new process, same db.
    const second = new PluginService({ config: fakeConfig(), db, emit: (body) => states.push(body), pluginsPath });
    let step = 0;
    second.fetchOverride = ((url: string | URL | Request) => {
      step += 1;
      return step === 1
        ? Promise.resolve(Response.json({ access_token: "at_2", refresh_token: "rt_2", expires_in: 3600 }))
        : Promise.resolve(Response.json({ email: "hey.agnibot@gmail.com" }));
    }) as typeof fetch;
    const result = await second.completeSignIn(state, "auth-code-3");
    expect(result.plugin).toBe("calendar");
    db.close();
  });
});

// --- disconnect --------------------------------------------------------------

describe("plugin disconnect", () => {
  test("revokes with Google and drops the row", async () => {
    const { service, calls } = harness((url) => {
      if (url.includes("/token")) return Response.json({ access_token: "at_3", refresh_token: "rt_3", expires_in: 3600 });
      return Response.json({ email: "hey.agnibot@gmail.com" });
    });
    await service.completeSignIn(new URL(service.connect("calendar", "agent").authorizeURL!).searchParams.get("state")!, "code");
    const connectionID = getConnectionFor(service["deps"].db, "calendar", "agent")!.id;

    const result = await service.disconnect(connectionID);
    expect(result.error).toBeUndefined();
    expect(getConnections(service["deps"].db)).toHaveLength(0);
    const revokeCall = calls.find((call) => call.url.includes("/revoke"))!;
    expect(new URLSearchParams(String(revokeCall.init?.body)).get("token")).toBe("rt_3");
    expect(service.list().find((entry) => entry.id === "calendar")!.status).toBeUndefined();
  });

  test("unknown connection ids refuse", async () => {
    const { service } = harness();
    const result = await service.disconnect("plc_nope");
    expect(result.error?.code).toBe("unknown_connection");
  });
});

// --- access tokens -----------------------------------------------------------

describe("access tokens for API clients", () => {
  test("returns the stored valid token without a round trip", async () => {
    const { service, calls } = harness((url) => {
      if (url.includes("/token")) return Response.json({ access_token: "at_4", refresh_token: "rt_4", expires_in: 3600 });
      return Response.json({ email: "hey.agnibot@gmail.com" });
    });
    await service.completeSignIn(new URL(service.connect("calendar", "agent").authorizeURL!).searchParams.get("state")!, "code");
    const before = calls.length;
    const token = await service.accessTokenFor("calendar", "agent");
    expect(token).toBe("at_4");
    expect(calls.length).toBe(before); // still fresh — no exchange needed
  });

  test("refreshes an expired access token via the stored refresh token", async () => {
    const { service, calls } = harness((url, step, init) => {
      if (url.includes("/token")) {
        const body = String(init?.body ?? "");
        // Exchange (first) vs refresh grant.
        return body.includes("grant_type=refresh_token")
          ? Response.json({ access_token: "at_fresh", expires_in: 3600 })
          : Response.json({ access_token: "at_4", refresh_token: "rt_4", expires_in: 3600 });
      }
      return Response.json({ email: "hey.agnibot@gmail.com" });
    });
    await service.completeSignIn(new URL(service.connect("calendar", "agent").authorizeURL!).searchParams.get("state")!, "code");
    // Age the stored token out.
    const db = service["deps"].db;
    const row = getConnectionFor(db, "calendar", "agent")!;
    completeConnect(
      db,
      row.id,
      { refresh_token: "rt_kept", access_token: "at_stale", expires_at: Date.now() - 1000 },
      row.account_label ?? "hey.agnibot@gmail.com",
    );
    const entry = service["pluginsFile"].plugins["calendar"]!;
    entry.auth = { ...entry.auth, refresh_token: "rt_kept", access_token: "at_stale", expires_at: Date.now() - 1000 };
    const token = await service.accessTokenFor("calendar", "agent");
    expect(token).toBe("at_fresh");
    const refreshCall = (calls[calls.length - 1]!.init?.body as URLSearchParams).toString();
    expect(refreshCall).toContain("grant_type=refresh_token");
    expect(refreshCall).toContain("rt_kept");
  });

  test("refuses when the plugin is not connected", async () => {
    const { service } = harness();
    await expect(service.accessTokenFor("calendar", "agent")).rejects.toThrow("not connected");
  });
});

// --- oauth url surface -------------------------------------------------------

describe("oauth URL surface", () => {
  test("the redirect URI is the loopback callback on the server port", () => {
    expect(redirectURI(fakeConfig({ port: 8787 }))).toBe("http://127.0.0.1:8787/oauth/callback");
    expect(redirectURI(fakeConfig({ port: 9999 }))).toBe("http://127.0.0.1:9999/oauth/callback");
  });

  test("the authorize URL asks only for the requested scopes", () => {
    const url = authorizeURL({ config: fakeConfig(), clientID: "test-id", clientSecret: "test-secret" }, fakeConfig(), ["https://www.googleapis.com/auth/gmail.modify"], "st_x");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    expect(parsed.searchParams.get("state")).toBe("st_x");
  });
});

// --- store invariants --------------------------------------------------------

describe("plugin connection store", () => {
  test("startPending keeps a stable connection id across re-connects", () => {
    const db = openDatabase(":memory:");
    const first = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    const second = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("pending");
    expect(second.account_label).toBeNull();
    const wrongAccount = getConnectionFor(db, "calendar", "owner");
    expect(wrongAccount).toBeNull();
    db.close();
  });

  test("state lookup matches exactly, never a LIKE prefix accident", () => {
    const db = openDatabase(":memory:");
    startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [], state: "st_abc" });
    startPending(db, { pluginID: "gmail-owner", account: "owner", scopes: ["s"], capabilities: [], state: "st_abcdef" });
    expect(getConnectionByState(db, "st_abc")!.account).toBe("agent");
    expect(getConnectionByState(db, "st_abcdef")!.account).toBe("owner");
    expect(getConnectionByState(db, "st_ab")).toBeNull();
    db.close();
  });

  test("completeConnect overwrites tokens wholesale on re-grant", () => {
    const db = openDatabase(":memory:");
    const row = startPending(db, { pluginID: "calendar", account: "agent", scopes: ["s"], capabilities: [] });
    completeConnect(db, row.id, { refresh_token: "rt_new", access_token: "at_new", expires_at: Date.now() + 1000 }, "a@gmail.com");
    const tokens = JSON.parse(getConnection(db, row.id)!.tokens!) as { state?: string; refresh_token?: string };
    expect(tokens.state).toBeUndefined(); // the pending state is gone once granted
    expect(tokens.refresh_token).toBe("rt_new");
    db.close();
  });
});

describe("plugin credentials reach the tools", () => {
  const pluginsPath = "/tmp/agni-plugins-credentials-test.json";

  function writePlugins(entry: unknown): void {
    writeFileSync(pluginsPath, JSON.stringify({ version: 1, plugins: entry ? { gmail: entry } : {} }));
  }

  test("a mailbox connected in the UI is the one the mail tool uses", () => {
    writePlugins({ account: "agent", enabled: true, auth: { kind: "app-password", user: "agni@example.com", pass: "app-pass" } });

    const credentials = mailCredentialsFromPlugins(pluginsPath, "agent");
    expect(credentials).toEqual({ user: "agni@example.com", pass: "app-pass" });

    const config = resolveMailConfig("agent", pluginMailResolver(pluginsPath));
    expect(config?.user).toBe("agni@example.com");
    expect(config?.pass).toBe("app-pass");
    expect(config?.imapHost).toBe("imap.gmail.com");
  });

  test("a plugin that is not connected yields no credentials", () => {
    writePlugins({ account: "agent", enabled: false, auth: { kind: "app-password", user: "agni@example.com", pass: "app-pass" } });
    expect(mailCredentialsFromPlugins(pluginsPath, "agent")).toBeNull();
    writePlugins(null);
    expect(mailCredentialsFromPlugins(pluginsPath, "owner")).toBeNull();
  });

  test("the owner's mailbox is a different plugin from the agent's", () => {
    writeFileSync(pluginsPath, JSON.stringify({
      version: 1,
      plugins: {
        gmail: { account: "agent", enabled: true, auth: { kind: "app-password", user: "agni@example.com", pass: "a" } },
        "gmail-owner": { account: "owner", enabled: true, auth: { kind: "app-password", user: "owner@example.com", pass: "b" } },
      },
    }));
    expect(mailCredentialsFromPlugins(pluginsPath, "agent")?.user).toBe("agni@example.com");
    expect(mailCredentialsFromPlugins(pluginsPath, "owner")?.user).toBe("owner@example.com");
  });
});

