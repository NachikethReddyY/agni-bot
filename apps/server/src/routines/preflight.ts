import { Database } from "bun:sqlite";
import type { Preflight } from "./types";
import { isIP } from "node:net";
import { requestPinned, resolvePublicHost } from "../tools/fetch-url";
import { ImapClient } from "../mail/imap";
import { resolveMailConfig } from "../tools/mail";
import type { MailAccountResolver } from "../plugins/credentials";

const SQL_FORBIDDEN = /\b(PRAGMA|ATTACH|DETACH|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM)\b/i;
const MAX_BODY_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;

/** Validate the deliberately narrow SQL preflight language. */
export function assertReadOnlySelect(query: string): void {
  const normalized = query.trim();
  // shortcut: WITH is refused so a recursive CTE cannot block the daemon; allow it again only with a row or time bound.
  if (/\bWITH\b/i.test(normalized)) throw new Error("preflight SQL may not use WITH");
  if (!/^SELECT\b/i.test(normalized) || normalized.includes(";") || SQL_FORBIDDEN.test(normalized)) {
    throw new Error("preflight SQL must be a single read-only SELECT");
  }
}

function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export async function runPreflight(
  p: Preflight,
  db: Database,
  lastHash: string | null,
  mailAccounts?: MailAccountResolver,
): Promise<{ changed: boolean; hash: string }> {
  if (p.kind === "mail") {
    // Event trigger: one cheap UNSEEN search; the hash is the newest unseen UID.
    const cfg = resolveMailConfig(p.account, mailAccounts);
    if (!cfg) throw new Error(`mail preflight: the ${p.account} mailbox is not connected`);
    const client = new ImapClient();
    try {
      await client.connect({ host: cfg.imapHost!, port: cfg.imapPort!, user: cfg.user, pass: cfg.pass });
      await client.select("INBOX");
      const uids = await client.search("UNSEEN");
      const newest = uids.length ? String(Math.max(...uids)) : null;
      return newest === null ? { changed: false, hash: lastHash ?? "" } : { changed: newest !== lastHash, hash: newest };
    } finally {
      await client.close().catch(() => {});
    }
  }
  if (p.kind === "none") {
    const hash = sha256(`${Date.now()}:${crypto.randomUUID()}`);
    return { changed: true, hash };
  }

  if (p.kind === "http") {
    // Redirects are followed by hand so every hop gets the same scheme and public-host checks.
    const signal = AbortSignal.timeout(5_000);
    let url = new URL(p.url);
    let response: Response;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported URL scheme");
      const addresses = await resolvePublicHost(url.hostname);
      // Hostnames connect only to the checked IPs (DNS-rebinding defence); IP literals can't be rebound.
      response = isIP(url.hostname.replace(/^\[|\]$/g, "")) ? await fetch(url, { signal, redirect: "manual" }) : await requestPinned(url, addresses);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status > 399 || !location) break;
      await response.body?.cancel().catch(() => {});
      if (hop === MAX_REDIRECTS) throw new Error("preflight followed too many redirects");
      url = new URL(location, url);
    }
    const etag = response.headers.get("etag");
    const hash = etag ?? await hashResponse(response);
    return { changed: hash !== lastHash, hash };
  }

  const query = p.query.trim();
  assertReadOnlySelect(query);
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
