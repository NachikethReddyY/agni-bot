/**
 * Bot debugger data (GET /debug/*) and the plain-English diagnosis of a turn.
 * Shapes mirror apps/server/src/debug/http.ts.
 */

export interface DebugLimits {
  turnTimeoutMs: number;
  firstTokenTimeoutMs: number;
}

export interface DebugProvider {
  id: string;
  label: string;
  model: string;
  available: boolean;
  cooldownRemainingMs: number;
  lastError?: string;
  lastSuccessAt?: number;
}

export interface DebugTurnRow {
  id: string;
  thread_id: string;
  agent_id: string;
  state: string;
  stop_reason: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  started_at: string;
  ended_at: string | null;
  tool_count: number;
  failed_count: number;
  tool_names: string | null;
  step_count: number | null;
  token_count: number | null;
}

export interface DebugSession {
  thread_id: string;
  agent_id: string | null;
  turn_id: string;
  state: string;
  step_count: number;
  token_count: number;
  max_steps: number;
  max_tokens: number;
  message_count: number;
  log_chars: number;
  summary_chars: number;
  updated_at: string;
}

export interface DebugJob {
  id: string;
  kind: string;
  state: string;
  run_at: string;
  attempts: number;
  enabled: number;
  result: string | null;
  updated_at: string;
  agentID: string | null;
  title: string | null;
}

export interface DebugOverview {
  serverTime: string;
  limits: DebugLimits;
  providers: DebugProvider[];
  capacity: { active: number; capacity: number };
  usageToday: { turns: number; inputTokens: number; outputTokens: number };
  agents: Array<{ id: string; name: string; role: string; tools: string | null }>;
  sessions: DebugSession[];
  jobs: DebugJob[];
  turns: DebugTurnRow[];
}

export interface DebugToolCall {
  call_id: string;
  tool_name: string;
  args: unknown;
  result: string | null;
  ok: boolean;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface DebugContextMessage {
  role: string;
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string | null }>;
  toolCallID?: string;
  reasoning?: string;
}

export interface DebugTurnDetail {
  turn: DebugTurnRow & { agent_name: string | null; thread_title: string | null; conversation_id: string | null };
  tools: DebugToolCall[];
  messages: Array<{ source: string; role: string; from_id: string | null; internal: number; text: string; created_at: string }>;
  session: { state: string; step_count: number; token_count: number; max_steps: number; max_tokens: number; summary: string | null; updated_at: string } | null;
  context: DebugContextMessage[] | null;
}

export type Severity = "error" | "warn" | "info";
export interface Finding { severity: Severity; title: string; detail?: string }

/** A tool taking longer than this is worth a look. */
const SLOW_TOOL_MS = 10_000;
/** A single model call taking longer than this makes the bot feel stuck. */
const SLOW_MODEL_MS = 20_000;

/**
 * A tool that ran but handed back `{ "error": ... }`. The server records it
 * as a success because nothing threw, yet the bot got nothing useful.
 */
export function reportedError(result: string | null | undefined): string | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") return (parsed as { error: string }).error;
  } catch { /* not JSON: not an error object */ }
  return null;
}

export function turnDurationMs(turn: Pick<DebugTurnRow, "started_at" | "ended_at">, now = Date.now()): number {
  return (turn.ended_at ? Date.parse(turn.ended_at) : now) - Date.parse(turn.started_at);
}

/** Steps used: the session's own count when it survived, else one per recorded tool call. */
export function stepsUsed(turn: Pick<DebugTurnRow, "step_count" | "tool_count">): number {
  return turn.step_count ?? turn.tool_count;
}

/** A row in the turn list deserves attention. */
export function isProblem(turn: DebugTurnRow): boolean {
  return (turn.stop_reason !== null && turn.stop_reason !== "end") || turn.failed_count > 0;
}

export function stopReasonText(reason: string | null, limits: DebugLimits): string {
  switch (reason) {
    case null: return "Still running";
    case "end": return "Finished normally";
    case "budget": return "Ran out of budget (the old tool or token limit, since removed)";
    case "timeout": return `Timed out (limit ${Math.round(limits.turnTimeoutMs / 1000)}s)`;
    case "cancelled": return "Cancelled — you pressed stop, or sent a new message that took over";
    case "error": return "Failed with an error";
    case "needs_input": return "Paused, waiting for your answer";
    default: return reason;
  }
}

