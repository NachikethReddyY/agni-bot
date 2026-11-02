/**
 * Web tools. web_search tries providers in order: Firecrawl (cloud or
 * self-hosted), SearXNG, then DuckDuckGo Instant Answer (zero-config).
 * web_fetch reuses fetchPage with SSRF protections; Firecrawl is used for
 * JS-rendered pages when configured.
 */
import { assertPublicHost, fetchPage } from "./fetch-url";
import { firecrawlFromPlugins } from "../plugins/credentials";

const SEARXNG_URL = process.env.AGNI_SEARXNG_URL?.trim();
// Env wins; otherwise the key/URL the owner saved in Settings → Plugins.
let pluginsPath = "";
export function setFirecrawlPluginsPath(path: string): void { pluginsPath = path; }
const fcKey = (): string | undefined => process.env.AGNI_FIRECRAWL_API_KEY?.trim() || firecrawlFromPlugins(pluginsPath)?.key;
const fcUrl = (): string | undefined => process.env.AGNI_FIRECRAWL_URL?.trim() || firecrawlFromPlugins(pluginsPath)?.url;

/** Base URL for Firecrawl API calls (cloud or self-hosted). */
export function firecrawlBase(): string | null {
  const url = fcUrl();
  if (url) return url.replace(/\/$/, "");
  if (fcKey()) return "https://api.firecrawl.dev";
  return null;
}

export interface WebSearchArgs {
  query: string;
  count?: number;
}

export interface WebSearchResult {
  query: string;
  results: { title: string; url: string; snippet: string }[];
  provider: string;
}

/** Firecrawl search: works with cloud (API key) or self-hosted (URL). */
async function searchFirecrawl(query: string, count: number): Promise<WebSearchResult | null> {
  const base = firecrawlBase();
  if (!base) return null;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (fcKey() && !fcUrl()) headers["Authorization"] = `Bearer ${fcKey()}`;
    const response = await fetch(`${base}/v1/search`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers,
      body: JSON.stringify({ query, limit: count }),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { data?: Array<{ title?: string; url?: string; description?: string }> };
    const results = (payload.data ?? []).slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      snippet: entry.description ?? "",
    }));
    if (results.length === 0) return null;
    return { query, results, provider: fcUrl() ? "firecrawl-selfhosted" : "firecrawl" };
  } catch {
    return null;
  }
}

/** SearXNG: self-hosted meta-search. */
async function searchSearXNG(query: string, count: number): Promise<WebSearchResult | null> {
  if (!SEARXNG_URL) return null;
  try {
    const url = new URL(SEARXNG_URL.replace(/\/$/, "") + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (payload.results ?? []).slice(0, count).map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      snippet: entry.content ?? "",
    }));
    if (results.length === 0) return null;
    return { query, results, provider: "searxng" };
  } catch {
    return null;
  }
}

/** DuckDuckGo Instant Answer: zero-config, returns abstracts + related topics. */
async function searchDuckDuckGo(query: string, count: number): Promise<WebSearchResult | null> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const payload = await response.json() as {
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
    };

    const results: { title: string; url: string; snippet: string }[] = [];

    if (payload.AbstractText && payload.AbstractURL) {
      results.push({ title: payload.AbstractText.slice(0, 80), url: payload.AbstractURL, snippet: payload.AbstractText });
    }

    for (const topic of payload.RelatedTopics ?? []) {
      if (topic.FirstURL && topic.Text) {
        results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
      }
      for (const sub of topic.Topics ?? []) {
        if (sub.FirstURL && sub.Text) {
          results.push({ title: sub.Text.slice(0, 80), url: sub.FirstURL, snippet: sub.Text });
        }
      }
    }

    if (results.length === 0) return null;
    return { query, results: results.slice(0, count), provider: "duckduckgo-instant" };
  } catch {
    return null;
  }
}

export async function webSearch(args: WebSearchArgs): Promise<WebSearchResult> {
  const count = Math.max(1, Math.min(args.count ?? 8, 20));

  // Try providers in order: Firecrawl → SearXNG → DuckDuckGo
  const firecrawl = await searchFirecrawl(args.query, count);
  if (firecrawl) return firecrawl;

  const searxng = await searchSearXNG(args.query, count);
  if (searxng) return searxng;

  const ddg = await searchDuckDuckGo(args.query, count);
  if (ddg) return ddg;

  return { query: args.query, results: [], provider: "none (set AGNI_fcUrl() for self-hosted Firecrawl)" };
}

export interface WebFetchArgs {
  url: string;
  maxChars?: number;
}

/** Fetch page content. Uses Firecrawl (cloud or self-hosted) for JS-rendered pages, else fetchPage. */
export async function webFetch(args: WebFetchArgs, allowedHost?: (url: URL) => boolean): Promise<{ title: string | null; summary: string | null; url: string }> {
  // Firecrawl follows redirects on its side, out of reach of allowedHost, so a
  // host-restricted (routine) fetch always goes through fetchPage.
  const base = allowedHost ? null : firecrawlBase();
  // Same checks as fetchPage, before the URL leaves for a third party.
  const target = new URL(args.url);
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("unsupported URL scheme");
  if (target.username || target.password) throw new Error("URLs with credentials are blocked");
  if (allowedHost && !allowedHost(target)) throw new Error("host outside the allowlist");
  if (base) await assertPublicHost(target.hostname);
  if (base) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (fcKey() && !fcUrl()) headers["Authorization"] = `Bearer ${fcKey()}`;
      const response = await fetch(`${base}/v1/scrape`, {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers,
        body: JSON.stringify({ url: args.url, formats: ["markdown"] }),
      });
      if (response.ok) {
        const payload = await response.json() as { data?: { markdown?: string; metadata?: { title?: string } } };
        const title = payload.data?.metadata?.title ?? null;
        let summary = payload.data?.markdown ?? null;
        if (args.maxChars && summary && summary.length > args.maxChars) {
          summary = summary.slice(0, args.maxChars) + "…";
        }
        return { title, summary, url: args.url };
      }
    } catch {
      // Fall through to fetchPage
    }
  }

  const page = await fetchPage(args.url, allowedHost);
  let summary = page.summary ?? null;
  if (args.maxChars && summary && summary.length > args.maxChars) {
    summary = summary.slice(0, args.maxChars) + "…";
  }
  return { title: page.title, summary, url: args.url };
}

/** Deep research: search + fetch top results, return compiled findings. */
export async function deepResearch(args: { query: string; depth?: number }, allowedHost?: (url: URL) => boolean): Promise<{
  query: string;
  findings: { title: string; url: string; snippet: string; content: string | null }[];
  provider: string;
}> {
  const depth = Math.max(1, Math.min(args.depth ?? 3, 5));
  const searchResult = await webSearch({ query: args.query, count: depth + 2 });
  const findings: { title: string; url: string; snippet: string; content: string | null }[] = [];

  const topResults = searchResult.results.slice(0, depth);
  const fetches = await Promise.allSettled(
    topResults.map(async (r) => {
      const page = await webFetch({ url: r.url, maxChars: 2000 }, allowedHost);
      return { title: r.title, url: r.url, snippet: r.snippet, content: page.summary };
    }),
  );

  for (const f of fetches) {
    if (f.status === "fulfilled") findings.push(f.value);
  }

  return { query: args.query, findings, provider: searchResult.provider };
}