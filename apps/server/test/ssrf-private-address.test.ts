import { afterEach, expect, test } from "bun:test";
import { isPrivateAddress } from "../src/tools/fetch-url";

test("private and reserved addresses", () => {
  for (const ip of ["[::ffff:7f00:1]", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "::7f00:1", "fec0::1", "::1", "::", "fe80::1", "fd00::1", "ff02::1", "127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.0.1", "224.0.0.1"]) {
    expect(isPrivateAddress(ip)).toBe(true);
  }
});

test("public addresses", () => {
  for (const ip of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) expect(isPrivateAddress(ip)).toBe(false);
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("firecrawl path refuses a private URL before any request", async () => {
  process.env.AGNI_FIRECRAWL_URL = "http://firecrawl.test";
  const { webFetch } = await import("../src/tools/web");
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => { calls.push(String(input)); return new Response("{}"); }) as typeof fetch;
  await expect(webFetch({ url: "http://127.0.0.1/" })).rejects.toThrow("blocked");
  await expect(webFetch({ url: "http://[::ffff:7f00:1]/" })).rejects.toThrow("blocked");
  expect(calls).toEqual([]);
});
