import { afterEach, expect, test } from "bun:test";
import { fetchPage } from "../src/tools/fetch-url";

// IP literals skip DNS and fetch is stubbed, so nothing here touches the network.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(routes: Record<string, Response>): string[] {
  const requested: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const response = routes[url];
    if (!response) throw new Error(`unexpected request ${url}`);
    return response;
  }) as typeof fetch;
  return requested;
}

test("a redirect off the allowlist is refused before the second host is requested", async () => {
  const requested = stubFetch({
    "http://93.184.216.34/": new Response(null, { status: 302, headers: { location: "http://93.184.216.35/x" } }),
  });
  const allowed = (url: URL) => url.hostname === "93.184.216.34";
  await expect(fetchPage("http://93.184.216.34/", allowed)).rejects.toThrow("redirect to a host outside the allowlist");
  expect(requested).toEqual(["http://93.184.216.34/"]);
});

test("without a predicate a redirect is followed as before", async () => {
  const requested = stubFetch({
    "http://93.184.216.34/": new Response(null, { status: 301, headers: { location: "http://93.184.216.35/final" } }),
    "http://93.184.216.35/final": new Response("<html><title>Hi</title><body>hello</body></html>", { headers: { "content-type": "text/html" } }),
  });
  const page = await fetchPage("http://93.184.216.34/");
  expect(page.title).toBe("Hi");
  expect(requested).toEqual(["http://93.184.216.34/", "http://93.184.216.35/final"]);
});
