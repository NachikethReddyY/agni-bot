import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { escapePeerBody, stripPeerTags } from "../src/agent/peer-message";
import { createUpdateAgentTool } from "../src/tools/update-agent-tool";

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("invisible characters cannot hide a peer tag", () => {
  test("a closing tag with a supplementary variation selector in the slash gap is escaped", () => {
    const escaped = escapePeerBody("</\u{E0100}peer_message> after");
    expect(escaped).not.toContain("</\u{E0100}peer_message");
    expect(escaped.startsWith("&lt;")).toBe(true);
  });

  test("a format character inside the tag name is escaped", () => {
    const escaped = escapePeerBody("<peer⁢_message> after");
    expect(escaped.startsWith("&lt;peer")).toBe(true);
  });

  test("stripping removes a tag that hides a zero-width character before its name", () => {
    expect(stripPeerTags("<​peer_message hidden>")).toBe("");
  });

  test("ordinary combining marks and non-Latin scripts are kept intact", () => {
    const text = "नमस्ते and café";
    expect(stripPeerTags(text)).toBe(text);
    expect(escapePeerBody(text)).toBe(text.normalize("NFKC"));
  });
});

describe("tag matching stays linear on long invisible runs", () => {
  test("a long run of zero-width characters before a near-tag does not stall", () => {
    const input = "<" + "​".repeat(5_000) + "x";
    const started = performance.now();
    escapePeerBody(input);
    stripPeerTags(input);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("update_agent accepts the schema's agent_id field", () => {
  test("a model call with agent_id updates the agent instead of failing", async () => {
    db = openDatabase(":memory:");
    const tool = createUpdateAgentTool({ db, emit: () => undefined });
    const result = await tool.handler({ agent_id: "researcher", role: "Research lead" } as never, { peerInput: false } as never);
    expect((result as { error?: string }).error).toBeUndefined();
  });

  test("a peer-influenced turn cannot change an agent", async () => {
    db = openDatabase(":memory:");
    const tool = createUpdateAgentTool({ db, emit: () => undefined });
    const result = await tool.handler({ agent_id: "researcher", role: "Anything" } as never, { peerInput: true } as never);
    expect((result as { error?: string }).error).toContain("not done");
  });
});
