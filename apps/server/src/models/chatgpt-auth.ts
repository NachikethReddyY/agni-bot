/** Official Sign in with ChatGPT for a locally hosted, open-source Agni. */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ChatGPTConnection } from "@agni/protocol";
import { ProviderError } from "./client";
import type { ProviderConfig } from "./providers";

const AUTH = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const LOGIN_MS = 5 * 60_000;
const runFile = promisify(execFile);
const modelSchema = z.object({ id: z.string(), label: z.string(), vision: z.boolean().default(false) });
const tokensSchema = z.object({
  accessToken: z.string(), refreshToken: z.string(), idToken: z.string(),
  expiresAt: z.number(), earliestRefreshAt: z.number().default(0), scopes: z.array(z.string()),
});
const accountSchema = z.object({
  id: z.string(), clientID: z.string(), subject: z.string(), email: z.string(),
  model: z.string(), models: z.array(modelSchema), tokens: tokensSchema.optional(),
  needsLogin: z.boolean().default(false),
  permissionDisabled: z.boolean().default(false),
  welcomed: z.boolean().default(false),
});
const storeSchema = z.object({ version: z.literal(1), hostID: z.string(), activeID: z.string().nullable(), accounts: z.array(accountSchema) });
type Account = z.infer<typeof accountSchema>;
type Store = z.infer<typeof storeSchema>;
type Tokens = z.infer<typeof tokensSchema>;
interface SigningKey { kid: string; kty: "RSA"; n: string; e: string; alg?: string; use?: string }
interface Attempt {
  id: string; owner: string; state: string; nonce: string; verifier: string;
  account?: Account; redirectURI: string; timer: ReturnType<typeof setTimeout>;
  server: ReturnType<typeof Bun.serve>; finishing: boolean;
}
interface TokenResponse {
  access_token?: unknown; refresh_token?: unknown; id_token?: unknown;
  token_type?: unknown; expires_in?: unknown; earliest_refresh_at?: unknown; scope?: unknown;
}

export class ChatGPTAuthError extends Error {
  constructor(message: string) { super(message); this.name = "ChatGPTAuthError"; }
}

export class ChatGPTAuth {
  private store: Store;
  private pending?: Attempt;
  private message?: string;
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly requests = new Set<AbortController>();
  private writes: Promise<void> = Promise.resolve();
  private keys?: { expires: number; keys: SigningKey[] };
  private stopped = false;

