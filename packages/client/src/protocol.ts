/**
 * Wire-protocol helpers on top of `@agni/protocol`.
 *
 * The zod schemas are the contract; this module adds the two behaviours the
 * Swift client had:
 *   - unknown frame *types* decode to a value the UI can ignore (the server may
 *     add frames);
 *   - a known frame with a malformed payload fails loudly instead of guessing.
 *
 * Nothing here redefines a field: wire names travel unchanged.
 */
import {
  PROTOCOL_VERSION,
  parseServerFrame,
  type ClientFrame,
  type ServerFrame,
  type Usage,
} from "@agni/protocol";

export {
  PROTOCOL_VERSION,
  parseClientFrame,
  parseServerFrame,
  encodeFrame,
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
  type ServerFrameBody,
  type Usage,
  type AgentInfo,
  type ThreadInfo,
  type MessageInfo,
  type AttachmentInfo,
  AttachmentInfoSchema,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type JobInfo,
  type MemoryItem,
  type TaskInfo,
  type PluginInfo,
  type ChatGPTConnection,
  type PluginCapability,
  type Decision,
  type StopReason,
} from "@agni/protocol";

/** A frame type this build does not know. Ignored, never fatal. */
export interface UnknownServerFrame {
  type: string;
  seq: number;
  __unknown: true;
}

export type IncomingFrame = ServerFrame | UnknownServerFrame;

const KNOWN_SERVER_TYPES = new Set<string>([
  "hello.ok",
  "token",
  "turn.start",
  "turn.end",
  "tool.start",
  "tool.update",
  "tool.end",
  "approval.request",
  "secret.request",
  "secret.cancel",
  "form.request",
  "notify",
  "agents.update",
  "thread.list.ok",
  "thread.history.ok",
  "conversation.ok",
  "session.start",
  "conversation.history.ok",
  "thread.export.ok",
  "job.list.ok",
  "task.list.ok",
  "memory.list.ok",
  "task.update.ok",
  "task.updated",
  "task.answer.ok",
  "bind.direct.ok",
  "provider.add.ok",
  "provider.models.ok",
  "provider.auth.started",
  "provider.auth.state",
  "plugin.list.ok",
  "plugin.connect.ok",
  "plugin.state",
  "appearance.list.ok",
  "appearance.updated",
  "presence",
  "agent.presence",
  "status.update",
  "msg.new",
  "agent.updated",
  "error",
]);

export type DecodeResult =
  | { ok: true; frame: IncomingFrame }
  | { ok: false; error: string };

export function isUnknownFrame(frame: IncomingFrame): frame is UnknownServerFrame {
  return "__unknown" in frame && frame.__unknown === true;
}

export function isKnownFrame(frame: IncomingFrame): frame is ServerFrame {
  return !isUnknownFrame(frame);
}

export function frameSeq(frame: IncomingFrame): number {
  return typeof frame.seq === "number" ? frame.seq : 0;
}

/**
 * Parse one server text frame. Unknown types survive; known malformed payloads
 * return an error so the connection can report it as a notice.
 */
export function decodeServerFrame(text: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "frame is not an object" };
  }
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== "string" || type.length === 0) {
    return { ok: false, error: "frame has no type" };
  }
  if (!KNOWN_SERVER_TYPES.has(type)) {
    const seq = (value as Record<string, unknown>).seq;
    return {
      ok: true,
      frame: { type, seq: typeof seq === "number" ? seq : 0, __unknown: true },
    };
  }
  const parsed = parseServerFrame(value);
  if (!parsed.ok) return { ok: false, error: `${type}: ${parsed.error}` };
  return { ok: true, frame: parsed.frame };
}

/** Encode a client frame exactly as the daemon expects it. */
export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

/** What a person sees under a reply, or null when the turn ended cleanly. */
export function stopReasonExplanation(reason: string): string | null {
  switch (reason) {
    case "end":
      return null;
    case "cancelled":
      return "Stopped";
    case "error":
      return "Failed";
    case "timeout":
      return "Timed out";
    case "budget":
      return "Out of budget";
    default:
      return reason;
  }
}

/** Button title for an approval decision. Sentence case, says what happens. */
export function decisionTitle(decision: string): string {
  switch (decision) {
    case "once":
      return "Allow once";
    case "always":
      return "Always allow";
    case "reject":
      return "Reject";
    default:
      return decision;
  }
}

export function isKnownDecision(decision: string): boolean {
  return decision === "once" || decision === "always" || decision === "reject";
}

/** `#f0b95a` from the server, with a neutral fallback. */
export function agentColorHex(color: string | undefined): string {
  return color && color.trim().length > 0 ? color : "#9A9AA0";
}

export function usageLatency(usage: Usage | undefined): string | null {
  return usage && typeof usage.latencyMs === "number" ? `${usage.latencyMs} ms` : null;
}
