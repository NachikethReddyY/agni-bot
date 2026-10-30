import { afterEach, expect, test } from "bun:test";
import { fetchPage, requestPinned, resolver } from "../src/tools/fetch-url";
import { buildAppleScript, isCompoundCommand, osAuthPrompt, resolveAuthMode, runPrivilegedWithOSAuth } from "../src/tools/privileged-os";

const realLookup = resolver.lookup;
afterEach(() => { resolver.lookup = realLookup; });

test("a hostname that resolves to loopback is blocked", async () => {
  resolver.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as never;
  await expect(fetchPage("http://rebind.example.test/")).rejects.toThrow("private or reserved address blocked");
});

test("the connection goes to the pinned IP whatever DNS says", async () => {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(`<title>pinned</title>${r.headers.get("host")}`, { headers: { "content-type": "text/html" } }) });
  try {
    resolver.lookup = (async () => { throw new Error("DNS must not be consulted"); }) as never;
    const res = await requestPinned(new URL(`http://pin.example.test:${srv.port}/`), ["127.0.0.1"]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`pin.example.test:${srv.port}`);
  } finally { srv.stop(true); }
});

test("os-mode AppleScript has a prompt with escaped quotes and backslashes", () => {
  const script = buildAppleScript('sudo echo "hi" \\ there');
  expect(script).toContain('with prompt "Agni wants to run as root: sudo echo \\"hi\\" \\\\ there"');
  expect(script).toContain("with administrator privileges");
});

test("long commands keep head and tail in the prompt", () => {
  const p = osAuthPrompt(`sudo ${"a".repeat(1000)}END`);
  expect(p.length).toBeLessThan(400);
  expect(p).toEndWith("END");
  expect(p).toContain("sudo");
});

test("compound commands are refused in os-mode and never auto-picked", async () => {
  for (const c of ["sudo a; b", "sudo a && b", "sudo a || b", "sudo a | b", "sudo `b`", "sudo $(b)", "sudo a\nb"]) {
    expect(isCompoundCommand(c)).toBe(true);
    expect(resolveAuthMode("auto", c)).toBe("password");
    const r = await runPrivilegedWithOSAuth(c);
    expect(r.exitCode).toBe(1);
    expect(r.usedOSAuth).toBe(false);
    expect(r.stderr).toContain("one simple command");
  }
  expect(isCompoundCommand("sudo launchctl list")).toBe(false);
});
