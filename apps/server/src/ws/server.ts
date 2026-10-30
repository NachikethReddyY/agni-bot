import { attachmentRequest } from "../attachments/http";
import { backgroundRequest } from "../appearance/http";
import { debugRequest } from "../debug/http";
/**
 * HTTP + WebSocket entry. Binds to AGNI_HOST only (loopback in dev, the
 * Tailscale interface on bb-1) — nothing listens on the public internet.
 *
 * Routes: GET /health (JSON), GET /ws (WebSocket upgrade), GET /share/<token>
 * (a published thread export), GET /debug/* (owner-only bot debugger data).
 */
import type { Database } from "bun:sqlite";
import { PROTOCOL_VERSION, encodeFrame, type ServerFrame, type ServerFrameBody } from "@agni/protocol";
import type { Config } from "../config";
import { readMeta, writeMeta } from "../db";
import { log } from "../log";
import { PluginService } from "../plugins/service";
import type { Router, ProviderStatus } from "../models/router";
import { dayTotals, type DayTotals } from "../stores/usage";
import { readShareFile } from "../share/document";
import { dispatch, errorFrame, newSession, type Session } from "./dispatch";
import { FrameLog } from "./frame-log";
import { dirname, resolve } from "node:path";
import { ChatGPTAuth } from "../models/chatgpt-auth";

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  /** Plugin connection state lives here (settings pane snapshots, OAuth). */
  readonly plugins: PluginService | undefined;
  /** Fan out a frame to every authed session (job results, notices). */
  emit(body: ServerFrameBody): ServerFrame;
  stop(): void;
}

/**
 * The daemon's read-only health snapshot is safe to expose to any origin: it
 * carries no secrets, and a web client paired on another origin must be able
 * to read it before it opens the socket.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "accept, content-type",
} as const;

/** Shape of `GET /health` — also what `daemon status` shows. */
export interface HealthReport {
  ok: boolean;
  v: number;
  serverTime: string;
  uptimeMs: number;
  seq: number;
  providers: ProviderStatus[];
  usageToday: DayTotals;
  modelCapacity: { active: number; capacity: number };
}

export function healthReport(db: Database, router: Router, seq: number, startedAt: number): HealthReport {
  return {
    ok: true,
    v: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    uptimeMs: Date.now() - startedAt,
    seq,
    providers: router.status(),
    usageToday: dayTotals(db),
    modelCapacity: router.load(),
  };
}