  constructor(private readonly options: {
    filePath: string | null;
    fetchFn?: typeof fetch;
    onChange?: () => void;
    now?: () => number;
  }) {
    let store: Store | undefined;
    if (options.filePath) {
      try { store = storeSchema.parse(JSON.parse(readFileSync(options.filePath, "utf8"))); }
      catch (error) {
        // A corrupt store must not be overwritten, losing account registrations.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ChatGPTAuthError("Could not read the protected ChatGPT account file.");
      }
    }
    this.store = store ?? { version: 1, hostID: `urn:uuid:${randomUUID()}`, activeID: null, accounts: [] };
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
  private get fetchFn(): typeof fetch { return this.options.fetchFn ?? fetch; }
  private active(): Account | undefined { return this.store.accounts.find((a) => a.id === this.store.activeID); }

  state(): ChatGPTConnection {
    const account = this.active();
    return {
      status: this.pending ? "pending" : account?.needsLogin ? "reauth_required" : account?.tokens && account.model ? "connected" : this.message ? "error" : "disconnected",
      accounts: this.store.accounts.map((a) => ({ id: a.id, label: `${a.email || "ChatGPT account"} · ${a.id.slice(0, 6)}`, connected: !!a.tokens && !a.needsLogin })),
      activeAccountID: this.store.activeID, model: account?.model ?? "",
      models: (account?.models ?? []).map(({ id, label }) => ({ id, label })),
      showWelcome: !this.pending && !!account?.tokens && !!account.model && !account.needsLogin && !account.welcomed,
      ...(this.message ? { message: this.message } : {}),
    };
  }

  provider(): ProviderConfig | undefined {
    const account = this.active();
    if (!account) return undefined;
    return { id: "chatgpt", label: "ChatGPT", baseUrl: RESOURCE, apiKey: "", model: account.model,
      supportsVision: account.models.find((m) => m.id === account.model)?.vision ?? false };
  }

  async start(owner: string, accountID?: string): Promise<{ loginID: string; authorizeURL: string; expiresAt: string }> {
    if (this.stopped) throw new ChatGPTAuthError("The server is shutting down.");
    if (this.pending) throw new ChatGPTAuthError("A ChatGPT sign-in is already open. Finish or cancel it first.");
    const account = accountID ? this.store.accounts.find((a) => a.id === accountID) : undefined;
    if (accountID && !account) throw new ChatGPTAuthError("Choose a saved ChatGPT account.");
    await this.save(); // Persist this host's identity before any authorization.
    if (this.pending || this.stopped) throw new ChatGPTAuthError("A ChatGPT sign-in is already open or the server is stopping.");
    const id = randomUUID();
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.callback(request, id) });
    const redirectURI = `http://127.0.0.1:${server.port}/auth/callback`;
    const timer = setTimeout(() => {
      if (this.pending?.id === id) { this.closeAttempt(); this.message = "Sign-in expired. Continue with ChatGPT to try again."; this.changed(); }
    }, LOGIN_MS);
    timer.unref?.();
    this.pending = { id, owner, state, nonce, verifier, account, redirectURI, server, timer, finishing: false };
    this.message = undefined;
    const url = new URL(`${AUTH}/api/accounts/authorize`);
    const parameters: Record<string, string> = {
      client_id: account?.clientID ?? "dynamic_agent_client", ext_agent_host_id: this.store.hostID,
      response_type: "code", redirect_uri: redirectURI, scope: SCOPE, resource: RESOURCE,
      state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    };
    if (!account) parameters.agent_name_hint = "Agni";
    // No id_token_hint: the browser UI must never receive retained tokens.
    if (account?.email) parameters.login_hint = account.email;
    if (account?.permissionDisabled) parameters.prompt = "consent";
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    this.changed();
    return { loginID: id, authorizeURL: url.href, expiresAt: new Date(this.now() + LOGIN_MS).toISOString() };
  }

  cancel(owner: string, loginID: string): void {
    if (!this.pending || this.pending.id !== loginID || this.pending.owner !== owner) return;
    this.closeAttempt(); this.message = undefined; this.changed();
  }

  private async callback(request: Request, loginID: string): Promise<Response> {
    const attempt = this.pending;
    const url = new URL(request.url);
    if (request.method !== "GET" || !attempt || attempt.id !== loginID || url.origin + url.pathname !== attempt.redirectURI) return this.page("This sign-in is no longer available.", 400);
    if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== attempt.state || attempt.finishing) return this.page("This sign-in could not be verified. Return to Agni and try again.", 400);
    attempt.finishing = true;
    try {
      if (url.searchParams.has("error")) throw new ChatGPTAuthError("ChatGPT sign-in was cancelled or permission was declined. Try again and allow ChatGPT plan usage.");
      const clientID = url.searchParams.get("client_id") ?? attempt.account?.clientID;
      const code = url.searchParams.get("code");
      if (!clientID || clientID === "dynamic_agent_client" || clientID.length > 512 || !code || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("client_id").length > 1) throw new ChatGPTAuthError("ChatGPT registration was incomplete. Please sign in again.");
      if (attempt.account && clientID !== attempt.account.clientID) throw new ChatGPTAuthError("ChatGPT returned a different account registration. Please try again.");
      const response = await this.tokenRequest(new URLSearchParams({ grant_type: "authorization_code", client_id: clientID, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectURI, resource: RESOURCE }));
      const identity = await this.validateIDToken(response.id_token, clientID, attempt.nonce);
      if (attempt.account && identity.sub !== attempt.account.subject) throw new ChatGPTAuthError("A different ChatGPT account was used. Choose Add another account instead.");
      const id = createHash("sha256").update(`${clientID}\0${identity.sub}`).digest("hex").slice(0, 32);
      const previous = this.store.accounts.find((a) => a.id === id);
      const granted = typeof response.scope === "string" ? response.scope.split(/\s+/) : [];
      if (this.pending !== attempt || this.stopped) return this.page("Sign-in was cancelled. Return to Agni.", 400);
      if (!granted.includes("chatgpt.tokens.use.direct") || !granted.includes("resource.invoke")) {
        // Keep the verified registration so an explicit retry can request
        // consent on the same client, rather than create duplicate clients.
        await this.rememberRegistration({ id, clientID, subject: identity.sub, email: identity.email,
          model: previous?.model ?? "", models: previous?.models ?? [], needsLogin: true, permissionDisabled: true, welcomed: previous?.welcomed ?? false });
        throw new ChatGPTAuthError("Allow Agni to use your ChatGPT plan. Select the saved account and continue to enable access.");
      }
      const tokens = this.readTokens(response);
      let models: Array<{ id: string; label: string; vision: boolean }>;
      try { models = await this.fetchModels(tokens.accessToken); }
      catch (error) {
        if (this.pending === attempt && !this.stopped) await this.rememberRegistration({ id, clientID, subject: identity.sub, email: identity.email,
          model: previous?.model ?? "", models: previous?.models ?? [], tokens, needsLogin: false, permissionDisabled: false, welcomed: previous?.welcomed ?? false });
        throw error;
      }
      if (this.pending !== attempt || this.stopped) return this.page("Sign-in was cancelled. Return to Agni.", 400);
      const account: Account = { id, clientID, subject: identity.sub, email: identity.email,
        model: models.some((m) => m.id === previous?.model) ? previous!.model : models[0]!.id,
        models, tokens, needsLogin: false, permissionDisabled: false, welcomed: previous?.welcomed ?? false };
      const before = this.store;
      this.abortRequests();
      this.store = { ...before, activeID: id, accounts: [...before.accounts.filter((a) => a.id !== id), account] };
      try { await this.save(); } catch { this.store = before; throw new ChatGPTAuthError("Could not save the ChatGPT connection securely. Please try again."); }
      this.message = undefined;
      this.closeAttempt(); this.changed();
      return this.page("ChatGPT is connected. You can close this tab and return to Agni.");
    } catch (error) {
      if (this.pending === attempt) {
        this.message = error instanceof ChatGPTAuthError ? error.message : "Could not connect ChatGPT. Please try again.";
        this.closeAttempt(); this.changed();
      }
      return this.page(this.message ?? "Sign-in was cancelled. Return to Agni.", 400);
    }
  }

  async select(accountID: string): Promise<void> {
    if (this.pending) throw new ChatGPTAuthError("Finish or cancel the current sign-in first.");
    const account = this.store.accounts.find((a) => a.id === accountID);
    if (!account?.tokens || account.needsLogin) throw new ChatGPTAuthError("Sign in to that ChatGPT account again.");
    const models = await this.fetchModels(await this.accessToken(accountID));
    if (!account.tokens || account.needsLogin || !this.store.accounts.includes(account)) throw new ChatGPTAuthError("Sign in to that ChatGPT account again.");
    this.abortRequests(); account.models = models;
    if (!models.some((m) => m.id === account.model)) account.model = models[0]!.id;
    this.store.activeID = accountID; this.message = undefined;
    await this.save(); this.changed();
  }

  async disconnect(accountID: string): Promise<void> {
    const account = this.store.accounts.find((a) => a.id === accountID);
    if (!account) throw new ChatGPTAuthError("Unknown ChatGPT account.");
    if (this.pending) this.closeAttempt();
    this.abortRequests();
    const tokens = account.tokens;
    // Remove credentials before awaiting the network, so in-flight refreshes cannot resurrect them.
    account.tokens = undefined; account.needsLogin = false;
    if (this.store.activeID === accountID) this.store.activeID = null;
    await this.save();
    this.message = undefined;
    if (tokens) {
      let revoked = false;
      for (let retry = 0; retry < 2 && !revoked; retry++) {
        try {
          const response = await this.fetchFn(`${AUTH}/api/accounts/oauth/revoke`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: "refresh_token", client_id: account.clientID }),
            signal: AbortSignal.timeout(5_000), redirect: "error",
          });
          revoked = response.status === 200;
          if (!revoked && response.status < 500) break;
        } catch { /* Retry once; never expose endpoint bodies or credentials. */ }
        if (!revoked && retry === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!revoked) this.message = "Signed out locally. Remote sign-out could not be confirmed; disconnect Agni in ChatGPT Settings → Apps.";
    }
    this.changed();
  }

  async models(): Promise<Array<{ id: string; label: string; vision: boolean }>> {
    const account = this.active();
    if (!account) throw new ChatGPTAuthError("Connect ChatGPT first.");
    const models = await this.fetchModels(await this.accessToken(account.id));
    if (this.active() !== account) throw new ChatGPTAuthError("The ChatGPT account changed. Please retry.");
    account.models = models;
    await this.save(); this.changed();
    return models;
  }

  async setModel(model: string): Promise<void> {
    const account = this.active();
    if (!account) throw new ChatGPTAuthError("Connect ChatGPT first.");
    const choices = await this.models();
    if (!choices.some((m) => m.id === model)) throw new ChatGPTAuthError("Choose a model available to this ChatGPT account.");
    if (this.active() !== account) throw new ChatGPTAuthError("The ChatGPT account changed. Please retry.");
    account.model = model; await this.save(); this.changed();
  }

  async acknowledge(accountID: string): Promise<void> {
    const account = this.active();
    if (!account || account.id !== accountID) throw new ChatGPTAuthError("Choose the connected ChatGPT account first.");
    account.welcomed = true;
    try { await this.save(); } catch { account.welcomed = false; throw new ChatGPTAuthError("Could not save your preference. Please try again."); }
    this.changed();
  }

  async accessToken(accountID = this.store.activeID): Promise<string> {
    const account = this.store.accounts.find((a) => a.id === accountID);
    if (!account?.tokens || account.needsLogin) throw new ProviderError("Sign in to ChatGPT again in Models & providers.", { kind: "http", status: 401 });
    if (account.tokens.expiresAt > this.now() + 60_000) return account.tokens.accessToken;
    if (account.tokens.earliestRefreshAt > this.now()) {
      if (account.tokens.expiresAt > this.now()) return account.tokens.accessToken;
      throw new ProviderError("ChatGPT session renewal is not available yet. Try again shortly.", { kind: "http", status: 503 });
    }
    const pending = this.refreshes.get(account.id);
    if (pending) return pending;
    const refresh = this.refresh(account).finally(() => this.refreshes.delete(account.id));
    this.refreshes.set(account.id, refresh);
    return refresh;
  }

  private async refresh(account: Account): Promise<string> {
    const previous = account.tokens!;
    try {
      const response = await this.tokenRequest(new URLSearchParams({ grant_type: "refresh_token", client_id: account.clientID, refresh_token: previous.refreshToken, resource: RESOURCE }));
      const tokens = this.readTokens(response, previous);
      if (response.id_token) {
        const identity = await this.validateIDToken(response.id_token, account.clientID);
        if (identity.sub !== account.subject) throw new ChatGPTAuthError("ChatGPT account identity changed. Sign in again.");
      }
      if (this.stopped || account.tokens !== previous) throw new ChatGPTAuthError("The ChatGPT connection changed.");
      account.tokens = tokens; account.needsLogin = false;
      try { await this.save(); } catch { account.needsLogin = true; throw new ChatGPTAuthError("Could not save the renewed ChatGPT session. Sign in again."); }
      this.message = undefined; this.changed();
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof TerminalRefreshError && account.tokens === previous) {
        account.tokens = undefined; account.needsLogin = true; await this.save(); this.changed();
      }
      throw new ProviderError(error instanceof ChatGPTAuthError ? error.message : "Could not renew ChatGPT access. Try again shortly.", { kind: "http", status: account.needsLogin ? 401 : 503 });
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    const response = await this.fetchFn(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000), redirect: "error" });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const code = typeof payload.error === "string" ? payload.error : (payload.error as { code?: string } | null)?.code;
      if (["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"].includes(code ?? "")) throw new TerminalRefreshError("Your ChatGPT session expired. Sign in again.");
      throw new ChatGPTAuthError(response.status >= 500 ? "ChatGPT sign-in is temporarily unavailable. Try again shortly." : "ChatGPT could not authorize this connection. Please sign in again.");
    }
    return payload;
  }

  private readTokens(response: TokenResponse, previous?: Tokens): Tokens {
    if (typeof response.access_token !== "string" || !response.access_token || typeof response.refresh_token !== "string" || !response.refresh_token || typeof response.expires_in !== "number" || response.expires_in <= 0 || !Number.isFinite(response.expires_in) || String(response.token_type).toLowerCase() !== "bearer") throw new ChatGPTAuthError("ChatGPT returned an incomplete session. Please sign in again.");
    const scopes = typeof response.scope === "string" ? response.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    if (!scopes.includes("chatgpt.tokens.use.direct") || !scopes.includes("resource.invoke")) throw new ChatGPTAuthError("Allow Agni to use your ChatGPT plan when signing in.");
    return { accessToken: response.access_token, refreshToken: response.refresh_token, idToken: typeof response.id_token === "string" ? response.id_token : previous?.idToken ?? "",
      scopes, expiresAt: this.now() + response.expires_in * 1000, earliestRefreshAt: typeof response.earliest_refresh_at === "number" ? response.earliest_refresh_at * 1000 : 0 };
  }

  private async validateIDToken(raw: unknown, clientID: string, nonce?: string): Promise<{ sub: string; email: string }> {
    const invalid = (): never => { throw new ChatGPTAuthError("ChatGPT identity verification failed. Please sign in again."); };
    if (typeof raw !== "string" || raw.length > 32_768) return invalid();
    const parts = raw.split(".");
    if (parts.length !== 3) return invalid();
    try {
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString()) as { alg?: string; kid?: string; crit?: unknown };
      if (header.alg !== "RS256" || !header.kid || header.crit !== undefined) return invalid();
      if (!this.keys || this.keys.expires <= this.now() || !this.keys.keys.some((k) => k.kid === header.kid)) {
        const response = await this.fetchFn(`${AUTH}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (!response.ok) throw new ChatGPTAuthError("ChatGPT identity verification is temporarily unavailable.");
        const payload = await response.json() as { keys: SigningKey[] };
        if (!Array.isArray(payload.keys)) return invalid();
        this.keys = { keys: payload.keys, expires: this.now() + 60 * 60_000 };
      }
      const key = this.keys.keys.find((k) => k.kid === header.kid && k.kty === "RSA" && (!k.use || k.use === "sig") && (!k.alg || k.alg === "RS256"));
      if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2]!, "base64url"))) return invalid();
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as Record<string, unknown>;
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (claims.iss !== AUTH || !Array.isArray(audiences) || !audiences.includes(clientID) || (audiences.length > 1 && claims.azp !== clientID) || (claims.azp !== undefined && claims.azp !== clientID) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= this.now() || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf * 1000 > this.now() + 30_000)) || !claims.sub || typeof claims.sub !== "string" || (nonce !== undefined && claims.nonce !== nonce)) return invalid();
      return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
    } catch (error) { if (error instanceof ChatGPTAuthError) throw error; return invalid(); }
  }

  private async fetchModels(token: string): Promise<Array<{ id: string; label: string; vision: boolean }>> {
    const response = await this.fetchFn(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new ChatGPTAuthError(response.status === 403 ? "ChatGPT plan access is unavailable for this account or workspace." : "Could not load your ChatGPT models. Please try again.");
    const payload = await response.json() as { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown; input_modalities?: unknown }> };
    const models = (payload.models ?? []).filter((m) => m.visibility === "list" && typeof m.slug === "string" && m.slug.length > 0).map((m) => ({
      id: m.slug as string, label: typeof m.display_name === "string" ? m.display_name : m.slug as string,
      vision: Array.isArray(m.input_modalities) && m.input_modalities.includes("image"),
    }));
    if (!models.length) throw new ChatGPTAuthError("No eligible models are available to this ChatGPT account.");
    return models;
  }

  private async rememberRegistration(account: Account): Promise<void> {
    const before = this.store;
    this.store = { ...before, accounts: [...before.accounts.filter((a) => a.id !== account.id), account] };
    try { await this.save(); } catch { this.store = before; throw new ChatGPTAuthError("Could not save the ChatGPT registration securely."); }
  }

  /** Cancels requests on sign-out/account changes, including during a stream. */
  requestSignal(parent?: AbortSignal): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController(); this.requests.add(controller);
    return { signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal, release: () => this.requests.delete(controller) };
  }
  private abortRequests(): void { for (const c of this.requests) c.abort(); this.requests.clear(); }
  stop(): void { this.stopped = true; this.closeAttempt(); this.abortRequests(); }
  private closeAttempt(): void { if (this.pending) { clearTimeout(this.pending.timer); this.pending.server.stop(); this.pending = undefined; } }
  private changed(): void { this.options.onChange?.(); }
  private page(message: string, status = 200): Response {
    const text = message.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agni · ChatGPT</title></head><body><h1>Agni</h1><p>${text}</p></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" } });
  }
  private save(): Promise<void> {
    if (!this.options.filePath) return Promise.resolve();
    const path = this.options.filePath;
    const contents = JSON.stringify(this.store);
    const write = this.writes.catch(() => {}).then(async () => {
      const directory = dirname(path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      if (process.platform === "win32") {
        const { stdout } = await runFile("whoami", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
        const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
        if (!sid) throw new ChatGPTAuthError("Could not secure the ChatGPT credential directory.");
        await runFile("icacls", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`], { windowsHide: true });
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, contents, { mode: 0o600, flag: "wx" }); await chmod(temporary, 0o600); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
    });
    this.writes = write;
    return write;
  }
}

class TerminalRefreshError extends ChatGPTAuthError {}
