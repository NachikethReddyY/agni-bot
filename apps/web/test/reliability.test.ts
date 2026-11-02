import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";

const health: HealthReport = {
  ok: true,
  v: 2,
  serverTime: new Date().toISOString(),
  uptimeMs: 1,
  seq: 1,
  providers: [],
  usageToday: { turns: 0, inputTokens: 0, outputTokens: 0 },
};

type Internals = {
  handleFrame: (value: unknown) => void;
  connection: { send: (frame: unknown) => Promise<void> } | null;
  connectionState: unknown;
  flushUnsent: () => void;
};

function makeModel(): AppModel {
  SecretStore.save("test-token");
  const idle: FrameTransport = {
    open: () => new Promise<void>(() => undefined),
    send: async () => undefined,
    receive: () => new Promise<string>(() => undefined),
    close: async () => undefined,
  };
  return new AppModel({
    makeTransport: () => idle,
    healthFetch: async () => health,
    notifier: silentNotifications,
    healthPollMs: 0,
  });
}

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});
afterEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});

describe("approvals while disconnected", () => {
  it("stays pending when send throws, resolves after a resend succeeds", async () => {
    const model = makeModel();
    const inner = model as unknown as Internals;
    inner.handleFrame({
      type: "approval.request", seq: 1, requestID: "req_1", action: "run ls", preview: "ls",
      buttons: ["once", "reject"],
    });
    const approval = model.getSnapshot().conversation.approvals[0]!;
    inner.connectionState = { kind: "ready", lastSeq: 1 };
    let fail = true;
    const sent: unknown[] = [];
    inner.connection = {
      send: async (frame) => {
        if (fail) throw new Error("closed");
        sent.push(frame);
      },
    };

    model.answer(approval, "once");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.getSnapshot().conversation.approvals[0]!.decision).toBeNull();

    fail = false;
    inner.flushUnsent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([{ type: "approve.reply", requestID: "req_1", decision: "once" }]);
    expect(model.getSnapshot().conversation.approvals[0]!.decision).toBe("once");
  });
});

describe("token batching", () => {
  it("applies N tokens in one snapshot update", async () => {
    const model = makeModel();
    const inner = model as unknown as Internals;
    inner.handleFrame({ type: "turn.start", seq: 1, turnID: "trn_1", threadID: "thr_1" });
    let updates = 0;
    model.subscribe(() => { updates += 1; });
    for (let i = 0; i < 20; i += 1) {
      inner.handleFrame({ type: "token", seq: 2 + i, turnID: "trn_1", threadID: "thr_1", delta: "a" });
    }
    expect(updates).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updates).toBe(1);
    const text = model.getSnapshot().conversation.messages.map((m) => m.text).join("");
    expect(text).toBe("a".repeat(20));
  });
});