/** Plain-English findings for one turn, worst first. */
export function diagnoseTurn(detail: DebugTurnDetail, limits: DebugLimits, now = Date.now()): Finding[] {
  const { turn, tools, session, context } = detail;
  const findings: Finding[] = [];
  const steps = session?.step_count ?? tools.length;
  const duration = turnDurationMs(turn, now);

  if (turn.stop_reason === "budget") {
    findings.push({ severity: "error", title: `Hit the old tool/token limit after ${steps} tool calls`, detail: "This turn ran before the limits were removed; it was cut off mid-task." });
  }
  if (turn.stop_reason === "timeout") {
    findings.push({ severity: "error", title: `Timed out after ${Math.round(duration / 1000)}s`, detail: `The whole turn may run for ${Math.round(limits.turnTimeoutMs / 1000)}s. Slow models or slow tools use it up.` });
  }
  if (turn.stop_reason === "error") {
    const last = context?.at(-1);
    findings.push({ severity: "error", title: "The turn failed", detail: last?.role === "assistant" && last.content ? last.content : undefined });
  }
  if (!turn.ended_at && duration > limits.turnTimeoutMs + 30_000) {
    findings.push({ severity: "error", title: "Looks stuck", detail: `Marked running for ${Math.round(duration / 1000)}s, past the ${Math.round(limits.turnTimeoutMs / 1000)}s timeout. The server may have restarted mid-turn.` });
  }

  const failed = tools.filter((tool) => !tool.ok);
  if (failed.length > 0) {
    const denied = failed.filter((tool) => tool.error === "approval_rejected");
    const blocked = failed.filter((tool) => tool.error === "tool_not_allowed");
    const broken = failed.filter((tool) => tool.error !== "approval_rejected" && tool.error !== "tool_not_allowed");
    if (broken.length) findings.push({ severity: "warn", title: `${broken.length} tool call${broken.length === 1 ? "" : "s"} failed`, detail: broken.map((tool) => `${tool.tool_name}: ${tool.error ?? "error"}`).join("\n") });
    if (blocked.length) findings.push({ severity: "warn", title: `Tried ${blocked.length} tool${blocked.length === 1 ? "" : "s"} it is not allowed to use`, detail: blocked.map((tool) => tool.tool_name).join(", ") });
    if (denied.length) findings.push({ severity: "info", title: `You denied ${denied.length} action${denied.length === 1 ? "" : "s"}`, detail: denied.map((tool) => tool.tool_name).join(", ") });
  }

  const soft = tools.filter((tool) => tool.ok && reportedError(tool.result));
  if (soft.length) {
    findings.push({
      severity: "warn",
      title: `${soft.length} tool call${soft.length === 1 ? "" : "s"} returned an error`,
      detail: soft.map((tool) => `${tool.tool_name}: ${reportedError(tool.result)}`).join("\n"),
    });
  }

  const repeats = new Map<string, number>();
  for (const tool of tools) {
    const key = `${tool.tool_name} ${JSON.stringify(tool.args)}`;
    repeats.set(key, (repeats.get(key) ?? 0) + 1);
  }
  for (const [key, count] of repeats) {
    if (count > 1) findings.push({ severity: "warn", title: `Repeated the same call ${count}×`, detail: `${key} — a sign the bot is looping.` });
  }
  const skipped = context?.filter((message) => message.role === "tool" && message.content?.includes('"skipped":true')).length ?? 0;
  if (skipped > 0) findings.push({ severity: "warn", title: `${skipped} duplicate call${skipped === 1 ? " was" : "s were"} skipped`, detail: "The loop guard refused an exact repeat; each one still used a step." });

  for (const tool of tools) {
    if ((tool.duration_ms ?? 0) >= SLOW_TOOL_MS) {
      findings.push({ severity: "warn", title: `Slow tool: ${tool.tool_name} took ${Math.round((tool.duration_ms ?? 0) / 1000)}s`, detail: "Includes time spent waiting for your approval, if it asked." });
    }
  }
  if ((turn.latency_ms ?? 0) >= SLOW_MODEL_MS) {
    findings.push({ severity: "warn", title: `Slow model: last call took ${Math.round((turn.latency_ms ?? 0) / 1000)}s`, detail: `${turn.provider ?? "?"} · ${turn.model ?? "?"}` });
  }

  if (turn.stop_reason === "end" && context) {
    const answer = [...context].reverse().find((message) => message.role === "assistant" && !message.toolCalls?.length);
    if (!answer || !answer.content?.trim()) findings.push({ severity: "warn", title: "Ended without a written answer", detail: "The last thing the bot did was call a tool, or it replied with empty text." });
  }
  if (turn.stop_reason === "needs_input") findings.push({ severity: "info", title: "Waiting for your answer", detail: "The turn is parked; your reply resumes it." });
  if (turn.stop_reason === "cancelled") findings.push({ severity: "info", title: "Cancelled", detail: stopReasonText("cancelled", limits) });
  if (tools.length === 0 && turn.stop_reason === "end") findings.push({ severity: "info", title: "Answered without using any tools" });
  if (!context) findings.push({ severity: "info", title: "Full context not kept for this turn", detail: "The server keeps the exact model context only for the newest turn of each chat session. Tool calls are still shown." });

  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

export type FlowItem =
  | { kind: "history"; messages: DebugContextMessage[] }
  | { kind: "user"; text: string }
  | { kind: "system"; text: string }
  | { kind: "step"; index: number; text: string; reasoning?: string; calls: Array<{ id: string; name: string; arguments: string | null; record?: DebugToolCall; result?: string | null; skipped: boolean }> }
  | { kind: "answer"; text: string }
  | { kind: "tool"; record: DebugToolCall };

/**
 * The turn as a sequence: what was asked, each model step with the tools it
 * called and what came back, then the answer. Uses the saved context when the
 * server kept it, and falls back to the tool-call records otherwise.
 */
export function buildFlow(detail: DebugTurnDetail): FlowItem[] {
  const records = new Map(detail.tools.map((tool) => [tool.call_id, tool]));
  if (!detail.context) {
    const items: FlowItem[] = [];
    const asked = detail.messages.find((message) => message.role === "user" || message.role === "owner");
    if (asked) items.push({ kind: "user", text: asked.text });
    for (const tool of detail.tools) items.push({ kind: "tool", record: tool });
    const answered = [...detail.messages].reverse().find((message) => message.role === "assistant" || message.role === "agent");
    if (answered) items.push({ kind: "answer", text: answered.text });
    return items;
  }

  const results = new Map<string, string | null>();
  for (const message of detail.context) if (message.role === "tool" && message.toolCallID) results.set(message.toolCallID, message.content);

  // The saved context opens with up to 16 earlier chat messages; the turn's
  // own request is the last user message before the first tool step.
  const firstStep = detail.context.findIndex((message) => message.role === "assistant" && message.toolCalls?.length);
  const searchEnd = firstStep === -1 ? detail.context.length : firstStep;
  let start = 0;
  for (let i = searchEnd - 1; i >= 0; i -= 1) if (detail.context[i]!.role === "user") { start = i; break; }

  const items: FlowItem[] = start > 0 ? [{ kind: "history", messages: detail.context.slice(0, start) }] : [];
  let step = 0;
  for (const message of detail.context.slice(start)) {
    if (message.role === "user") items.push({ kind: "user", text: message.content ?? "" });
    else if (message.role === "system") items.push({ kind: "system", text: message.content ?? "" });
    else if (message.role === "assistant" && message.toolCalls?.length) {
      step += 1;
      items.push({
        kind: "step",
        index: step,
        text: message.content ?? "",
        reasoning: message.reasoning,
        calls: message.toolCalls.map((call) => {
          const result = results.get(call.id);
          return { ...call, record: records.get(call.id), result, skipped: Boolean(result?.includes('"skipped":true')) };
        }),
      });
    } else if (message.role === "assistant") items.push({ kind: "answer", text: message.content ?? "" });
  }
  return items;
}
