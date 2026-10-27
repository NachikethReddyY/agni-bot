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
  const addresses = isIP(name) ? [{ address: name }] : await lookup(name, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIP(address))) throw new Error("private or reserved address blocked");
}

function isPublicIP(address: string): boolean {
  if (address.includes(":")) {
    const ip = address.toLowerCase();
    return !(ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb") || ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.") || ip.startsWith("::ffff:192.168."));
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => n < 0 || n > 255)) return false;
  const [a=0,b=0] = octets;
  return !(a===0 || a===10 || a===127 || a>=224 || (a===100&&b>=64&&b<=127) || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===192&&b===0) || (a===198&&(b===18||b===19)));
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
