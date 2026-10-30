/**
 * The connection loop: connect → hello → resync → stream, forever, with
 * backoff. One socket, one job.
 *
 * Two behaviours the P1 proof depends on:
 *   - Every connect sends `resync {lastSeq}`, and `lastSeq` survives reload.
 *     Kill the app mid-turn, reopen it, and the turn's frames replay into the
 *     reopened transcript.
 *   - `resync_gap` means the server cannot replay that far back, so we ask for
 *     durable state instead (conversation history) — messages live in SQLite,
 *     replay is only a latency shortcut.
 */
import type { ClientFrame } from "@agni/protocol";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { decodeServerFrame, encodeClientFrame, frameSeq, type IncomingFrame } from "./protocol";
import type { ServerSettings } from "./settings";
import { websocketURL } from "./settings";
import { TransportError, WebSocketTransport, type FrameTransport } from "./transport";

export type ConnectionState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "handshaking" }
  | { kind: "ready"; lastSeq: number }
  /** Transient: the loop is waiting to try again. `reason` is user-facing. */
  | { kind: "waiting"; attempt: number; seconds: number; reason: string }
  /** Fatal for this configuration: retrying will not help until it changes. */
  | { kind: "refused"; reason: string }
  | { kind: "stopped" };

export function isReady(state: ConnectionState): state is { kind: "ready"; lastSeq: number } {
  return state.kind === "ready";
}

export function isBusy(state: ConnectionState): boolean {
  return state.kind === "connecting" || state.kind === "handshaking" || state.kind === "waiting";
}

export type ConnectionEvent =
  | { type: "state"; state: ConnectionState }
  | { type: "frame"; frame: IncomingFrame }
  /** A frame the server sent that this build could not parse. */
  | { type: "malformed"; detail: string }
  /** `resync` could not be replayed: reload durable state. */
  | { type: "durableReloadRequired" }
  /** lastSeq moved; persist it so a reload can resume. */
  | { type: "lastSeq"; seq: number };

export interface ConnectionOptions {
  settings: ServerSettings;
  token: string;
  makeTransport?: () => FrameTransport;
  handshakeTimeoutMs?: number;
  maxBackoffSeconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const STABLE_MS = 10_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameState(a: ConnectionState, b: ConnectionState): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "ready":
      return b.kind === "ready" && a.lastSeq === b.lastSeq;
    case "waiting":
      return b.kind === "waiting" && a.attempt === b.attempt && a.seconds === b.seconds && a.reason === b.reason;
    case "refused":
      return b.kind === "refused" && a.reason === b.reason;
    default:
      return true;
  }
}

export class AgniConnection {
  private stateValue: ConnectionState = { kind: "idle" };
  private readonly makeTransport: () => FrameTransport;
  private readonly handshakeTimeoutMs: number;
  private readonly maxBackoffSeconds: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private transport: FrameTransport | null = null;
  private loop: Promise<void> | null = null;
  private runID = 0;
  private abort: AbortController | null = null;
  private settings: ServerSettings;
  private token: string;
  private onEventValue: ((event: ConnectionEvent) => void) | null = null;
  private readyAt: number | null = null;

  constructor(options: ConnectionOptions) {
    this.settings = { ...options.settings };
    this.token = options.token;
    this.makeTransport = options.makeTransport ?? (() => new WebSocketTransport());
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 12_000;
    this.maxBackoffSeconds = options.maxBackoffSeconds ?? 15;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get state(): ConnectionState {
    return this.stateValue;
  }

  get onEvent(): ((event: ConnectionEvent) => void) | null {
    return this.onEventValue;
  }

  set onEvent(handler: ((event: ConnectionEvent) => void) | null) {
    this.onEventValue = handler;
  }

  get lastSeq(): number {
    return this.settings.lastSeq;
  }

  private setState(next: ConnectionState): void {
    if (sameState(this.stateValue, next)) return;
    this.stateValue = next;
    this.onEventValue?.({ type: "state", state: next });
  }

  update(settings: ServerSettings, token: string): void {
    this.stop();
    this.settings = { ...settings };
    this.token = token;
  }

  start(): void {
    if (this.loop) return;
    this.runID += 1;
    const id = this.runID;
    this.abort = new AbortController();
    this.loop = this.run(id).finally(() => {
      if (id === this.runID) this.loop = null;
    });
  }

  stop(): void {
    this.runID += 1;
    this.abort?.abort();
    this.abort = null;
    const socket = this.transport;
    this.transport = null;
    this.loop = null;
    this.setState({ kind: "stopped" });
    if (socket) void socket.close();
  }

  /** Try now instead of waiting out the backoff. */
  retryNow(): void {
    if (this.stateValue.kind !== "waiting") return;
    this.stop();
    this.start();
  }

  async send(frame: ClientFrame): Promise<void> {
    const transport = this.transport;
    if (!transport || !isReady(this.stateValue)) throw TransportError.notOpen();
    await transport.send(encodeClientFrame(frame));
  }

  // MARK: loop

  private aborted(id: number): boolean {
    return id !== this.runID || this.abort?.signal.aborted === true;
  }

  private async run(id: number): Promise<void> {
    let attempt = 0;
    while (!this.aborted(id)) {
      let reason: string;
      try {
        const startedAt = Date.now();
        reason = await this.session(id);
        // Only a connection that stayed up resets the backoff (M58).
        if (this.readyAt !== null && Date.now() - Math.max(startedAt, this.readyAt) >= STABLE_MS) attempt = 0;
        if (this.aborted(id)) break;
      } catch (error) {
        if (this.aborted(id) || error instanceof AbortError) break;
        if (this.readyAt !== null && Date.now() - this.readyAt >= STABLE_MS) attempt = 0;
        if (error instanceof TransportError && error.kind === "closed" && (error.code === 4002 || error.code === 4003)) {
          this.setState({
            kind: "refused",
            reason: error.reason.length > 0 ? error.reason : refusalFor(error.code),
          });
          return;
        }
        reason = error instanceof Error ? error.message : String(error);
      }

      if (this.aborted(id)) break;
      attempt += 1;
      const base = Math.min(this.maxBackoffSeconds, 0.5 * 2 ** (attempt - 1));
      const seconds = base * (0.8 + Math.random() * 0.4); // ±20% jitter
      this.setState({ kind: "waiting", attempt, seconds, reason });
      await this.sleep(seconds * 1000);
    }
    if (this.stateValue.kind === "refused") return;
    if (!this.aborted(id)) this.setState({ kind: "stopped" });
  }

  private async session(id: number): Promise<string> {
    this.setState({ kind: "connecting" });
    const url = websocketURL(this.settings);
    if (!url) {
      this.setState({ kind: "refused", reason: "That server address is not a websocket URL." });
      throw new AbortError();
    }

    const socket = this.makeTransport();
    this.transport = socket;
    this.readyAt = null;
    try {
      await socket.open(url);
      if (this.aborted(id)) return "stopped";
      this.setState({ kind: "handshaking" });
      await socket.send(
        encodeClientFrame({
          type: "hello",
          v: PROTOCOL_VERSION,
          token: this.token,
          device: this.settings.deviceName,
        }),
      );

      let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        void socket.close();
      }, this.handshakeTimeoutMs);
      const clearWatchdog = () => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = null;
      };

