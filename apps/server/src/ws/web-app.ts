/**
 * The built web app (apps/web/dist), served same-origin with the socket so a
 * browser needs no address and its session cookie just works. Unknown paths
 * fall back to index.html for the client-side routes (/agent/…, /tasks/…).
 */
import { statSync } from "node:fs";
import { resolve, sep } from "node:path";

export function webDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.AGNI_WEB_DIR?.trim() || resolve(import.meta.dir, "../../../web/dist"));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function webAppRequest(pathname: string, root = webDir()): Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("bad path", { status: 400 });
  }
  const path = resolve(root, `.${decoded}`);
  if (path.startsWith(root + sep) && isFile(path)) {
    // Vite fingerprints everything under assets/, so those never change.
    const immutable = path.startsWith(resolve(root, "assets") + sep);
    return new Response(Bun.file(path), {
      headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }
  const index = resolve(root, "index.html");
  if (!isFile(index)) {
    return new Response("The web app is not built yet. Run `bun run web:build`, then reload.", { status: 404 });
  }
  return new Response(Bun.file(index), { headers: { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8" } });
}
