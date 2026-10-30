/**
 * The connection loop against a scripted socket. No network, no clock
 * dependency beyond the loop's injected timings.
 */
import { describe, expect, test } from "vitest";
import type { ClientFrame } from "@agni/protocol";
import {
  AgniConnection,
  PROTOCOL_VERSION,
  TransportError,
  type ConnectionEvent,
  type ConnectionState,
  type FrameTransport,
  type ServerSettings,
} from "../src";

type Scripted = { text: string } | { error: TransportError };

class FakeTransport implements FrameTransport {
  private queue: Scripted[];
  readonly sent: string[] = [];
  closed = false;
  openCount = 0;

  constructor(script: Scripted[] = []) {
    this.queue = [...script];
  }

  async open(): Promise<void> {
    this.openCount += 1;
    this.closed = false;
  }

  async send(text: string): Promise<void> {
    this.sent.push(text);
  }

  async receive(): Promise<string> {
    for (let spin = 0; spin < 2000; spin += 1) {
      if (this.closed) throw TransportError.closed(1000, "client closed");
      const next = this.queue.shift();
      if (next) {
        if ("text" in next) return next.text;
        throw next.error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw TransportError.failed("fake transport ran out of frames");
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  decodedSent(): ClientFrame[] {
    return this.sent.map((text) => JSON.parse(text) as ClientFrame);
  }
}

function settings(lastSeq = 0): ServerSettings {
  return { url: "ws://127.0.0.1:8787/ws", deviceName: "Test Mac", lastSeq };
}

async function settle(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

function ready(state: ConnectionState): boolean {
  return state.kind === "ready";
}

describe("connection", () => {
  test("handshake then resync from the stored seq", async () => {
    const transport = new FakeTransport([
      {
        text: JSON.stringify({
          type: "hello.ok",
          seq: 7,
          v: 1,
          serverTime: "2026-10-16T12:00:00.000Z",
          lastSeq: 7,
        }),
      },
      { text: JSON.stringify({ type: "presence", seq: 8, state: "online" }) },
    ]);

    const states: ConnectionState[] = [];
    const frames: ConnectionEvent[] = [];
    const connection = new AgniConnection({
      settings: settings(3),
      token: "agni_test",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    connection.onEvent = (event) => {
      if (event.type === "state") states.push(event.state);
      if (event.type === "frame") frames.push(event);
    };
    connection.start();

    expect(await settle(() => ready(connection.state))).toBe(true);
    expect(await settle(() => frames.some((event) => event.type === "frame" && event.frame.type === "presence"))).toBe(
      true,
    );
    connection.stop();

    const sent = transport.decodedSent();
    expect(sent[0]).toEqual({
      type: "hello",
      v: PROTOCOL_VERSION,
      token: "agni_test",
      device: "Test Mac",
    });
    // resync asks for everything after the persisted seq, not from zero.
    expect(sent).toContainEqual({ type: "resync", lastSeq: 3 });
    expect(states.some(ready)).toBe(true);
  });

  test("lastSeq advances with the stream and is reported", async () => {
    const transport = new FakeTransport([
      { text: JSON.stringify({ type: "hello.ok", seq: 1, v: 1, serverTime: "now", lastSeq: 1 }) },
      { text: JSON.stringify({ type: "token", seq: 2, turnID: "trn_1", threadID: "thr_1", delta: "hi" }) },
      { text: JSON.stringify({ type: "turn.end", seq: 3, turnID: "trn_1", threadID: "thr_1", stopReason: "end" }) },
    ]);

    const observed: number[] = [];
    const connection = new AgniConnection({
      settings: settings(),
      token: "t",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    connection.onEvent = (event) => {
      if (event.type === "lastSeq") observed.push(event.seq);
    };
    connection.start();
    expect(await settle(() => observed.includes(3))).toBe(true);
    connection.stop();
    expect(connection.lastSeq).toBe(3);
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
  });

  test("a frame at or below the applied seq is dropped; errors still pass", async () => {
    const transport = new FakeTransport([
      { text: JSON.stringify({ type: "hello.ok", seq: 5, v: 1, serverTime: "now", lastSeq: 5 }) },
      { text: JSON.stringify({ type: "token", seq: 6, turnID: "t", threadID: "h", delta: "a" }) },
      { text: JSON.stringify({ type: "token", seq: 6, turnID: "t", threadID: "h", delta: "a" }) },
      { text: JSON.stringify({ type: "token", seq: 4, turnID: "t", threadID: "h", delta: "old" }) },
      { text: JSON.stringify({ type: "error", seq: 6, code: "bad_frame", message: "nope" }) },
    ]);
    const seen: string[] = [];
    const connection = new AgniConnection({
      settings: settings(),
      token: "t",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    connection.onEvent = (event) => {
      if (event.type === "frame") seen.push(event.frame.type);
    };
    connection.start();
    expect(await settle(() => seen.includes("error"))).toBe(true);
    connection.stop();
    expect(seen).toEqual(["token", "error"]);
  });

  test("hello.ok with a lower lastSeq resets the stored seq and reloads", async () => {
    const transport = new FakeTransport([
      { text: JSON.stringify({ type: "hello.ok", seq: 2, v: 1, serverTime: "now", lastSeq: 2 }) },
    ]);
    const events: ConnectionEvent[] = [];
    const connection = new AgniConnection({
      settings: settings(50),
      token: "t",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    connection.onEvent = (event) => events.push(event);
    connection.start();
    expect(await settle(() => ready(connection.state))).toBe(true);
    connection.stop();
    expect(connection.lastSeq).toBe(2);
    expect(events.some((e) => e.type === "durableReloadRequired")).toBe(true);
    expect(transport.decodedSent()).toContainEqual({ type: "resync", lastSeq: 2 });
  });

  test("a revoked token stops retrying", async () => {
    const transport = new FakeTransport([
      {
        text: JSON.stringify({
          type: "error",
          seq: 1,
          code: "unauthorized",
          message: "unknown or revoked token — pair a device first",
        }),
      },
    ]);
    const connection = new AgniConnection({
      settings: settings(),
      token: "bad",
      makeTransport: () => transport,
      handshakeTimeoutMs: 2000,
    });
    connection.start();
    expect(await settle(() => connection.state.kind === "refused", 4000)).toBe(true);
    if (connection.state.kind === "refused") {
      expect(connection.state.reason).toMatch(/revoked|unknown/);
    } else {
      throw new Error(`expected a refusal, got ${connection.state.kind}`);
    }
    connection.stop();
  });

  test("resync gap asks for durable state", async () => {
    const transport = new FakeTransport([
      { text: JSON.stringify({ type: "hello.ok", seq: 9, v: 1, serverTime: "now", lastSeq: 9 }) },
      { text: JSON.stringify({ type: "error", seq: 10, code: "resync_gap", message: "cannot replay from 1" }) },
    ]);
    let reloads = 0;
    const connection = new AgniConnection({
      settings: settings(),
      token: "t",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    connection.onEvent = (event) => {
      if (event.type === "durableReloadRequired") reloads += 1;
    };
    connection.start();
    expect(await settle(() => reloads === 1)).toBe(true);
    connection.stop();
  });

  test("unknown frames are ignored and bad ones are reported", async () => {
    const transport = new FakeTransport([
      { text: JSON.stringify({ type: "hello.ok", seq: 1, v: 1, serverTime: "now", lastSeq: 1 }) },
      { text: JSON.stringify({ type: "chart.render", seq: 2, chart: "burn" }) },
      { text: JSON.stringify({ type: "token", seq: 3, delta: "missing ids" }) },
      { text: JSON.stringify({ type: "presence", seq: 4, state: "online" }) },
    ]);
    const malformed: string[] = [];
    const types: string[] = [];
    const connection = new AgniConnection({
      settings: settings(),
      token: "t",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    connection.onEvent = (event) => {
      if (event.type === "malformed") malformed.push(event.detail);
      if (event.type === "frame") types.push(event.frame.type);
    };
    connection.start();
    expect(await settle(() => types.includes("presence"))).toBe(true);
    connection.stop();
    expect(types).toContain("chart.render");
    expect(malformed.length).toBe(1);
    expect(malformed[0]).toContain("token");
  });

  test("send before ready fails instead of dropping the message", async () => {
    const transport = new FakeTransport();
    const connection = new AgniConnection({
      settings: settings(),
      token: "t",
      makeTransport: () => transport,
      handshakeTimeoutMs: 5000,
    });
    await expect(
      connection.send({
        type: "msg.send",
        text: "hello",
      }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
