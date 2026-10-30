import { join, resolve, sep } from "path";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.LANDING_HOST || "127.0.0.1";
const DIR = import.meta.dir;

/**
 * Resolve a request path under `base`, or null when it escapes `base` or
 * names a dotfile. Guards against `/..%2F..%2F.env` after decoding.
 */
function under(base: string, pathname: string): string | null {
  if (pathname.split("/").some((seg) => seg.startsWith("."))) return null;
  const full = resolve(join(base, pathname));
  return full.startsWith(resolve(base) + sep) ? full : null;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch(req) {
    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (pathname === "/") {
      pathname = "/index.html";
    }

    // Try apps/landing/<path>, then apps/landing/public/<path>
    for (const base of [DIR, join(DIR, "public")]) {
      const filePath = under(base, pathname);
      if (!filePath) continue;
      const file = Bun.file(filePath);
      if (file.size > 0) {
        const ext = pathname.substring(pathname.lastIndexOf("."));
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        return new Response(file, {
          headers: {
            "Content-Type": contentType,
            "Cache-Control": "no-cache",
          },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🔥 Agni landing page serving at http://${HOST}:${server.port}`);
