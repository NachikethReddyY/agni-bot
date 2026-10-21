/**
 * One-time secret prompts.
 *
 * The model can ask for a password, but it never receives one. A request is
 * broadcast to the owner's clients, the owner types the value into a secure
 * field, and the server hands it to exactly one command. The value is:
 *   - never written to `messages`, `channel_messages`, `tool_calls`, or the
 *     frame log (only `secret.request` / `secret.cancel` are replayable);
 *   - never returned to the model (the tool result is command output only);
 *   - dropped after use or when the request expires/cancels.
 *
 * The broker is process-local on purpose: a daemon restart invalidates
 * outstanding prompts instead of leaving a secret in a durable store.
 */
import type { ServerFrameBody } from "@agni/protocol";
import { newID, nowISO } from "../util/ids";

export interface SecretRequestInfo {
  id: string;
  purpose: string;
  command: string;
  kind: "password" | "text";
  threadID: string | null;
  conversationID: string | null;
  createdAt: string;
  expiresAt: string;
}

interface PendingSecret {
  info: SecretRequestInfo;
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
  emit: (frame: ServerFrameBody) => void;
}

const pending = new Map<string, PendingSecret>();

/** Two minutes is enough to read the command and type a password. */
export const SECRET_TTL_MS = 120_000;

export interface SecretBrokerDeps {
  emit: (frame: ServerFrameBody) => void;
}

function settle(requestID: string, value: string | null, reason: string): boolean {
  const entry = pending.get(requestID);
  if (!entry) return false;
  pending.delete(requestID);
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  try {
    entry.emit({ type: "secret.cancel", requestID, reason });
  } catch {
    // A closed socket must not strand the waiting tool.
  }
  entry.resolve(value);
  return true;
}

export function requestSecret(
  deps: SecretBrokerDeps,
  input: {
    purpose: string;
    command: string;
    kind?: "password" | "text";
    threadID?: string | null;
    conversationID?: string | null;
    ttlMs?: number;
    signal?: AbortSignal;
  },
): Promise<string | null> {
  const ttlMs = Math.max(5_000, Math.min(input.ttlMs ?? SECRET_TTL_MS, 600_000));
  const info: SecretRequestInfo = {
    id: newID("sec"),
    purpose: input.purpose,
    command: input.command,
    kind: input.kind ?? "password",
    threadID: input.threadID ?? null,
    conversationID: input.conversationID ?? null,
    createdAt: nowISO(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };

  return new Promise<string | null>((resolve) => {
    if (input.signal?.aborted) {
      resolve(null);
      return;
    }
    const onAbort = (): void => {
      settle(info.id, null, "cancelled");
    };
    const timer = setTimeout(() => {
      settle(info.id, null, "expired");
    }, ttlMs);
    pending.set(info.id, { info, resolve, timer, onAbort, signal: input.signal, emit: deps.emit });
    if (input.signal) {
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    }
    deps.emit({
      type: "secret.request",
      requestID: info.id,
      purpose: info.purpose,
      command: info.command,
      kind: info.kind,
      expiresAt: info.expiresAt,
      ...(info.threadID ? { threadID: info.threadID } : {}),
      ...(info.conversationID ? { conversationID: info.conversationID } : {}),
    });
  });
}

/** Consume a secret. Returns false when the request is unknown or expired. */
export function resolveSecret(requestID: string, value: string): boolean {
  return settle(requestID, value, "resolved");
}

export function cancelSecret(requestID: string, reason = "cancelled"): boolean {
  return settle(requestID, null, reason);
}

/** Pending requests are metadata only — safe to resend on reconnect. */
export function listPendingSecrets(): SecretRequestInfo[] {
  return [...pending.values()].map((entry) => ({ ...entry.info }));
}

/** Test hook: drop everything without emitting. */
export function resetSecretBroker(): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  }
  pending.clear();
}
