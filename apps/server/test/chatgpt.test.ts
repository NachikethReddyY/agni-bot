import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTAuth, chatGPTEnabled } from "../src/models/chatgpt-auth";
import { chatGPTPage } from "../src/models/chatgpt-page";
import { responsesBody, streamChatGPT } from "../src/models/chatgpt-responses";
import type { ChatRequest } from "../src/models/client";
import { Router } from "../src/models/router";
import { HealthTracker } from "../src/models/health";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "unit-signing-key", alg: "RS256", use: "sig" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function jwt(claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), pair.privateKey).toString("base64url")}`;
}
function stream(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
const done = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 3 } } };

function harness(options: { path?: string; claims?: Record<string, unknown>; scope?: string; revokeFails?: boolean; badSignature?: boolean } = {}) {
  let now = Date.now();
  let nonce = "";
  let refreshCount = 0;
  let refreshFailure = "";
  let modelUnavailable = false;
  let refreshGate: Promise<void> | undefined;
  const requests: Array<{ url: string; body: URLSearchParams | null }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const body = init?.body instanceof URLSearchParams ? init.body : null;
    requests.push({ url: target, body });
    if (target.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
    if (target.endsWith("/oauth/revoke")) return new Response(null, { status: options.revokeFails ? 503 : 200 });
    if (target.endsWith("/oauth/token")) {
      const refreshing = body?.get("grant_type") === "refresh_token";
      if (refreshing) {
        refreshCount++;
        await refreshGate;
        await Promise.resolve();
        if (refreshFailure) return Response.json({ error: refreshFailure }, { status: refreshFailure === "server_error" ? 503 : 400 });
      }
      return Response.json({ access_token: randomBytes(24).toString("base64url"), refresh_token: randomBytes(24).toString("base64url"),
        id_token: jwt({ iss: "https://auth.openai.com", aud: body?.get("client_id"), sub: "unit-user", email: "unit@example.test", nonce, exp: Math.floor(now / 1000) + 3600, ...options.claims }) + (options.badSignature ? "tampered" : ""),
        expires_in: 3600, token_type: "Bearer", scope: options.scope ?? "openid offline_access resource.invoke chatgpt.tokens.use.direct" });
    }
    if (target.endsWith("/models")) return modelUnavailable ? new Response(null, { status: 503 }) : Response.json({ models: [
      { slug: "unit-model", display_name: "Available model", visibility: "list", input_modalities: ["text", "image"] },
      { slug: "internal-model", display_name: "Hidden", visibility: "hidden" },
    ] });
    if (target.endsWith("/responses")) return stream({ type: "response.output_text.delta", delta: "Hello" }, done);
    throw new Error("Unexpected request in isolated test");
  }) as typeof fetch;
  const auth = new ChatGPTAuth({ filePath: options.path ?? null, fetchFn, now: () => now });
  cleanups.push(() => auth.stop());
  async function begin(accountID?: string) {
    const login = await auth.start("unit-device", accountID);
    const url = new URL(login.authorizeURL);
    nonce = url.searchParams.get("nonce")!;
    return { login, url };
  }
  async function complete(accountID?: string, query: Record<string, string> = {}) {
    const { url } = await begin(accountID);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "unit-code", client_id: "unit-issued-client", ...query }).toString();
    return fetch(callback);
  }
  return { auth, begin, complete, requests, fetchFn, advance: () => { now += 3_601_000; }, refreshCount: () => refreshCount,
    failRefresh: (code: string) => { refreshFailure = code; }, failModels: () => { modelUnavailable = true; },
    blockRefresh: () => { let release!: () => void; refreshGate = new Promise<void>((resolve) => { release = resolve; }); return release; } };
}

const savedFlag = process.env.AGNI_CHATGPT;
function setChatGPTFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.AGNI_CHATGPT; else process.env.AGNI_CHATGPT = value;
}

describe("ChatGPT gating (AGNI_CHATGPT, off by default)", () => {
  beforeEach(() => setChatGPTFlag(undefined));
  afterAll(() => setChatGPTFlag(savedFlag));

  test("the flag is off unless set to exactly 1", () => {
    expect(chatGPTEnabled()).toBe(false);
    setChatGPTFlag("true");
    expect(chatGPTEnabled()).toBe(false);
    setChatGPTFlag("1");
    expect(chatGPTEnabled()).toBe(true);
  });

  test("with the flag unset the router never selects ChatGPT and falls back to free providers", async () => {
    setChatGPTFlag("1");
    const h = harness(); await h.complete(); // Signed in while enabled, then the flag is switched off.
    setChatGPTFlag(undefined);
    const free = { id: "free", label: "Free", apiKey: "unit", baseUrl: "https://free.test", model: "unit" };
    const router = new Router([free], new HealthTracker(), h.fetchFn);
    router.setChatGPT(h.auth);
    expect(router.candidates().map((p) => p.id)).toEqual(["free"]);
    expect(router.status().map((p) => p.id)).toEqual(["free"]);
    expect(h.requests.some((r) => r.url.endsWith("/responses"))).toBe(false);
  });

  test("with the flag unset a ChatGPT-only router does not return needsLogin", async () => {
    setChatGPTFlag("1");
    const h = harness(); await h.complete();
    setChatGPTFlag(undefined);
    const router = new Router([], new HealthTracker(), h.fetchFn);
    router.setChatGPT(h.auth);
    expect(router.candidates()).toEqual([]);
    await expect(router.route({ messages: [{ role: "user", content: "hi" }], firstTokenTimeoutMs: 1000, onDelta() {} }))
      .rejects.toThrow("no model providers configured");
  });

  test("starting a login with the flag unset returns a clear error", async () => {
    const h = harness();
    await expect(h.auth.start("unit-device")).rejects.toThrow("ChatGPT sign-in is disabled (set AGNI_CHATGPT=1)");
  });
});

describe("ChatGPT account file", () => {
  beforeEach(() => setChatGPTFlag("1"));
  afterAll(() => setChatGPTFlag(savedFlag));

  test("a corrupt accounts.json does not throw, is not overwritten, and blocks sign-in", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agni-chatgpt-corrupt-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "accounts.json");
    const corrupt = '{"version":1,"accounts":[{"tokens":';
    writeFileSync(path, corrupt);
    let auth!: ChatGPTAuth;
    expect(() => { auth = new ChatGPTAuth({ filePath: path, fetchFn: fetch }); }).not.toThrow();
    cleanups.push(() => auth.stop());
    expect(auth.state()).toMatchObject({ status: "error", accounts: [] });
    expect(auth.provider()).toBeUndefined();
    await expect(auth.start("unit-device")).rejects.toThrow("could not be read");
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  });
});

describe("ChatGPT OAuth", () => {
  beforeAll(() => setChatGPTFlag("1"));
  afterAll(() => setChatGPTFlag(savedFlag));
  test("callback pages escape messages and allow only the bundled stylesheet", async () => {
    const response = chatGPTPage('<script>alert("untrusted")</script>', 400);
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    const hash = createHash("sha256").update(style).digest("base64");
    expect(response.headers.get("content-security-policy")).toContain(`style-src 'sha256-${hash}'`);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  test("registers Agni with a stable host, fresh PKCE and no secret in the browser URL", async () => {
    const h = harness();
    const first = await h.begin();
    expect(first.url.origin).toBe("https://auth.openai.com");
    expect(first.url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(first.url.searchParams.get("agent_name_hint")).toBe("Agni");
    expect(first.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(first.url.searchParams.has("id_token_hint")).toBe(false);
    expect(first.url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    h.auth.cancel("different-device", first.login.loginID);
    expect(h.auth.state().status).toBe("pending");
    h.auth.cancel("unit-device", first.login.loginID);
    const second = await h.begin();
    expect(second.url.searchParams.get("ext_agent_host_id")).toBe(first.url.searchParams.get("ext_agent_host_id"));
    expect(second.url.searchParams.get("state")).not.toBe(first.url.searchParams.get("state"));
    expect(second.url.searchParams.get("code_challenge")).not.toBe(first.url.searchParams.get("code_challenge"));
  });

  test("validates state before exchanging a code", async () => {
    const h = harness();
    const { url } = await h.begin();
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = "state=invalid&code=unit-code&client_id=unit-issued-client";
    expect((await fetch(callback)).status).toBe(400);
    expect(h.requests).toHaveLength(0);
    expect(h.auth.state().status).toBe("pending");
  });

  test("exchanges the issued client ID, verifies identity, and picks an eligible model", async () => {
    const h = harness();
    expect((await h.complete()).status).toBe(200);
    const state = h.auth.state();
    expect(state.status).toBe("connected");
    expect(state.models).toEqual([{ id: "unit-model", label: "Available model" }]);
    expect(h.auth.provider()?.supportsVision).toBe(true);
    const exchange = h.requests.find((r) => r.url.endsWith("/oauth/token"))!.body!;
    expect(exchange.get("client_id")).toBe("unit-issued-client");
    expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
    expect(exchange.has("client_secret")).toBe(false);
    expect(exchange.get("code_verifier")!.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toHaveLength(43);
    expect(JSON.stringify(state)).not.toContain(await h.auth.accessToken());
  });

  for (const claims of [{ nonce: "wrong" }, { aud: "wrong" }, { iss: "https://attacker.test" }, { exp: 1 }]) {
    test(`rejects invalid identity claims: ${Object.keys(claims)[0]}`, async () => {
      const h = harness({ claims });
      expect((await h.complete()).status).toBe(400);
      expect(h.auth.state().status).toBe("error");
      expect(h.auth.provider()).toBeUndefined();
    });
  }

  test("declined permission and missing plan scope never enable inference", async () => {
    const denied = harness();
    expect((await denied.complete(undefined, { error: "access_denied" })).status).toBe(400);
    expect(denied.requests).toHaveLength(0);
    const missing = harness({ scope: "openid profile email" });
    expect((await missing.complete()).status).toBe(400);
    expect(missing.auth.state().message).toContain("Allow Agni");
    const saved = missing.auth.state().accounts[0]!;
    expect(saved.connected).toBe(false);
    const { url } = await missing.begin(saved.id);
    expect(url.searchParams.get("client_id")).toBe("unit-issued-client");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("a model-catalog outage keeps the validated registration for retry", async () => {
    const h = harness(); h.failModels();
    expect((await h.complete()).status).toBe(400);
    expect(h.auth.state().accounts).toHaveLength(1);
    expect(h.auth.state().accounts[0]?.connected).toBe(true);
    expect(h.auth.provider()).toBeUndefined();
  });

  test("rejects a forged signature even when identity claims look valid", async () => {
    const h = harness({ badSignature: true });
    expect((await h.complete()).status).toBe(400);
    expect(h.auth.provider()).toBeUndefined();
  });

  test("a failed reauthorization does not replace the active account", async () => {
    const h = harness(); await h.complete();
    const id = h.auth.state().activeAccountID!;
    const credential = await h.auth.accessToken();
    expect((await h.complete(id, { client_id: "different-client" })).status).toBe(400);
    expect(h.auth.state().status).toBe("connected");
    expect(h.auth.state().activeAccountID).toBe(id);
    expect(await h.auth.accessToken()).toBe(credential);
  });

  test("saved accounts survive restart, reuse registration, and rotate refresh tokens once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agni-chatgpt-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "private", "accounts.json");
    const h = harness({ path });
    await h.complete();
    const id = h.auth.state().activeAccountID!;
    expect(h.auth.state().showWelcome).toBe(true);
    await h.auth.acknowledge(id);
    expect(h.auth.state().showWelcome).toBe(false);
    const before = JSON.parse(readFileSync(path, "utf8"));
    const reopened = new ChatGPTAuth({ filePath: path, fetchFn: h.fetchFn });
    cleanups.push(() => reopened.stop());
    expect(reopened.state().activeAccountID).toBe(id);
    expect(reopened.state().showWelcome).toBe(false);
    h.advance();
    const tokens = await Promise.all([h.auth.accessToken(), h.auth.accessToken()]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(h.refreshCount()).toBe(1);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.accounts[0].tokens.refreshToken).not.toBe(before.accounts[0].tokens.refreshToken);
    expect(h.requests.find((r) => r.body?.get("grant_type") === "refresh_token")?.body?.has("scope")).toBe(false);
    const { url } = await h.begin(id);
    expect(url.searchParams.get("client_id")).toBe("unit-issued-client");
    expect(url.searchParams.has("agent_name_hint")).toBe(false);
  });

  test("temporary refresh errors retain credentials; terminal errors require sign-in", async () => {
    const h = harness(); await h.complete(); h.advance(); h.failRefresh("server_error");
    await expect(h.auth.accessToken()).rejects.toThrow("temporarily unavailable");
    expect(h.auth.state().accounts[0]?.connected).toBe(true);
    h.failRefresh("invalid_grant");
    await expect(h.auth.accessToken()).rejects.toThrow("Sign in again");
    expect(h.auth.state().status).toBe("reauth_required");
  });

  test("sign-out revokes, aborts active requests, and keeps the account registration", async () => {
    const h = harness(); await h.complete();
    const request = h.auth.requestSignal();
    const id = h.auth.state().activeAccountID!;
    await h.auth.disconnect(id);
    expect(request.signal.aborted).toBe(true);
    expect(h.auth.state().status).toBe("disconnected");
    expect(h.auth.state().accounts[0]).toMatchObject({ id, connected: false });
    expect(h.requests.some((r) => r.url.endsWith("/oauth/revoke"))).toBe(true);
    expect(h.auth.provider()).toBeUndefined();
  });

  test("sign-out reports when remote revocation could not be confirmed", async () => {
    const h = harness({ revokeFails: true }); await h.complete();
    await h.auth.disconnect(h.auth.state().activeAccountID!);
    expect(h.auth.state().message).toContain("Remote sign-out could not be confirmed");
    expect(h.auth.state().accounts[0]?.connected).toBe(false);
  });

  test("a refresh finishing after sign-out cannot restore credentials", async () => {
    const h = harness(); await h.complete(); h.advance();
    const release = h.blockRefresh();
    const token = h.auth.accessToken();
    await h.auth.disconnect(h.auth.state().activeAccountID!);
    release();
    await expect(token).rejects.toThrow("connection changed");
    expect(h.auth.state().accounts[0]?.connected).toBe(false);
    expect(h.auth.provider()).toBeUndefined();
  });

  test("the router uses ChatGPT and never falls back to API-key billing", async () => {
    const h = harness(); await h.complete();
    let apiCalls = 0;
    const fetchFn = (async (url: string | URL | Request) => {
      if (String(url).includes("api-key.test")) apiCalls++;
      return Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, { status: 429 });
    }) as typeof fetch;
    const router = new Router([{ id: "paid", label: "Paid", apiKey: "unit", baseUrl: "https://api-key.test", model: "unit" }], new HealthTracker(), fetchFn);
    router.setChatGPT(h.auth);
    await expect(router.route({ messages: [{ role: "user", content: "hello" }], firstTokenTimeoutMs: 1000, onDelta() {} })).rejects.toThrow("usage limit reached");
    expect(apiCalls).toBe(0);
    expect(router.load().active).toBe(0);
  });
});

describe("ChatGPT Responses transport", () => {
  const base: ChatRequest = { apiKey: "unit-credential", baseUrl: "https://api.openai.com/v1", model: "unit-model", messages: [{ role: "user", content: "hello" }], firstTokenTimeoutMs: 1000, onDelta() {} };

  test("translates context, namespaced tools, and tool results without unsupported fields", () => {
    const body = responsesBody({ ...base, maxTokens: 500, temperature: 0.5, messages: [
      { role: "system", content: "Agni instructions" },
      { role: "user", content: "look", images: ["data:image/png;base64,unit"] },
      { role: "assistant", content: "", toolCalls: [{ id: "call-one", type: "function", function: { name: "memory_search", arguments: "{}" } }] },
      { role: "tool", content: "saved fact", toolCallID: "call-one" },
    ], tools: [{ type: "function", function: { name: "memory_search", description: "Find facts", parameters: { type: "object" } } }] });
    expect(body).toMatchObject({ store: false, stream: true, tools: [{ type: "namespace", name: "agni" }] });
    expect(body.input).toMatchObject([{ role: "developer" }, { role: "user" }, { type: "function_call", namespace: "agni", call_id: "call-one" }, { type: "function_call_output", call_id: "call-one" }]);
    for (const unsupported of ["temperature", "max_output_tokens", "max_tokens", "previous_response_id", "conversation"]) expect(body).not.toHaveProperty(unsupported);
  });

  test("streams text and returns only after response.completed", async () => {
    const deltas: string[] = [];
    const result = await streamChatGPT({ ...base, onDelta: (d) => deltas.push(d), fetchFn: (async () => stream({ type: "response.output_text.delta", delta: "Hello" }, done)) as unknown as typeof fetch });
    expect(result.text).toBe("Hello"); expect(deltas).toEqual(["Hello"]);
    expect(result.inputTokens).toBe(12);
  });

  test("preserves reasoning and complete tool calls for the next step", async () => {
    const reason = { type: "reasoning" as const, id: "reason-one", encrypted_content: "unit-opaque-context", summary: [] };
    const call = { type: "function_call", namespace: "agni", call_id: "call-one", name: "tasks_list", arguments: "{}" };
    const result = await streamChatGPT({ ...base, fetchFn: (async () => stream({ type: "response.output_item.done", item: reason }, { type: "response.output_item.done", item: call }, { ...done, response: { ...done.response, output: [reason, call] } })) as unknown as typeof fetch });
    expect(result.toolCalls).toHaveLength(1); expect(result.responseItems).toEqual([reason]);
    const next = responsesBody({ ...base, messages: [{ role: "assistant", content: "", responseItems: result.responseItems, toolCalls: result.toolCalls }] });
    expect((next.input as unknown[])[0]).toEqual(reason);
  });

  test("never treats a truncated or failed stream as success", async () => {
    const partial = { type: "response.output_text.delta", delta: "Partial" };
    await expect(streamChatGPT({ ...base, fetchFn: (async () => stream(partial)) as unknown as typeof fetch })).rejects.toThrow("before completion");
    await expect(streamChatGPT({ ...base, fetchFn: (async () => stream(partial, { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } })) as unknown as typeof fetch })).rejects.toThrow("usage limit reached");
  });

  test("does not echo untrusted endpoint bodies into errors", async () => {
    const marker = randomBytes(16).toString("hex");
    try { await streamChatGPT({ ...base, fetchFn: (async () => Response.json({ detail: marker }, { status: 403 })) as unknown as typeof fetch }); }
    catch (error) { expect(String(error)).not.toContain(marker); expect(String(error)).toContain("restricted"); }
  });
});
