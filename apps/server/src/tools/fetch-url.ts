import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECT_HOPS = 2;
/** Hard cap on page bytes; SPAs stay bounded. */
const MAX_BYTES = 3_000_000;
/** Extra bytes read past the <title> so the summary has something useful. */
const SUMMARY_TAIL_BYTES = 200_000;

/**
 * Fetch a public web page without accepting private hosts. Redirects are
 * followed (the web is full of them — youtu.be → youtube.com), but every hop
 * re-runs the same safety checks on its new host, within a hop cap. When
 * `allowedHost` is given, a hop to a host it rejects fails before any request.
 */
export async function fetchPage(rawURL: string, allowedHost?: (url: URL) => boolean): Promise<{ title: string|null; summary: string|null }> {
  let current = parsePublicURL(rawURL);
  for (let hop = 0; ; hop += 1) {
    const response = await fetchOne(current);
    if (!(response.status >= 300 && response.status < 400)) {
      return readPage(response);
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect with no destination");
    if (hop >= MAX_REDIRECT_HOPS) throw new Error("too many redirects");
    current = parsePublicURL(new URL(location, current).toString());
    if (allowedHost && !allowedHost(current)) throw new Error("redirect to a host outside the allowlist");
  }
}

function parsePublicURL(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported URL scheme");
  if (url.username || url.password) throw new Error("URLs with credentials are blocked");
  url.hash = "";
  return url;
}

async function fetchOne(url: URL): Promise<Response> {
  await assertPublicHost(url.hostname);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, redirect: "manual", headers: { accept: "text/html,text/plain;q=0.8" } });
  } finally { clearTimeout(timer); }
}

async function readPage(response: Response): Promise<{ title: string|null; summary: string|null }> {
  if (!response.ok) throw new Error(`page fetch returned HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("text/html") && !type.includes("text/plain")) throw new Error("page is not HTML or plain text");
  const reader = response.body?.getReader();
  if (!reader) return { title: null, summary: null };
  try {
    // Watch pages (YouTube-style SPAs) ship megabytes of HTML that mean
    // nothing to us. Read until the <title> shows up (it lives in the first
    // kilobytes), take a bounded extra slice for the summary, and stop —
    // never draining the whole monster.
    let html = "";
    let size = 0;
    let tailAllowance = Infinity;
    const decoder = new TextDecoder();
    while (true) {
      if (size > tailAllowance) { await reader.cancel(); break; }
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error("page exceeds 3 MB limit"); }
      html += decoder.decode(value, { stream: true });
      if (tailAllowance === Infinity && /<\/title>/i.test(html)) {
        tailAllowance = size + SUMMARY_TAIL_BYTES;
      }
    }
    return extractPage(html, type.includes("text/plain"));
  } finally { reader.cancel().catch(() => {}); }
}

export async function assertPublicHost(host: string): Promise<void> {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) throw new Error("private host blocked");
  // shortcut: Bun fetch cannot pin the connection to the checked IP, so a
  // rebinding resolver can still answer differently at connect time; upgrade by
  // connecting to the resolved IP (node:http lookup hook) with Host/SNI set.
  const addresses = isIP(name) ? [{ address: name }] : await lookup(name, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("private or reserved address blocked");
}

/** True for loopback, private, link-local, multicast, reserved or unparseable addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip.split(".").map(Number));
  if (kind !== 6) return true;
  const h = parseV6(ip);
  if (!h) return true;
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  // ::, ::1, and IPv4-compatible ::a.b.c.d (0.0.0.x is covered by the 0/8 rule)
  if (h.slice(0, 6).every((x) => x === 0)) return isPrivateV4(v4(h[6]!, h[7]!));
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPrivateV4(v4(h[6]!, h[7]!)); // ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) return isPrivateV4(v4(h[6]!, h[7]!)); // NAT64
  return (h[0]! & 0xfe00) === 0xfc00 || (h[0]! & 0xffc0) === 0xfe80 || (h[0]! & 0xffc0) === 0xfec0 || (h[0]! & 0xff00) === 0xff00;
}

function isPrivateV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

/** Expand an IPv6 literal to 8 hextets; null when malformed. */
function parseV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = tail[1]!.split(".").map(Number);
    text = text.slice(0, -tail[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const [left = "", right, extra] = text.split("::");
  if (extra !== undefined) return null;
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  const fill = 8 - l.length - r.length;
  if (right === undefined ? fill !== 0 : fill < 1) return null;
  const parts = [...l, ...Array(right === undefined ? 0 : fill).fill("0"), ...r].map((x) => parseInt(x, 16));
  return parts.length === 8 && parts.every((x) => x >= 0 && x <= 0xffff) ? parts : null;
}

function extractPage(input: string, plain: boolean): { title: string|null; summary: string|null } {
  const title = plain ? null : decodeEntities(input.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 300) || null;
  const text = plain ? input : input
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const clean = decodeEntities(text).replace(/\s+/g, " ").trim();
  return { title, summary: clean.slice(0, 600) || null };
}
function decodeEntities(text: string): string { return text.replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#(\d+);/g,(_, n:string)=>String.fromCodePoint(Number(n))); }
