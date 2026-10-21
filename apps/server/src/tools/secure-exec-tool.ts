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
import {
  runPrivilegedWithOSAuth,
  resolveAuthMode,
  type AuthMode,
} from "./privileged-os";

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
      "Run a shell command that needs the owner's password or administrator rights — sudo, ssh, ssh-add, git over HTTPS, keychain unlocks. " +
      "The owner reviews the exact command and authorizes it themselves; you never see the secret. " +
      "Put the whole command in `command` and a one-line reason in `purpose`. " +
      "Never put a password or token in the command itself. Use the plain `bash` tool for commands that do not need authorization. " +
      "On a Mac, `auth: \"os\"` asks macOS for the password or Touch ID instead of showing a prompt; use it for machine-level commands (sudo) and leave the rest to the one-time prompt.",
    kind: "static",
    schema: objectSchema({
      command: { type: "string", minLength: 1, maxLength: 2_000 },
      purpose: { type: "string", minLength: 1, maxLength: 200 },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: 120_000 },
      auth: {
        type: "string",
        enum: ["auto", "password", "os"],
        description: "auto (default): the OS dialog for machine-level commands, the one-time prompt for the rest. os: always the macOS authorization. password: always the one-time prompt.",
      },
    }, ["command", "purpose"]),
    timeoutMs: 180_000,
    handler: async (args, ctx) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const command = String(input.command ?? "").trim();
      const purpose = String(input.purpose ?? "").trim();
      if (!command) throw new Error("command is required");
      if (!purpose) throw new Error("purpose is required");
      const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : undefined;
      const mode = resolveAuthMode(input.auth as AuthMode | undefined, command);

      if (mode === "os") {
        // The operating system asks; the model never sees a secret and
        // nothing is written to the transcript.
        const result = await runPrivilegedWithOSAuth(command, { ...(timeoutMs ? { timeoutMs } : {}) });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          authorizedBy: "os",
          purpose,
        };
      }

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
          ...(timeoutMs ? { timeoutMs } : {}),
          secret,
        });
        return { ...result, secretUsed: true, authorizedBy: "prompt" };
      } finally {
        // The string cannot be zeroed in JS; dropping the reference is the
        // best we can do. The temp file was already wiped by runBash.
        void secret;
      }
    },
  });
}
