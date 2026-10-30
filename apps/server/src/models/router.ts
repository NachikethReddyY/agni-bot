/**
 * Model router — free-first, failover on 429/timeout, with per-provider
 * retries so a single transient hiccup doesn't kill a turn. Honest about the
 * one case it cannot fix: a stream that already emitted tokens cannot be
 * retried on another provider (that would duplicate text into the thread).
 */
import { ProviderError, streamChat, type ChatMessage, type ChatResult, type ToolSpec } from "./client";
import type { ProviderConfig } from "./providers";
import type { HealthTracker } from "./health";
import { log } from "../log";
import type { ChatGPTAuth } from "./chatgpt-auth";
import { streamChatGPT } from "./chatgpt-responses";

export class RouterError extends Error {
  readonly code: "no_provider" | "provider_failed";

  constructor(code: "no_provider" | "provider_failed", message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}

/** Raised when this process is already using its configured model capacity. */
export class RouterBusyError extends Error {
  constructor(readonly capacity: number) {
    super(`server is at model capacity (${capacity} concurrent turns); retry shortly`);
    this.name = "RouterBusyError";
  }
}

/** A provider failed after tokens were already emitted to the client. */
export class MidStreamError extends Error {
  readonly provider: string;

  constructor(provider: string, cause: ProviderError) {
    super(`${provider} failed mid-stream: ${cause.message}`);
    this.name = "MidStreamError";
    this.provider = provider;
  }
}

/**
 * How many times to try a single provider on a fast, retryable failure
 * (network, 408, 429, 5xx). A timeout gets one attempt: retrying a stalled
 * provider would eat the turn budget before the next provider is tried.
 */
const PROVIDER_RETRIES = 3;
/** Base backoff between retries of the same provider (ms). */
const RETRY_BACKOFF_MS = 2_000;

export interface RouteOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
  firstTokenTimeoutMs: number;
  onDelta: (delta: string) => void;
  /** Tool schemas injected into the request (task lane only). */
  tools?: ToolSpec[];
  /** Force the model to pick a tool, or forbid tool use entirely. */
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
  /** Bound each model response in the task lane. */
  maxTokens?: number;
}

export interface RouteResult {
  provider: string;
  model: string;
  text: string;
  firstTokenMs: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts: number;
  /** Structured tool calls the model emitted (task lane). */
  toolCalls?: import("./client").ToolCall[];
  /** The model's own reasoning, when the provider streams it. */
  reasoning?: string;
  responseItems?: import("./client").ResponseContextItem[];
}

export interface ProviderStatus {
  id: string;
  label: string;
  model: string;
  available: boolean;
  cooldownRemainingMs: number;
  lastError?: string;
  lastSuccessAt?: number;
}

export class Router {
  private activeRoutes = 0;
  private chatgpt?: ChatGPTAuth;

  setChatGPT(connection: ChatGPTAuth): void { this.chatgpt = connection; }
  connectionReady(providerID: string): void { this.health.markSuccess(providerID); }

  constructor(
    private providers: ProviderConfig[],
    private readonly health: HealthTracker,
    private readonly fetchFn: typeof fetch = fetch,
    readonly maxConcurrentRoutes = 4,
  ) {}

  /** Current in-flight model streams and the process-wide configured cap. */
  load(): { active: number; capacity: number } {
    return { active: this.activeRoutes, capacity: this.maxConcurrentRoutes };
  }

  /** Apply an authenticated provider configuration change without a restart. */
  replaceProviders(providers: ProviderConfig[]): void {
    this.providers = providers;
  }