export function startServer(config: Config, db: Database, router: Router, startedAt = Date.now()): RunningServer {
  const frameLog = new FrameLog(config.frameLogCapacity, (seq) => writeMeta(db, "seq", String(seq)));
  frameLog.adoptSeq(Number.parseInt(readMeta(db, "seq") ?? "0", 10) || 0);

  const sessions = new Map<Bun.ServerWebSocket<Session>, Session>();

  const emit = (body: ServerFrameBody): ServerFrame => {
    const frame = frameLog.next(body);
    for (const [socket, session] of sessions) {
      if (session.authed) socket.send(encodeFrame(frame));
    }
    return frame;
  };

  const plugins = new PluginService({ config, db, emit, pluginsPath: config.pluginsPath });
  plugins.autoConnect();
  const chatgpt = new ChatGPTAuth({
    filePath: config.dbPath === ":memory:" ? null : resolve(dirname(config.dbPath), "chatgpt/accounts.json"),
    onChange: () => {
      const connection = chatgpt.state();
      if (connection.status === "connected" && !connection.message) router.connectionReady("chatgpt");
      emit({ type: "provider.auth.state", providerID: "chatgpt", connection });
    },
  });
  router.setChatGPT(chatgpt);

  const server = Bun.serve<Session>({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 10 * 1024 * 1024 + 65_536,
    async fetch(request, srv) {
      const url = new URL(request.url);
      if (url.pathname === "/attachments" || url.pathname.startsWith("/attachments/")) {
        return attachmentRequest(request, db, config.dbPath, router);
      }
      if (url.pathname === "/backgrounds" || url.pathname.startsWith("/backgrounds/")) {
        return backgroundRequest(request, db, config.dbPath);
      }
      if (url.pathname.startsWith("/debug/")) {
        return debugRequest(request, db, router, config);
      }
      if (url.pathname === "/health") {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }
        return Response.json(healthReport(db, router, frameLog.seq, startedAt), {
          headers: { ...CORS_HEADERS, "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/oauth/callback") {
        return handleOAuthCallback(plugins, url);
      }
      // Exported threads. Tokens are opaque file names, validated by the
      // reader, so this route can never be walked out of the share directory.
      const share = /^\/share\/([0-9a-f]{32})(?:\.html)?$/.exec(url.pathname);
      if (share) {
        const html = readShareFile(share[1] ?? "");
        if (html === null) return new Response("This export no longer exists.", { status: 404 });
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/ws") {
        // Browsers always send Origin; native clients (Mac, CLI) send none.
        // Refusing foreign origins stops any web page (or a DNS-rebound
        // name) in the owner's browser from driving the socket.
        const origin = request.headers.get("origin");
        if (origin !== null && !allowedOrigin(origin, config.host)) {
          return new Response("forbidden origin", { status: 403 });
        }
        if (srv.upgrade(request, { data: newSession() })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        socket.data.local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.remoteAddress);
        sessions.set(socket, socket.data);
        socket.data.helloTimer = setTimeout(() => {
          if (!socket.data.authed) socket.close(4001, "hello timeout");
        }, config.helloTimeoutMs);
        log.debug(`connection ${socket.data.id} opened (${sessions.size} open)`);
      },
      async message(socket, message) {
        if (typeof message !== "string") return;
        const session = socket.data;
        try {
          await dispatch(
            {
              config,
              db,
              router,
              frameLog,
              emit,
              plugins,
              chatgpt,
              reply: (body) => {
                const frame = frameLog.next(body, { replay: false });
                socket.send(encodeFrame(frame));
                return frame;
              },
              send: (frame) => socket.send(encodeFrame(frame)),
              close: (code, reason) => socket.close(code, reason),
            },
            session,
            message,
          );
        } catch (error) {
          // A throwing handler answers its own connection; it never takes the daemon down.
          log.error(`frame handler failed on ${session.id}`, error);
          socket.send(encodeFrame(errorFrame(frameLog, "internal", error instanceof Error ? error.message : String(error))));
        }
      },
      close(socket) {
        const session = socket.data;
        if (session.helloTimer !== undefined) clearTimeout(session.helloTimer);
        for (const controller of session.aborts.values()) controller.abort();
        session.aborts.clear();
        sessions.delete(socket);
        log.debug(`connection ${session.id} closed (${sessions.size} open)`);
      },
    },
  });

  return {
    port: server.port ?? config.port,
    url: `ws://${config.host}:${server.port ?? config.port}/ws`,
    plugins,
    emit,
    stop() {
      chatgpt.stop();
      server.stop(true);
      frameLog.flush();
    },
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Loopback pages (the Vite web client) and pages served from the daemon's own bound host. */
export function allowedOrigin(origin: string, host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  const bound = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return LOOPBACK_HOSTS.has(hostname) || hostname === bound;
}

/**
 * The Google OAuth redirect lands here from the system browser: one static
 * page confirming what happened, while the real state flows through frames
 * (`plugin.state`) into every open client. No scripts, no redirects back.
 */
async function handleOAuthCallback(plugins: PluginService | undefined, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const oauthError = url.searchParams.get("error");
  const title = "Agni · connecting";
  if (!plugins) {
    return staticPage(title, "The plugin service is not running on this server.");
  }
  if (oauthError) {
    return staticPage(title, `Google refused the sign-in (${oauthError}). Nothing was connected — try again from the settings pane.`);
  }
  if (!state || !code) {
    return staticPage(title, "This callback is missing its sign-in context. Connect again from the settings pane.");
  }
  const result = await plugins.completeSignIn(state, code);
  const body =
    result.plugin
      ? `${result.plugin} is connected. You can close this tab — the app updates itself.`
      : `Something went wrong: ${result.error ?? "unknown error"}\nNothing is connected; try again from the settings pane.`;
  return staticPage(title, body);
}

function staticPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{background:#000;color:#fff;font:15px/1.6 ui-sans-serif,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:420px;padding:24px}p{white-space:pre-line;margin:0}</style>
</head>
<body><main><p>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p></main></body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
