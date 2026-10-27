import { describe, expect, test } from "bun:test";
import { domainAllowed, normalizeAllowedDomains } from "../src/routines/egress";

describe("routine egress allowlist", () => {
  test("allows the exact host and its subdomains", () => {
    expect(domainAllowed("https://evil.com/", ["evil.com"])).toBe(true);
    expect(domainAllowed("https://a.evil.com/", ["evil.com"])).toBe(true);
    expect(domainAllowed("HTTPS://EVIL.COM/", ["evil.com"])).toBe(true);
  });

  test("rejects lookalike and suffix-spoofed hosts", () => {
    expect(domainAllowed("https://a.evil.com.attacker.net/", ["evil.com"])).toBe(false);
    expect(domainAllowed("https://notevil.com/", ["evil.com"])).toBe(false);
  });

  test("denies everything when the allowlist is empty", () => {
    expect(domainAllowed("https://evil.com/", [])).toBe(false);
  });

  test("rejects non-http(s) schemes and unparseable input", () => {
    expect(domainAllowed("ftp://evil.com/", ["evil.com"])).toBe(false);
    expect(domainAllowed("not a url", ["evil.com"])).toBe(false);
  });

  test("ignores allowlist entries that are not bare hostnames", () => {
    expect(domainAllowed("https://evil.com/", ["https://evil.com"])).toBe(false);
    expect(domainAllowed("https://evil.com/", ["evil.com/path"])).toBe(false);
    expect(domainAllowed("https://evil.com/", ["evil.com:8443"])).toBe(false);
  });

  test("owner-entered domains are lowercased, de-duplicated, and malformed ones throw", () => {
    expect(normalizeAllowedDomains([" Example.COM ", "example.com", "docs.example.org"])).toEqual(["example.com", "docs.example.org"]);
    expect(normalizeAllowedDomains([])).toEqual([]);
    expect(() => normalizeAllowedDomains(["https://example.com"])).toThrow("not a bare domain");
    expect(() => normalizeAllowedDomains(["example.com/x"])).toThrow("not a bare domain");
    expect(() => normalizeAllowedDomains(["*.example.com"])).toThrow("not a bare domain");
    expect(() => normalizeAllowedDomains([""])).toThrow("not a bare domain");
  });
});