  async listModels(providerID: string): Promise<string[]> {
    if (providerID === "chatgpt" && this.chatgpt) return (await this.chatgpt.models()).map((model) => model.id);
    const provider = this.providers.find((candidate) => candidate.id === providerID);
    if (!provider) throw new Error("Provider is not configured on the daemon.");
    const response = await this.fetchFn(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Provider model list returned HTTP ${response.status}.`);
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    const models = (payload.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
    if (models.length === 0) throw new Error("The provider did not return any selectable models.");
    return models.sort((a, b) => a.localeCompare(b));
  }

  /** Configured providers, healthiest first, cooling ones last. */
  candidates(): ProviderConfig[] {
    // Choosing ChatGPT is an explicit billing choice. Never silently fall back
    // to API-key billing when its grant, usage allowance, or connection fails.
    const chatgpt = this.chatgpt?.provider();
    if (chatgpt) return [chatgpt];
    const healthy = this.providers.filter((provider) => this.health.isAvailable(provider.id));
    const cooling = this.providers.filter((provider) => !this.health.isAvailable(provider.id));
    // Cooling providers stay in the list as a last resort — a spent cooldown
    // beats a hard failure when nothing else is configured.
    return [...healthy, ...cooling];
  }

  supportsVision(): boolean {
    return this.candidates().some((provider) => provider.supportsVision === true);
  }

  async route(options: RouteOptions): Promise<RouteResult> {
    if (this.activeRoutes >= this.maxConcurrentRoutes) throw new RouterBusyError(this.maxConcurrentRoutes);
    this.activeRoutes += 1;
    try {
      return await this.routeWithSlot(options);
    } finally {
      this.activeRoutes -= 1;
    }
  }

  private async routeWithSlot(options: RouteOptions): Promise<RouteResult> {
    const needsVision = options.messages.some((message) => message.images?.length);
    const capable = this.candidates().filter((provider) => !needsVision || provider.supportsVision === true);
    // Cooling providers are a last resort only when nothing healthy is left.
    const healthy = capable.filter((provider) => this.health.isAvailable(provider.id));
    const candidates = healthy.length > 0 ? healthy : capable;
    if (needsVision && candidates.length === 0) {
      throw new RouterError("no_provider", "No vision model configured. Set AGNI_VISION_MODELS to a configured model ID that supports images.");
    }
    if (candidates.length === 0) {
      throw new RouterError(
        "no_provider",
        "no model providers configured — add one in Settings → Models & providers, or set GROQ_API_KEY, CEREBRAS_API_KEY, or NVIDIA_API_KEY in .env",
      );
    }

    const errors: string[] = [];
    let attempts = 0;
    for (const provider of candidates) {
      let lastError: ProviderError | null = null;
      for (let retry = 0; retry < PROVIDER_RETRIES; retry++) {
        attempts += 1;
        const beganAt = Date.now();
        let emitted = false;
        try {
          const connection = provider.id === "chatgpt" ? this.chatgpt : undefined;
          const lease = connection?.requestSignal(options.signal);
          let result: ChatResult;
          try {
            result = await (connection ? streamChatGPT : streamChat)({
              baseUrl: provider.baseUrl,
              apiKey: connection ? await connection.accessToken() : provider.apiKey,
              model: provider.model,
              messages: options.messages,
              signal: lease?.signal ?? options.signal,
              firstTokenTimeoutMs: options.firstTokenTimeoutMs,
              fetchFn: this.fetchFn,
              tools: options.tools,
              toolChoice: options.toolChoice,
              maxTokens: options.maxTokens,
              onDelta: (delta) => {
                emitted = true;
                options.onDelta(delta);
              },
            });
          } finally { lease?.release(); }
          this.health.markSuccess(provider.id);
          return {
            provider: provider.id,
            model: provider.model,
            text: result.text,
            firstTokenMs: result.firstTokenMs,
            latencyMs: Date.now() - beganAt,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            attempts,
            ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
            ...(result.reasoning ? { reasoning: result.reasoning } : {}),
            ...(result.responseItems ? { responseItems: result.responseItems } : {}),
          };
        } catch (error) {
          const providerError =
            error instanceof ProviderError ? error : new ProviderError(String(error), { kind: "network" });
          if (providerError.kind === "aborted" || options.signal?.aborted) throw providerError;
          if (emitted) throw new MidStreamError(provider.id, providerError);
          if (provider.id === "chatgpt") {
            this.health.markFailure(provider.id, this.cooldownFor(providerError), providerError.message);
            throw new RouterError("provider_failed", providerError.message);
          }
          lastError = providerError;
          errors.push(`${provider.id}#${retry + 1}: ${providerError.message}`);
          // A bad request (oversized prompt, unknown model) says nothing about the provider's health.
          if (!isRequestError(providerError)) {
            this.health.markFailure(provider.id, this.cooldownFor(providerError), providerError.message);
          }
          if (!isRetryable(providerError) || retry === PROVIDER_RETRIES - 1) {
            log.info(`provider ${provider.id} attempt ${retry + 1} failed (${providerError.message}) — failing over`);
            break;
          }
          log.info(`provider ${provider.id} attempt ${retry + 1}/${PROVIDER_RETRIES} failed (${providerError.message}) — retry in ${RETRY_BACKOFF_MS}ms`);
          await sleep(RETRY_BACKOFF_MS, options.signal);
          if (options.signal?.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
        }
      }
    }

    const summary = errors.join(" | ");
    throw new RouterError("provider_failed", `all providers failed — ${summary}`);
  }

  private cooldownFor(error: ProviderError): number {
    // 401/403 still cool the provider: its credentials are bad, not the prompt.
    // Bad key or revoked access: back off hard, it is not a momentary blip.
    if (error.status === 401 || error.status === 403) return 5 * 60_000;
    if (error.retryAfterMs !== undefined) return Math.max(error.retryAfterMs, 2_000);
    if (error.status === 429) return 10_000;
    if (error.kind === "timeout") return 5_000;
    if (error.status !== undefined && error.status >= 500) return 10_000;
    return 10_000;
  }

  status(): ProviderStatus[] {
    const chatgpt = this.chatgpt?.provider();
    return [...(chatgpt ? [chatgpt] : []), ...this.providers].map((provider) => {
      const snapshot = this.health.snapshot([provider.id])[0];
      return {
        id: provider.id,
        label: provider.label,
        model: provider.model,
        available: provider.id === "chatgpt" && this.chatgpt?.state().status === "reauth_required" ? false : snapshot?.available ?? true,
        cooldownRemainingMs: snapshot?.cooldownRemainingMs ?? 0,
        lastError: snapshot?.lastError,
        lastSuccessAt: snapshot?.lastSuccessAt,
      };
    });
  }
}

/** 4xx other than auth, 408 and 429: the request itself is bad, on any provider. */
function isRequestError(error: ProviderError): boolean {
  const status = error.status;
  return status !== undefined && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

/** Worth another try on the same provider: a quick transient failure, not a stall or a rejection. */
function isRetryable(error: ProviderError): boolean {
  if (error.kind === "network") return true;
  const status = error.status;
  return status === 408 || status === 429 || (status !== undefined && status >= 500);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