      try {
        let greeted = false;
        while (!this.aborted(id)) {
          let text: string;
          try {
            text = await socket.receive();
          } catch (error) {
            if (!(error instanceof TransportError)) throw error;
            if (!greeted) {
              if (error.kind === "closed" && (error.code === 4002 || error.code === 4003)) throw error;
              throw TransportError.failed(greetingFailure(error));
            }
            return error.message;
          }

          const decoded = decodeServerFrame(text);
          if (!decoded.ok) {
            this.onEventValue?.({ type: "malformed", detail: decoded.error });
            continue;
          }
          const frame = decoded.frame;
          const isError = frame.type === "error" && !("__unknown" in frame);

          if (!greeted) {
            if (frame.type === "hello.ok" && !("__unknown" in frame)) {
              greeted = true;
              clearWatchdog();
              this.readyAt = Date.now();
              if (frame.lastSeq < this.settings.lastSeq) {
                // Server restarted behind us (M3): our seq is meaningless now.
                this.settings.lastSeq = frame.lastSeq;
                this.onEventValue?.({ type: "lastSeq", seq: frame.lastSeq });
                this.onEventValue?.({ type: "durableReloadRequired" });
              }
              const resumeAfterSeq = this.settings.lastSeq;
              this.setState({ kind: "ready", lastSeq: frame.lastSeq });
              // Re-enter the stream where this browser left off.
              try {
                await socket.send(encodeClientFrame({ type: "resync", lastSeq: resumeAfterSeq }));
              } catch {
                // The receive loop will report a closed socket next iteration.
              }
            } else if (frame.type === "error" && !("__unknown" in frame)) {
              // The server rejects before hello.ok: unauthorized, version_mismatch.
              throw TransportError.closed(frame.code === "version_mismatch" ? 4002 : 4003, frame.message);
            } else {
              // Presence and other broadcasts can arrive before hello.ok; keep them
              // but do not advance lastSeq: resync replays them.
              this.onEventValue?.({ type: "frame", frame });
            }
            continue;
          }

          // Replayed/live overlap (H32). Errors reuse the current seq and bypass.
          const seq = frameSeq(frame);
          if (!isError && seq > 0 && seq <= this.settings.lastSeq) continue;
          this.observe(seq);

          if (frame.type === "error" && !("__unknown" in frame) && frame.code === "resync_gap") {
            this.onEventValue?.({ type: "durableReloadRequired" });
          }
          this.onEventValue?.({ type: "frame", frame });
        }
        return "connection ended";
      } finally {
        clearWatchdog();
      }
    } finally {
      this.transport = null;
      void socket.close();
    }
  }

  private observe(seq: number): void {
    if (!(seq > this.settings.lastSeq)) return;
    this.settings.lastSeq = seq;
    this.onEventValue?.({ type: "lastSeq", seq });
  }
}

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

function refusalFor(closeCode: number): string {
  switch (closeCode) {
    case 4002:
      return "Server speaks a different protocol version. Update the app or the server.";
    case 4003:
      return "This device token was revoked or is unknown. Pair again with bun run pair.";
    default:
      return `Connection refused by the server (${closeCode}).`;
  }
}

function greetingFailure(error: TransportError): string {
  if (error.kind === "closed" && error.code === 4001) {
    return "The server dropped the handshake (4001 hello timeout).";
  }
  if (error.kind === "closed" && error.reason.length > 0) return error.reason;
  return `No answer from ${error.message} — is the daemon running, and is this the right address?`;
}
