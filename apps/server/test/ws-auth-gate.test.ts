import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { mintToken } from "../src/auth/tokens";
import type { Config } from "../src/config";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router } from "../src/models/router";
import { allowedOrigin, startServer, type RunningServer } from "../src/ws/server";

/** C5 / H10: one auth gate, no crash on a throwing handler, Origin check on upgrade. */

let server: RunningServer | undefined;
let db: Database | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  db?.close();
  db = undefined;
});

function start(): RunningServer {
  db = openDatabase(":memory:");
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
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
    pluginsPath: "",
  };
  server = startServer(config, db, new Router([], new HealthTracker()));
  return server;
}

function open(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  // Bun's WebSocket accepts headers, which lets the test play a browser.
  const ws = new WebSocket(url, headers ? ({ headers } as unknown as string[]) : undefined);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("refused")), { once: true });
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply")), 2000);
    ws.addEventListener("message", (event) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(event.data)));
    }, { once: true });
  });
}

describe("websocket auth gate", () => {
  test("an unauthenticated appearance.activate gets an error and the server stays up", async () => {
    const running = start();
    const ws = await open(running.url);
    // The audit's repro: rejected by the protocol schema (or the gate) with an error, not a crash.
    ws.send(JSON.stringify({ type: "appearance.activate", id: "x" }));
    expect(await nextMessage(ws)).toMatchObject({ type: "error" });
    // A well-formed id for a profile that does not exist used to throw past the missing auth check.
    ws.send(JSON.stringify({ type: "appearance.activate", id: "theme_missing" }));
    const reply = await nextMessage(ws);
    expect(reply).toMatchObject({ type: "error", code: "unauthorized" });
    // The error answers this socket only and does not burn a shared seq.
    expect(reply.seq).toBe(1);
    ws.close();
    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    expect(health.ok).toBe(true);
  });

  test("a handler that throws answers with an error instead of killing the process", async () => {
    const running = start();
    const { token } = await mintToken(db!, "test-device");
    const ws = await open(running.url);
    const frames: Array<Record<string, unknown>> = [];
    ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data))));
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, token, device: "test" }));
    while (!frames.some((frame) => frame.type === "hello.ok")) await Bun.sleep(10);
    ws.send(JSON.stringify({ type: "appearance.activate", id: "theme_missing" }));
    const deadline = Date.now() + 2000;
    while (!frames.some((frame) => frame.type === "error") && Date.now() < deadline) await Bun.sleep(10);
    expect(frames.find((frame) => frame.type === "error")).toMatchObject({ code: "internal" });
    ws.close();
    expect((await fetch(`http://127.0.0.1:${running.port}/health`)).ok).toBe(true);
  });

  test("a cross-site Origin is refused on upgrade", async () => {
    const running = start();
    const response = await fetch(`http://127.0.0.1:${running.port}/ws`, {
      headers: { origin: "https://evil.example", upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    expect(response.status).toBe(403);
    await expect(open(running.url, { origin: "https://evil.example" })).rejects.toThrow();
  });

  test("no Origin (native clients) and loopback origins are allowed", async () => {
    const running = start();
    (await open(running.url)).close();
    (await open(running.url, { origin: "http://127.0.0.1:5173" })).close();
    expect(allowedOrigin("http://localhost:5173", "127.0.0.1")).toBe(true);
    expect(allowedOrigin("http://[::1]:5173", "127.0.0.1")).toBe(true);
    expect(allowedOrigin("http://100.64.0.1:5173", "100.64.0.1")).toBe(true);
    expect(allowedOrigin("http://localhost.evil.example", "127.0.0.1")).toBe(false);
    expect(allowedOrigin("null", "127.0.0.1")).toBe(false);
  });
});
