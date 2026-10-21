/**
 * `run_privileged` — run a command that needs the owner's password.
 *
 * The command is fixed before the prompt: the owner sees it, types the secret
 * into a secure field, and the server runs exactly that command once. The
 * model gets stdout/stderr only. It never sees the secret, and the secret is
 * never written to the transcript.
 */
import type { ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import { requestSecret } from "../agent/secret-broker";
import { runBash } from "./bash";

export interface SecureExecDeps {
  emit: (frame: ServerFrameBody) => void;
  threadID: string;
  conversationID?: string;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

export function registerSecureExecTool(registry: ToolRegistry, deps: SecureExecDeps): void {
  if (registry.get("run_privileged")) return;
  registry.register({
    name: "run_privileged",
    description:
      "Run a shell command that needs the owner's password — sudo, ssh, ssh-add, git over HTTPS, keychain unlocks. " +
      "The owner reviews the exact command and types the password into a secure prompt; you never see it. " +
      "Put the whole command in `command` and a one-line reason in `purpose`. " +
      "Never put a password or token in the command itself. Use the plain `bash` tool for commands that do not need a secret.",
    schema: objectSchema({
      command: { type: "string", minLength: 1, maxLength: 2_000 },
      purpose: { type: "string", minLength: 1, maxLength: 200 },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000 },
    }, ["command", "purpose"]),
    timeoutMs: 180_000,
    handler: async (args, ctx) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const command = String(input.command ?? "").trim();
      const purpose = String(input.purpose ?? "").trim();
      if (!command) throw new Error("command is required");
      if (!purpose) throw new Error("purpose is required");
      const secret = await requestSecret(
        { emit: deps.emit },
        {
          purpose,
          command,
          threadID: ctx.threadID,
          conversationID: deps.conversationID ?? null,
          signal: ctx.signal,
        },
      );
      if (secret === null) {
        throw new Error("The owner did not provide the password (cancelled, expired, or the turn was stopped).");
      }
      try {
        const result = await runBash({
          command,
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          secret,
        });
        return { ...result, secretUsed: true };
      } finally {
        // The string cannot be zeroed in JS; dropping the reference is the
        // best we can do. The temp file was already wiped by runBash.
        void secret;
      }
    },
  });
}
