import { Database } from "bun:sqlite";
import type { Preflight } from "./types";
import { assertPublicHost } from "../tools/fetch-url";

const SQL_FORBIDDEN = /\b(PRAGMA|ATTACH|DETACH|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM)\b/i;
const MAX_BODY_BYTES = 1_000_000;

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export async function runPreflight(
  p: Preflight,
  db: Database,
  lastHash: string | null,
): Promise<{ changed: boolean; hash: string }> {
  if (p.kind === "none") {
    const hash = sha256(`${Date.now()}:${crypto.randomUUID()}`);
    return { changed: true, hash };
  }

  if (p.kind === "http") {
    const url = new URL(p.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported URL scheme");
    await assertPublicHost(url.hostname);
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const etag = response.headers.get("etag");
    const hash = etag ?? await hashResponse(response);
    return { changed: hash !== lastHash, hash };
  }

  const query = p.query.trim();
  if (!/^SELECT\b/i.test(query) || query.includes(";") || SQL_FORBIDDEN.test(query)) {
    throw new Error("preflight SQL must be a single read-only SELECT");
  }
  const path = db.filename;
  if (!path || path === ":memory:") throw new Error("read-only preflight requires a file-backed database");
  const readDB = new Database(path, { create: false, readonly: true });
  try {
    const rows = readDB.query(query).all();
    const hash = sha256(JSON.stringify(rows));
    return { changed: hash !== lastHash, hash };
  } finally {
    readDB.close();
  }
}

async function hashResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return sha256(`${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, MAX_BODY_BYTES - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const hasher = new Bun.CryptoHasher("sha256").update(String(response.status)).update(body);
  return hasher.digest("hex");
}
