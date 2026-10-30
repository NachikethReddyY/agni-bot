import { attachmentRequest } from "../attachments/http";
import { backgroundRequest } from "../appearance/http";
import { debugRequest } from "../debug/http";
/**
 * HTTP + WebSocket entry. Binds to AGNI_HOST only (loopback in dev, the
 * Tailscale interface on bb-1) — nothing listens on the public internet.
 *
 * Routes: GET /health (JSON), GET /ws (WebSocket upgrade), GET /share/<token>
 * (a published thread export), GET /debug/* (owner-only bot debugger data),
 * /auth/* (browser pairing), and the built web app for everything else.
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
import { dispatch, errorFrame, newSession, resumeQueuedMessages, type DispatchDeps, type Session } from "./dispatch";
import { isDeviceRevoked, requestToken, verifyToken } from "../auth/tokens";
import { authRequest } from "../auth/web";
import { webAppRequest } from "./web-app";
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

  /** A live frame for one connection: held while it waits for its resync replay (H32). */
  const deliver = (socket: Bun.ServerWebSocket<Session>, frame: ServerFrame): void => {
    if (socket.data.held) socket.data.held.push(frame);
    else socket.send(encodeFrame(frame));
  };

  const emit = (body: ServerFrameBody): ServerFrame => {
    const frame = frameLog.next(body);
    for (const [socket, session] of sessions) {
      if (session.authed) deliver(socket, frame);
    }
    return frame;
  };

  // M1: `revoke` runs in another process, so the daemon looks for revoked
  // devices among its open sessions and closes them.
  const revocationSweep = setInterval(() => {
    for (const [socket, session] of sessions) {
      if (!session.authed || !session.device || !isDeviceRevoked(db, session.device.id)) continue;
      session.authed = false;
      socket.close(4003, "revoked");
    }
  }, REVOCATION_SWEEP_MS);

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
      if (url.pathname.startsWith("/auth/")) {
        return authRequest(request, db, (origin) => allowedOrigin(origin, config.host, config.publicOrigin));
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
        if (origin !== null && !allowedOrigin(origin, config.host, config.publicOrigin)) {
          return new Response("forbidden origin", { status: 403 });
        }
        const session = newSession();
        // A paired browser's cookie authenticates the socket; `hello` then needs no token.
        const token = requestToken(request);
        const device = token ? await verifyToken(db, token) : null;
        if (device) session.cookieDevice = { id: device.id, name: device.name };
        // Behind a proxy (tailscale serve) every peer is 127.0.0.1, so a
        // forwarded request or a non-loopback page is never "local".
        session.local = LOOPBACK_IPS.has(srv.requestIP(request)?.address ?? "")
          && !request.headers.has("x-forwarded-for")
          && (origin === null || LOOPBACK_HOSTS.has(new URL(origin).hostname));
        if (srv.upgrade(request, { data: session })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (request.method === "GET" || request.method === "HEAD") return webAppRequest(url.pathname);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
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
                deliver(socket, frame);
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
        if (session.holdTimer !== undefined) clearTimeout(session.holdTimer);
        for (const controller of session.aborts.values()) controller.abort();
        session.aborts.clear();
        sessions.delete(socket);
        log.debug(`connection ${session.id} closed (${sessions.size} open)`);
      },
    },
  });

  // H22: owner messages a previous process accepted but never started. They
  // have no connection; their answers reach every client through `emit`.
  const bootDeps: DispatchDeps = {
    config, db, router, frameLog, emit, plugins, chatgpt,
    reply: (body) => frameLog.next(body, { replay: false }),
    send: () => undefined,
    close: () => undefined,
  };
  const resumed = resumeQueuedMessages(bootDeps);
  if (resumed > 0) log.warn(`resumed ${resumed} owner message(s) a previous process left queued`);

  return {
    port: server.port ?? config.port,
    url: `ws://${config.host}:${server.port ?? config.port}/ws`,
    plugins,
    emit,
    stop() {
      clearInterval(revocationSweep);
      chatgpt.stop();
      server.stop(true);
      frameLog.flush();
    },
  };
}

const REVOCATION_SWEEP_MS = 2_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Loopback pages, pages served from the daemon's own bound host, and the
 * owner's AGNI_PUBLIC_ORIGIN (e.g. the `tailscale serve` https name).
 */
export function allowedOrigin(origin: string, host: string, publicOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const bound = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  if (LOOPBACK_HOSTS.has(parsed.hostname) || parsed.hostname === bound) return true;
  try {
    return publicOrigin !== undefined && new URL(publicOrigin).origin === parsed.origin;
  } catch {
    return false;
  }
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
