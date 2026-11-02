/**
 * Browser pairing over HTTP, so the web app never sees a token:
 *
 *   POST /auth/pair     {code, name}  spend a one-time code, set the session cookie
 *   GET  /auth/session                is this browser's cookie a live device?
 *   POST /auth/logout                 revoke this browser's device, clear the cookie
 *
 * The cookie is HttpOnly + SameSite=Strict, and POSTs must come from an
 * allowed origin, so another site can neither read nor ride the session.
 */
import type { Database } from "bun:sqlite";
import { mintToken, redeemPairCode, requestToken, revokeDevice, SESSION_COOKIE, verifyToken } from "./tokens";

const ONE_YEAR_S = 365 * 24 * 60 * 60;

export async function authRequest(
  request: Request,
  db: Database,
  originAllowed: (origin: string) => boolean,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const reply = (data: unknown, status = 200, cookie?: string) =>
    Response.json(data, {
      status,
      headers: { "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) },
    });

  if (pathname === "/auth/session" && request.method === "GET") {
    const token = requestToken(request);
    const device = token ? await verifyToken(db, token) : null;
    return reply(device ? { paired: true, deviceName: device.name } : { paired: false });
  }
  if (request.method !== "POST" || (pathname !== "/auth/pair" && pathname !== "/auth/logout")) {
    return reply({ error: "not found" }, 404);
  }
  const origin = request.headers.get("origin");
  if (origin === null || !originAllowed(origin)) return reply({ error: "forbidden origin" }, 403);
  const cookie = (value: string, maxAge: number) =>
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;

  if (pathname === "/auth/pair") {
    const body = (await request.json().catch(() => null)) as { code?: unknown; name?: unknown } | null;
    if (typeof body?.code !== "string" || !(await redeemPairCode(db, body.code))) {
      return reply({ error: "That code is wrong or expired. Run `agni open` on the server for a new one." }, 401);
    }
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 64) : "Browser";
    const { device, token } = await mintToken(db, name);
    return reply({ paired: true, deviceName: device.name }, 200, cookie(token, ONE_YEAR_S));
  }

  const token = requestToken(request);
  const device = token ? await verifyToken(db, token) : null;
  if (device) revokeDevice(db, device.id);
  return reply({ paired: false }, 200, cookie("", 0));
}
