/** Responses transport for OAuth-authorized ChatGPT plan usage, not API-key billing. */
import { ProviderError, parseRetryAfter, type ChatRequest, type ChatResult, type ResponseContextItem, type ToolCall } from "./client";

const NAMESPACE = "agni";
const ERROR_MESSAGES: Record<string, string> = {
  subscription_sharing_user_not_eligible: "ChatGPT plan usage is unavailable for this account or workspace.",
  subscription_sharing_usage_limit_exceeded: "ChatGPT usage limit reached. Review Agni's allowance in ChatGPT Settings → Usage.",
  subscription_sharing_usage_unavailable: "ChatGPT usage availability could not be checked. Try again shortly.",
  subscription_sharing_user_unavailable: "ChatGPT account information is temporarily unavailable. Try again shortly.",
  subscription_sharing_invalid_user: "ChatGPT could not verify this account. Sign in again in Models & providers.",
  subscription_sharing_unsupported_capability: "This model request contains a capability that ChatGPT plan usage does not support.",
  subscription_sharing_route_not_supported: "ChatGPT plan usage does not support this request route.",
};

export function responsesBody(request: ChatRequest): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.responseItems) input.push(...message.responseItems.map((item) => ({ ...item })));
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.toolCallID, output: message.content });
      continue;
    }
    if (message.content || message.images?.length) input.push({
      role: message.role === "system" ? "developer" : message.role,
      content: message.images?.length
        ? [{ type: "input_text", text: message.content }, ...message.images.map((image_url) => ({ type: "input_image", image_url }))]
        : message.content,
    });
    for (const call of message.toolCalls ?? []) input.push({ type: "function_call", namespace: NAMESPACE, name: call.function.name, call_id: call.id, arguments: call.function.arguments });
  }
  const tools = request.tools?.map(({ function: fn }) => ({ type: "function", name: fn.name, description: fn.description, parameters: fn.parameters, strict: false }));
  return {
    model: request.model, input, store: false, stream: true,
    include: ["reasoning.encrypted_content"],
    ...(tools?.length ? {
      tools: [{ type: "namespace", name: NAMESPACE, description: "Agni assistant tools, executed locally with Agni's permission checks.", tools }],
      tool_choice: typeof request.toolChoice === "object"
        ? { type: "function", namespace: NAMESPACE, name: request.toolChoice.function.name }
        : request.toolChoice ?? "auto",
    } : {}),
  };
}

export function chatGPTError(payload: unknown, status = 500, retryAfterMs?: number): ProviderError {
  const raw = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const error = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : raw;
  const code = typeof error.code === "string" ? error.code : "";
  const message = ERROR_MESSAGES[code] ?? (status === 401 ? "ChatGPT access was not accepted. Sign in again in Models & providers."
    : status === 403 ? "ChatGPT access is restricted for this account, workspace, or region."
    : status === 429 ? "ChatGPT usage limit reached. Review your allowance in ChatGPT Settings → Usage."
    : `ChatGPT request failed (HTTP ${status}). Try again or check Models & providers.`);
  // Endpoint bodies are deliberately not echoed: they may contain credentials or user input.
  return new ProviderError(message, { kind: "http", status, retryAfterMs });
}

