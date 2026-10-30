/**
 * Protocol conformance client for tests and scripts: connect, hello, ask,
 * stream. The app (P1) reuses the same protocol package; this file is
 * deliberately boring.
 */
import {
  PROTOCOL_VERSION,
  decodeText,
  encodeFrame,
  parseServerFrame,
  type ClientFrame,
  type MessageInfo,
  type ServerFrame,
  type ThreadInfo,
  type Usage,
} from "@agni/protocol";

export class AgniError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgniError";
    this.code = code;
  }
}

export interface AskOptions {
  text: string;
  /** Empty/omitted asks the server to create a new thread. */
  threadID?: string;
  onDelta?: (delta: string) => void;
  timeoutMs?: number;
}

export interface AskStats {
  turnID: string;
  threadID: string;
  text: string;
  /** -1 when the turn produced no content tokens. */
  firstTokenMs: number;
  totalMs: number;
  stopReason: string;
  usage?: Usage;
  error?: { code: string; message: string };
}

export class AgniSocket {
  private readonly frameHandlers = new Set<(frame: ServerFrame) => void>();
  private readonly closeHandlers = new Set<(code: number, reason: string) => void>();
  private lastSeqValue = 0;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const decoded = decodeText(event.data);
      if (!decoded.ok) return;
      const parsed = parseServerFrame(decoded.value);
      if (!parsed.ok) return;
      if (parsed.frame.seq > this.lastSeqValue) this.lastSeqValue = parsed.frame.seq;
      for (const handler of [...this.frameHandlers]) handler(parsed.frame);
    });
    ws.addEventListener("close", (event) => {
      for (const handler of [...this.closeHandlers]) handler(event.code, event.reason);
    });
  }

  static async connect(url: string, token: string, device: string, handshakeTimeoutMs = 5000): Promise<AgniSocket> {
    const ws = new WebSocket(url);
    const socket = new AgniSocket(ws);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`websocket open timeout: ${url}`)), handshakeTimeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`cannot connect to ${url}`));
        },
        { once: true },
      );
    });

    const handshake = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("hello handshake timeout"));
      }, handshakeTimeoutMs);
      const unsubscribe = socket.onFrame((frame) => {
        if (frame.type === "hello.ok") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        } else if (frame.type === "error") {
          clearTimeout(timer);
          unsubscribe();
          reject(new AgniError(frame.code, frame.message));
        }
      });
    });
    socket.send({ type: "hello", v: PROTOCOL_VERSION, token, device });
    await handshake;
    return socket;
  }

  send(frame: ClientFrame): void {
    this.ws.send(encodeFrame(frame));
  }

  /** Highest seq received on this connection — what `resync` replays after. */
  get lastSeq(): number {
    return this.lastSeqValue;
  }

  /** True once the socket is no longer open. */
  get closed(): boolean {
    return this.ws.readyState !== WebSocket.OPEN;
  }

  /** Ask the server to replay frames after `lastSeq` (used after reconnect). */
  resync(lastSeq: number): void {
    this.send({ type: "resync", lastSeq });
  }

  onFrame(handler: (frame: ServerFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onClose(handler: (code: number, reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.ws.close();
  }

  /** Most recently touched threads, newest first. */
  async threadList(limit = 20, timeoutMs = 5000): Promise<ThreadInfo[]> {
    const pending = this.once("thread.list.ok", timeoutMs);
    this.send({ type: "thread.list", limit });
    return (await pending).threads;
  }

  /** Durable message history for one thread (last `limit`, chronological). */
  async threadHistory(
    threadID: string,
    limit = 50,
    timeoutMs = 5000,
  ): Promise<{ threadID: string; title?: string; messages: MessageInfo[] }> {
    const pending = this.once("thread.history.ok", timeoutMs, (frame) => frame.threadID === threadID);
    this.send({ type: "thread.history", threadID, limit });
    return await pending;
  }

  /** Resolve (or create) an agent's one conversation; answers its active block. */
  async conversationOpen(
    conversationID: string,
    agentID?: string,
    timeoutMs = 5000,
  ): Promise<Extract<ServerFrame, { type: "conversation.ok" }>> {
    const pending = this.once("conversation.ok", timeoutMs);
    this.send(agentID ? { type: "conversation.open", conversationID, agentID } : { type: "conversation.open", conversationID });
    return await pending;
  }

  /** Cut a fresh session block into the conversation (the `/new` seam). */
  async sessionNew(conversationID: string, timeoutMs = 5000): Promise<void> {
    // The seam itself arrives as `session.start` on the stream, not as a reply.
    this.send({ type: "session.new", conversationID });
    await Bun.sleep(50);
  }

  /** The conversation transcript across session blocks (seams readable via sessionID). */
  async conversationHistory(
    conversationID: string,
    limit = 50,
    timeoutMs = 5000,
  ): Promise<{ conversationID: string; messages: MessageInfo[] }> {
    const pending = this.once("conversation.history.ok", timeoutMs);
    this.send({ type: "conversation.history", conversationID, limit });
    return await pending;
  }

  private once<T extends ServerFrame["type"]>(
    type: T,
    timeoutMs: number,
    match?: (frame: Extract<ServerFrame, { type: T }>) => boolean,
  ): Promise<Extract<ServerFrame, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${type}`));
      }, timeoutMs);
      const unsubscribe = this.onFrame((frame) => {
        if (frame.type !== type) return;
        const typed = frame as Extract<ServerFrame, { type: T }>;
        if (match && !match(typed)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(typed);
      });
    });
  }

  /** Send one message and wait for its turn to complete. */
  ask(options: AskOptions): Promise<AskStats> {
    const timeoutMs = options.timeoutMs ?? 45_000;
    const startedAt = performance.now();
    const chunks: string[] = [];
    let turnID = "";
    let threadID = options.threadID ?? "";
    let firstTokenMs = -1;

    return new Promise<AskStats>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        unsubscribeFrame();
        unsubscribeClose();
        clearTimeout(timer);
        callback();
      };
      const stats = (stopReason: string, usage?: Usage, error?: { code: string; message: string }): AskStats => ({
        turnID,
        threadID,
        text: chunks.join(""),
        firstTokenMs,
        totalMs: Math.round(performance.now() - startedAt),
        stopReason,
        usage,
        error,
      });

      const unsubscribeFrame = this.onFrame((frame) => {
        switch (frame.type) {
          case "turn.start":
            turnID = frame.turnID;
            threadID = frame.threadID;
            break;
          case "token":
            if (firstTokenMs < 0) firstTokenMs = Math.round(performance.now() - startedAt);
            chunks.push(frame.delta);
            options.onDelta?.(frame.delta);
            break;
          case "turn.end":
            finish(() => resolve(stats(frame.stopReason, frame.usage)));
            break;
          case "error":
            // Errors before turn.start (unknown thread, auth, bad frame) end
            // the request immediately; later errors ride along with turn.end.
            if (!turnID) {
              finish(() => resolve(stats("error", undefined, { code: frame.code, message: frame.message })));
            }
            break;
          default:
            break;
        }
      });
      const unsubscribeClose = this.onClose((code, reason) => {
        finish(() => reject(new Error(`connection closed mid-turn (${code} ${reason})`)));
      });
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`turn timeout after ${timeoutMs}ms`)));
      }, timeoutMs);

      this.send({ type: "msg.send", threadID: options.threadID ?? "", text: options.text });
    });
  }
}

export function healthURL(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}
