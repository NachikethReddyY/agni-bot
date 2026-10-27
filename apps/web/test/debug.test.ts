import { describe, expect, it } from "vitest";
import { buildFlow, diagnoseTurn, type DebugLimits, type DebugTurnDetail } from "../src/state/debug";

const limits: DebugLimits = { maxSteps: 16, maxTokens: 16_000, turnTimeoutMs: 120_000, firstTokenTimeoutMs: 30_000 };

function detail(overrides: Partial<DebugTurnDetail> = {}): DebugTurnDetail {
  return {
    turn: {
      id: "trn_1", thread_id: "thr_1", agent_id: "ea", state: "done", stop_reason: "end",
      provider: "groq", model: "m", input_tokens: 100, output_tokens: 20, latency_ms: 800,
      started_at: "2026-10-27T00:00:00.000Z", ended_at: "2026-10-27T00:00:05.000Z",
      tool_count: 0, failed_count: 0, tool_names: null, step_count: null, token_count: null,
      agent_name: "New Bot", thread_title: null, conversation_id: null,
    },
    tools: [],
    messages: [],
    session: null,
    context: null,
    ...overrides,
  };
}

const call = (id: string, name: string, ok = true, extra: Record<string, unknown> = {}) => ({
  call_id: id, tool_name: name, args: { q: "x" }, result: ok ? "{}" : null, ok, error: ok ? null : "timeout", duration_ms: 100, created_at: "2026-10-27T00:00:01.000Z", ...extra,
});

describe("bot debugger diagnosis", () => {
  it("flags the tool limit, failures, loops and slow tools", () => {
    const tools = Array.from({ length: 16 }, (_, i) => call(`c${i}`, i < 3 ? "search_email" : `tool_${i}`, i !== 5, i === 7 ? { duration_ms: 15_000 } : {}));
    const findings = diagnoseTurn(detail({
      turn: { ...detail().turn, stop_reason: "end" },
      tools,
      session: { state: "done", step_count: 16, token_count: 900, max_steps: 16, max_tokens: 16_000, summary: null, updated_at: "" },
      context: [{ role: "user", content: "go" }],
    }), limits);
    const titles = findings.map((finding) => finding.title);
    expect(titles[0]).toBe("Hit the 16-tool limit");
    expect(titles).toContain("1 tool call failed");
    expect(titles).toContain("Repeated the same call 3×");
    expect(titles).toContain("Slow tool: tool_7 took 15s");
    expect(titles).toContain("Ended without a written answer");
  });

  it("catches a tool that ran but handed back an error", () => {
    const findings = diagnoseTurn(detail({ tools: [call("c1", "mail_search", true, { result: "{\"error\":\"Mail is not connected\"}" })] }), limits);
    expect(findings[0]).toMatchObject({ severity: "warn", title: "1 tool call returned an error", detail: "mail_search: Mail is not connected" });
  });

  it("says plainly when nothing went wrong", () => {
    const findings = diagnoseTurn(detail({ context: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }), limits);
    expect(findings.map((finding) => finding.title)).toEqual(["Answered without using any tools"]);
  });
});

describe("bot debugger flow", () => {
  it("separates earlier chat from the turn and joins tool results to their calls", () => {
    const flow = buildFlow(detail({
      tools: [call("c1", "search_email")],
      context: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "check my mail" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "search_email", arguments: "{}" }, { id: "c2", name: "search_email", arguments: "{}" }] },
        { role: "tool", toolCallID: "c1", content: "{\"hits\":1}" },
        { role: "tool", toolCallID: "c2", content: "{\"skipped\":true}" },
        { role: "assistant", content: "You have one email." },
      ],
    }));
    expect(flow.map((item) => item.kind)).toEqual(["history", "user", "step", "answer"]);
    const step = flow[2];
    if (step?.kind !== "step") throw new Error("expected a step");
    expect(step.calls.map((c) => [c.id, c.record?.tool_name ?? null, c.skipped])).toEqual([["c1", "search_email", false], ["c2", null, true]]);
  });

  it("falls back to tool records when the context was not kept", () => {
    const flow = buildFlow(detail({ tools: [call("c1", "search_email")], messages: [{ source: "thread", role: "user", from_id: null, internal: 0, text: "hi", created_at: "" }] }));
    expect(flow.map((item) => item.kind)).toEqual(["user", "tool"]);
  });
});
