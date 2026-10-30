import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { mintPairCode, redeemPairCode } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { allowedOrigin, startServer, type RunningServer } from "../src/ws/server";
import { webAppRequest } from "../src/ws/web-app";

/** Browser pairing: one-time codes, the session cookie, cookie-authed sockets. */

let server: RunningServer | undefined;
let db: Database | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  db?.close();
  db = undefined;
});

function start(): { base: string; db: Database } {
  db = openDatabase(":memory:");
  const config: Config = {
    host: "127.0.0.1", port: 0, dbPath: ":memory:", pidPath: "", logPath: "", providers: [],
    firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000, helloTimeoutMs: 2000, frameLogCapacity: 100,
    jobPollMs: 1000, maxConcurrentTurns: 4, pluginsPath: "",
  };
  server = startServer(config, db, new Router([], new HealthTracker()));
  return { base: `http://127.0.0.1:${server.port}`, db };
}

const ORIGIN = { origin: "http://127.0.0.1:8787" };

async function pair(base: string, code: string, origin = ORIGIN): Promise<Response> {
  return fetch(`${base}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", ...origin },
    body: JSON.stringify({ code, name: "Test Browser" }),
  });
}

function cookieFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("pair codes", () => {
  test("redeem once, case- and dash-insensitive; never twice", async () => {
    const database = openDatabase(":memory:");
    const code = await mintPairCode(database);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await redeemPairCode(database, code.toLowerCase().replace("-", " "))).toBe(true);
    expect(await redeemPairCode(database, code)).toBe(false);
    database.close();
  });

  test("an expired code is refused", async () => {
    const database = openDatabase(":memory:");
    const code = await mintPairCode(database, -1);
    expect(await redeemPairCode(database, code)).toBe(false);
    database.close();
  });
});

describe("/auth", () => {
  test("pair sets an HttpOnly cookie that /auth/session and the socket accept", async () => {
    const { base, db } = start();
    const response = await pair(base, await mintPairCode(db));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const cookie = cookieFrom(response);

    const session = await fetch(`${base}/auth/session`, { headers: { cookie } }).then((r) => r.json());
    expect(session).toEqual({ paired: true, deviceName: "Test Browser" });

    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { cookie, ...ORIGIN } } as unknown as string[]);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (event) => resolve(JSON.parse(String(event.data)));
    });
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, device: "Test Browser" }));
    expect((await reply).type).toBe("hello.ok");
    ws.close();

    const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, ...ORIGIN } });
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await fetch(`${base}/auth/session`, { headers: { cookie } }).then((r) => r.json())).toEqual({ paired: false });
  });

  test("a socket without token or cookie is refused", async () => {
    const { base } = start();
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.onmessage = (event) => resolve(JSON.parse(String(event.data)));
    });
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, device: "x" }));
    expect(await reply).toMatchObject({ type: "error", code: "unauthorized" });
    ws.close();
  });

  test("wrong code, foreign origin, and missing origin are refused", async () => {
    const { base, db } = start();
    expect((await pair(base, "AAAA-AAAA")).status).toBe(401);
    const code = await mintPairCode(db);
    expect((await pair(base, code, { origin: "https://evil.example" })).status).toBe(403);
    expect((await pair(base, code, {} as typeof ORIGIN)).status).toBe(403);
    // The refused attempts did not spend it.
    expect((await pair(base, code)).status).toBe(200);
  });

  test("a https origin gets a Secure cookie when it is the public origin", () => {
    expect(allowedOrigin("https://box.tail1.ts.net", "127.0.0.1", "https://box.tail1.ts.net")).toBe(true);
    expect(allowedOrigin("https://box.tail1.ts.net", "127.0.0.1")).toBe(false);
    expect(allowedOrigin("https://other.ts.net", "127.0.0.1", "https://box.tail1.ts.net")).toBe(false);
  });
});

describe("web app", () => {
  const root = mkdtempSync(join(tmpdir(), "agni-web-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "assets", "a.js"), "js");
  writeFileSync(join(tmpdir(), "agni-secret.txt"), "secret");

  test("serves files, falls back to index.html, never leaves the root", async () => {
    const asset = webAppRequest("/assets/a.js", root);
    expect(await asset.text()).toBe("js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await webAppRequest("/agent/ea", root).text()).toBe("<html>app</html>");
    expect(await webAppRequest("/../agni-secret.txt", root).text()).toBe("<html>app</html>");
    expect(await webAppRequest("/%2e%2e/agni-secret.txt", root).text()).toBe("<html>app</html>");
    expect(webAppRequest("/", join(root, "missing")).status).toBe(404);
  });
});
