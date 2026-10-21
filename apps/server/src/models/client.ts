/**
 * Minimal streaming client for OpenAI-compatible `chat/completions`.
 * Every provider in the catalog speaks this shape, so this file is the only
 * place that knows how to talk to a model endpoint.
 */
import { log } from "../log";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Durable IDs persisted in sessions; expanded just before the provider call. */
  attachmentIDs?: string[];
  images?: string[];
  /** Tool calls the assistant made (only on `assistant` messages). */
  toolCalls?: ToolCall[];
  /** Required on tool replies so OpenAI-compatible APIs can pair the result. */
  toolCallID?: string;
  /**
   * The model's own reasoning for this message, when the provider streamed it.
   * Kept on the durable message log so an export can show it; never sent back
   * to the provider and never rendered in the chat.
   */
  reasoning?: string;
}

/** One tool-call fragment, as returned by the provider. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** A tool definition surfaced to the model as JSON-schema-shaped args. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ProviderErrorKind = "http" | "network" | "timeout" | "aborted" | "parse";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, options: { kind: ProviderErrorKind; status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "ProviderError";
    this.kind = options.kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Abort the attempt if no content token arrives within this window. */
  firstTokenTimeoutMs: number;
  onDelta: (delta: string) => void;
  temperature?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
  /** Tool schemas injected into the request; the model may emit tool_calls. */
  tools?: ToolSpec[];
  /** When true, the model is forced to pick exactly one tool (HITL gate flow). */
  toolChoice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } };
}

export interface ChatResult {
  text: string;
  firstTokenMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Structured tool calls the model emitted, if any. */
  toolCalls?: ToolCall[];
  /**
   * The model's own reasoning, when a provider streams it (NIM and DeepSeek
   * expose `reasoning_content`). Absent for models that do not.
   */
  reasoning?: string;
}

/** Parse an HTTP Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export async function streamChat(request: ChatRequest): Promise<ChatResult> {
  const fetchFn = request.fetchFn ?? fetch;
  const url = `${request.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  let timedOut = false;
  let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;

  const abortFromCaller = (): void => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    request.signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const cleanup = (): void => {
    if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
    request.signal?.removeEventListener("abort", abortFromCaller);
  };

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.images?.length
            ? [{ type: "text", text: message.content }, ...message.images.map((url) => ({ type: "image_url", image_url: { url } }))]
            : message.content,
          ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
          ...(message.toolCallID ? { tool_call_id: message.toolCallID } : {}),
        })),
        stream: true,
        ...(request.tools?.length ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    if (request.signal?.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    throw new ProviderError(`request failed: ${messageOf(error)}`, { kind: "network" });
  }

  if (!response.ok) {
    cleanup();
    const body = await response.text().catch(() => "");
    throw new ProviderError(`HTTP ${response.status}: ${truncate(body, 300)}`, {
      kind: "http",
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    });
  }
  if (!response.body) {
    cleanup();
    throw new ProviderError("response has no body", { kind: "network" });
  }

  firstTokenTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.firstTokenTimeoutMs);

  const startedAt = Date.now();
  let reasoning = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTokenMs = -1;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  // Tool calls arrive as incremental fragments keyed by index; accumulate them.
  const toolFragments = new Map<number, { id?: string; name?: string; arguments: string }>();

  try {
    // SSE: one JSON event per `data:` line, terminated by `data: [DONE]`.
    streamLoop: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payloadText = line.slice("data:".length).trim();
        if (payloadText === "[DONE]") break streamLoop;
        let payload: unknown;
        try {
          payload = JSON.parse(payloadText);
        } catch {
          continue; // keep-alive comments and partial junk are not fatal
        }
        const choice = (payload as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0];
        if (!choice?.delta) continue;
        const delta = choice.delta;
        const content = delta.content;
        if (typeof content === "string" && content.length > 0) {
          if (firstTokenMs < 0) {
            firstTokenMs = Date.now() - startedAt;
            if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
          }
          text += content;
          request.onDelta(content);
        }
        // Reasoning is output too. Counting it as a token keeps a thinking
        // model from being aborted as "stalled" before it ever writes prose,
        // and the text is kept so an export can show it when the provider
        // exposes it. It is never streamed to the chat.
        const thought = reasoningDelta(delta);
        if (thought.length > 0) {
          if (firstTokenMs < 0) {
            firstTokenMs = Date.now() - startedAt;
            if (firstTokenTimer !== undefined) clearTimeout(firstTokenTimer);
          }
          reasoning += thought;
        }
        // Accumulate tool-call fragments (OpenAI streaming shape).
        const calls = delta.tool_calls;
        if (Array.isArray(calls)) {
          if (calls.length > 0 && firstTokenTimer !== undefined) {
            firstTokenMs = Date.now() - startedAt;
            clearTimeout(firstTokenTimer);
            firstTokenTimer = undefined;
          }
          for (const fragment of calls as Array<Record<string, unknown>>) {
            const index = typeof fragment.index === "number" ? fragment.index : 0;
            const existing = toolFragments.get(index) ?? { arguments: "" };
            if (typeof fragment.id === "string") existing.id = fragment.id;
            const fn = fragment.function as { name?: string; arguments?: string } | undefined;
            if (typeof fn?.name === "string") existing.name = fn.name;
            if (typeof fn?.arguments === "string") existing.arguments += fn.arguments;
            toolFragments.set(index, existing);
          }
        }
        const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }
      }
    }
  } catch (error) {
    if (timedOut) throw new ProviderError(`no first token within ${request.firstTokenTimeoutMs}ms`, { kind: "timeout" });
    if (request.signal?.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    throw new ProviderError(`stream failed: ${messageOf(error)}`, { kind: "network" });
  } finally {
    cleanup();
    reader.releaseLock?.();
  }

  if (firstTokenMs < 0) {
    // The stream ended without a single content token.
    log.debug(`provider returned no content tokens for model ${request.model}`);
    firstTokenMs = Date.now() - startedAt;
  }
  const toolCalls = buildToolCalls(toolFragments);
  return {
    text, firstTokenMs, inputTokens, outputTokens,
    ...(reasoning.trim().length > 0 ? { reasoning: reasoning.trim() } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

/**
 * Providers spell streamed reasoning differently — `reasoning_content` on NIM
 * and DeepSeek, plain `reasoning` on some gateways. Anything else is content.
 */
function reasoningDelta(delta: Record<string, unknown>): string {
  for (const key of ["reasoning_content", "reasoning"]) {
    const value = delta[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** Reassemble streaming tool-call fragments into complete ToolCall objects. */
function buildToolCalls(fragments: Map<number, { id?: string; name?: string; arguments: string }>): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [, fragment] of fragments) {
    if (!fragment.id || !fragment.name) continue;
    calls.push({
      id: fragment.id,
      type: "function",
      function: { name: fragment.name, arguments: fragment.arguments },
    });
  }
  return calls;
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
