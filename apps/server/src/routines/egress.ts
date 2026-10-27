// Domain allowlist for a routine's web tools. Plan: docs/routines-plan.md
// (Worker C). Fails closed: anything we cannot read as a bare host denies.

/**
 * Reduce an allowlist entry to a bare hostname, or null when it is malformed.
 * Entries are bare hosts like "example.com". An entry carrying a scheme,
 * slash or port ("https://example.com", "example.com/x", "example.com:8443")
 * is ignored rather than guessed at: a malformed entry must never widen
 * egress, and silently stripping a scheme would let a typo grant a host.
 */
function bareHost(entry: string): string | null {
  const host = entry.trim().toLowerCase();
  if (!host || host.includes("/") || host.includes(":") || host.includes("\\")) return null;
  return host;
}

/** True when `url` is http(s) and its host is an allowed host or subdomain. */
export function domainAllowed(url: string, allowed: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  for (const entry of allowed) {
    const allowedHost = bareHost(entry);
    if (!allowedHost) continue;
    if (host === allowedHost || host.endsWith(`.${allowedHost}`)) return true;
  }
  return false;
}
