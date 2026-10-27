import { describe, expect, test } from "bun:test";
import {
  JobInfoSchema,
  PROTOCOL_VERSION,
  decodeText,
  encodeFrame,
  isSupportedVersion,
  parseClientFrame,
  parseServerFrame,
} from "../src/index";

describe("client frames", () => {
  test("validates versioned appearance profiles", () => {
    const profile = { version: 1, id: "theme_test", name: "Test", mode: "system", preset: "agni", accent: "ember", background: { kind: "none" }, textScale: "default", density: "comfortable", corners: "standard", motion: "system", agentTint: "full", updatedAt: "2026-10-23T00:00:00.000Z" };
    expect(parseClientFrame({ type: "appearance.save", profile }).ok).toBe(true);
    expect(parseClientFrame({ type: "appearance.save", profile: { ...profile, customAccent: "red", accent: "custom" } }).ok).toBe(false);
  });
  test("accepts ChatGPT account actions without an API key", () => {
    expect(parseClientFrame({ type: "provider.auth.start", providerID: "chatgpt" }).ok).toBe(true);
    expect(parseClientFrame({ type: "provider.auth.select", providerID: "chatgpt", accountID: "unit-account" }).ok).toBe(true);
    expect(parseClientFrame({ type: "provider.auth.start", providerID: "unknown" }).ok).toBe(false);
    expect(parseClientFrame({ type: "provider.auth.disconnect", providerID: "chatgpt" }).ok).toBe(false);
  });
  test("accepts a full msg.send", () => {
    const result = parseClientFrame({
      type: "msg.send",
      threadID: "thr_1",
      text: "hello",
      files: ["a.png"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe("msg.send");
      if (result.frame.type === "msg.send") expect(result.frame.text).toBe("hello");
    }
  });

  test("accepts channel sends, typing, and agent rename frames", () => {
    expect(parseClientFrame({ type: "msg.send", text: "hello", channelId: "main", texts: ["hello"] }).ok).toBe(true);
    expect(parseClientFrame({ type: "user.typing", channelId: "main", isTyping: true }).ok).toBe(true);
    expect(parseClientFrame({ type: "agent.rename", agentId: "ea", name: "Agni" }).ok).toBe(true);
  });

  test("accepts empty threadID as new-thread signal", () => {
    const result = parseClientFrame({ type: "msg.send", threadID: "", text: "hi" });
    expect(result.ok).toBe(true);
  });

  test("rejects missing text", () => {
    const result = parseClientFrame({ type: "msg.send", threadID: "thr_1" });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown frame types", () => {
    const result = parseClientFrame({ type: "msg.explode", threadID: "thr_1" });
    expect(result.ok).toBe(false);
  });

  test("rejects a bad decision token", () => {
    const result = parseClientFrame({ type: "approve.reply", requestID: "req_1", decision: "maybe" });
    expect(result.ok).toBe(false);
  });

  test("accepts hello with a version", () => {
    const result = parseClientFrame({ type: "hello", v: PROTOCOL_VERSION, token: "agni_x", device: "cli" });
    expect(result.ok).toBe(true);
  });

  test("accepts durable-state reads with and without limits", () => {
    expect(parseClientFrame({ type: "thread.list" }).ok).toBe(true);
    expect(parseClientFrame({ type: "thread.list", limit: 5 }).ok).toBe(true);
    expect(parseClientFrame({ type: "thread.list", limit: 0 }).ok).toBe(false);
    expect(parseClientFrame({ type: "thread.history", threadID: "thr_1" }).ok).toBe(true);
    expect(parseClientFrame({ type: "thread.history", threadID: "" }).ok).toBe(false);
  });
});

describe("server frames", () => {
  test("accepts channel messages, activity, and agent updates", () => {
    expect(parseServerFrame({ type: "status.update", seq: 1, channelId: "main", text: "Working", transient: true }).ok).toBe(true);
    expect(parseServerFrame({
      type: "msg.new", seq: 2, id: "m1", channelId: "main", fromType: "agent", fromId: "ea",
      senderName: "Agni", text: "Hi", internal: false, uiHint: "normal", createdAt: "2026-10-17T00:00:00Z",
    }).ok).toBe(true);
    expect(parseServerFrame({ type: "agent.updated", seq: 3, agentId: "ea", displayName: "Agni", onboarded: true }).ok).toBe(true);
  });
  test("accepts hello.ok with seq", () => {
    const result = parseServerFrame({
      type: "hello.ok",
      seq: 1,
      v: PROTOCOL_VERSION,
      serverTime: "2026-10-16T12:00:00.000Z",
      lastSeq: 1,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects server frames without seq", () => {
    const result = parseServerFrame({ type: "presence", state: "online" });
    expect(result.ok).toBe(false);
  });

  test("accepts turn.end with usage", () => {
    const result = parseServerFrame({
      type: "turn.end",
      seq: 9,
      turnID: "trn_1",
      threadID: "thr_1",
      stopReason: "end",
      usage: { provider: "groq", model: "llama-3.1-8b-instant", latencyMs: 412 },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects unknown stop reason", () => {
    const result = parseServerFrame({
      type: "turn.end",
      seq: 9,
      turnID: "trn_1",
      threadID: "thr_1",
      stopReason: "exploded",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts thread list and history replies", () => {
    const list = parseServerFrame({
      type: "thread.list.ok",
      seq: 12,
      threads: [{ id: "thr_1", agentID: "agni", title: "bench notes", updatedAt: "2026-10-16T12:00:00.000Z" }],
    });
    expect(list.ok).toBe(true);
    if (list.ok && list.frame.type === "thread.list.ok") {
      expect(list.frame.threads[0]?.title).toBe("bench notes");
    }

    const history = parseServerFrame({
      type: "thread.history.ok",
      seq: 13,
      threadID: "thr_1",
      messages: [
        { id: "msg_1", role: "user", text: "hi", createdAt: "2026-10-16T12:00:00.000Z", turnID: "trn_1" },
        { id: "msg_2", role: "assistant", text: "hello", createdAt: "2026-10-16T12:00:01.000Z" },
      ],
    });
    expect(history.ok).toBe(true);
    if (history.ok && history.frame.type === "thread.history.ok") {
      expect(history.frame.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    }
  });
});

describe("routine info on job frames", () => {
  const job = {
    id: "job_1",
    kind: "routine",
    state: "queued",
    runAt: "2026-10-27T06:30:00.000Z",
    enabled: true,
    attempts: 0,
    title: "Morning digest",
    threadID: "thr_1",
  };
  const routine = {
    name: "Morning digest",
    cron: "30 7 * * *",
    timezone: "Europe/Berlin",
    misfire: "run_once",
    preflight: "http",
    maxTokens: 16000,
    maxExecutionMs: 120000,
    allowedDomains: ["example.com"],
    successStreak: 3,
    failureStreak: 0,
    recentRuns: [{ at: "2026-10-27T06:30:00.000Z", outcome: "ran", tokens: 512, summary: "digest sent" }],
  };

  test("accepts a JobInfo without routine", () => {
    const result = JobInfoSchema.safeParse(job);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.routine).toBeUndefined();
  });

  test("accepts a JobInfo with routine", () => {
    const result = JobInfoSchema.safeParse({ ...job, routine });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routine?.name).toBe("Morning digest");
      expect(result.data.routine?.recentRuns[0]?.outcome).toBe("ran");
    }
  });

  test("rejects a routine with a bad preflight", () => {
    expect(JobInfoSchema.safeParse({ ...job, routine: { ...routine, preflight: "ftp" } }).success).toBe(false);
  });

  test("rejects more than five recent runs", () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({ at: "2026-10-27T06:30:00.000Z", outcome: "ran", tokens: index }));
    expect(JobInfoSchema.safeParse({ ...job, routine: { ...routine, recentRuns: runs } }).success).toBe(false);
  });

  test("job.list.ok parses with routine present and absent", () => {
    expect(parseServerFrame({ type: "job.list.ok", seq: 1, jobs: [{ ...job, routine }, job] }).ok).toBe(true);
  });
});

describe("envelope helpers", () => {
  test("encode → decode → parse round trip", () => {
    const wire = encodeFrame({ type: "msg.cancel", turnID: "trn_1" });
    const decoded = decodeText(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const parsed = parseClientFrame(decoded.value);
      expect(parsed.ok).toBe(true);
    }
  });

  test("decodeText reports invalid JSON", () => {
    expect(decodeText("{oops").ok).toBe(false);
  });

  test("version guard", () => {
    expect(isSupportedVersion(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedVersion(PROTOCOL_VERSION - 1)).toBe(false);
  });
});