export async function streamChatGPT(request: ChatRequest): Promise<ChatResult> {
  const controller = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
  if (signal.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
  let timedOut = false;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { timedOut = true; controller.abort(); }, request.firstTokenTimeoutMs);
  const progress = (): void => { if (timer) clearTimeout(timer); timer = undefined; };
  let reader: { cancel(): Promise<void>; releaseLock(): void } | undefined;
  let firstTokenMs = -1;
  let text = "";
  let completed = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let outputCharacters = 0;
  const outputLimit = Math.max(1, request.maxTokens ?? 8_192) * 4;
  const calls = new Map<string, ToolCall>();
  const responseItems: ResponseContextItem[] = [];
  const recordItem = (item: Record<string, unknown>): void => {
    if (item.type === "function_call") {
      if (item.namespace !== undefined && item.namespace !== NAMESPACE) throw new ProviderError("ChatGPT returned a tool from an unknown namespace.", { kind: "parse" });
      if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") throw new ProviderError("ChatGPT returned an incomplete tool call.", { kind: "parse" });
      calls.set(item.call_id, { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
      const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is { type: "summary_text"; text: string } => s?.type === "summary_text" && typeof s.text === "string") : [];
      const context: ResponseContextItem = { type: "reasoning", encrypted_content: item.encrypted_content, summary, ...(typeof item.id === "string" ? { id: item.id } : {}) };
      const existing = responseItems.findIndex((r) => r.id && r.id === context.id);
      if (existing >= 0) responseItems[existing] = context; else responseItems.push(context);
    }
  };
  const handleEvent = (data: string): void => {
    if (!data || data === "[DONE]") return;
    let event: Record<string, any>;
    try { event = JSON.parse(data); } catch { throw new ProviderError("ChatGPT returned a malformed stream event.", { kind: "parse" }); }
    if (["response.output_text.delta", "response.function_call_arguments.delta"].includes(event.type) && typeof event.delta === "string") {
      outputCharacters += event.delta.length;
      if (outputCharacters > outputLimit) throw new ProviderError("ChatGPT response reached Agni's output limit. Partial output was kept.", { kind: "parse" });
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      progress();
      if (firstTokenMs < 0) firstTokenMs = Date.now() - startedAt;
      text += event.delta; request.onDelta(event.delta);
    } else if (event.type === "response.output_item.added" && ["function_call", "reasoning"].includes(event.item?.type)) {
      progress();
    } else if (event.type === "response.function_call_arguments.delta") {
      progress();
    } else if (event.type === "response.output_item.done" && event.item) {
      recordItem(event.item);
    } else if (event.type === "response.completed") {
      if (event.response?.status !== "completed") throw new ProviderError("ChatGPT did not complete this response.", { kind: "network" });
      for (const item of event.response.output ?? []) recordItem(item);
      inputTokens = event.response.usage?.input_tokens;
      outputTokens = event.response.usage?.output_tokens;
      completed = true; progress();
    } else if (event.type === "response.failed" || event.type === "error") {
      const error = event.response?.error ?? event.error ?? event;
      const code = typeof error.code === "string" ? error.code : "";
      throw chatGPTError({ error }, code.includes("limit") ? 429 : code.includes("invalid_user") ? 401 : 503);
    } else if (event.type === "response.incomplete") {
      throw new ProviderError("ChatGPT returned an incomplete response. Please try again.", { kind: "network" });
    }
  };
  try {
    const response = await (request.fetchFn ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${request.apiKey}` },
      body: JSON.stringify(responsesBody(request)), signal, redirect: "error",
    });
    if (!response.ok) throw chatGPTError(await response.json().catch(() => ({})), response.status, parseRetryAfter(response.headers.get("retry-after")));
    if (!response.body) throw new ProviderError("ChatGPT returned no response stream.", { kind: "network" });
    const streamReader = response.body.getReader();
    reader = streamReader;
    const decoder = new TextDecoder();
    let buffer = "";
    let data: string[] = [];
    const line = (value: string): void => {
      if (!value) { handleEvent(data.join("\n")); data = []; }
      else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    };
    while (!completed) {
      const part = await streamReader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, newline).replace(/\r$/, "")); buffer = buffer.slice(newline + 1);
        if (completed) break;
      }
      if (buffer.length > 4 * 1024 * 1024) throw new ProviderError("ChatGPT stream event exceeded the size limit.", { kind: "parse" });
      if (part.done) { if (buffer) line(buffer.replace(/\r$/, "")); if (data.length) line(""); break; }
    }
    if (!completed) throw new ProviderError("ChatGPT stream ended before completion. Partial output was kept.", { kind: "network" });
    return { text, firstTokenMs: firstTokenMs < 0 ? Date.now() - startedAt : firstTokenMs, inputTokens, outputTokens,
      ...(calls.size ? { toolCalls: [...calls.values()] } : {}), ...(responseItems.length ? { responseItems } : {}) };
  } catch (error) {
    if (timedOut) throw new ProviderError("ChatGPT did not respond in time. Try again.", { kind: "timeout" });
    if (signal.aborted) throw new ProviderError("cancelled", { kind: "aborted" });
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("Could not reach ChatGPT. Check your connection and try again.", { kind: "network" });
  } finally {
    progress(); await reader?.cancel().catch(() => {}); reader?.releaseLock();
  }
}
