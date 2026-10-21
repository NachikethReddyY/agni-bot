import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelSecret,
  listPendingSecrets,
  requestSecret,
  resetSecretBroker,
  resolveSecret,
} from "../src/agent/secret-broker";
import { runBash } from "../src/tools/bash";
import { ToolRegistry } from "../src/tools/registry";
import { registerSecureExecTool } from "../src/tools/secure-exec-tool";

afterEach(() => resetSecretBroker());

describe("secret broker", () => {
  test("broadcasts metadata, never the value, and consumes it once", async () => {
    const frames: Array<{ type: string; [key: string]: unknown }> = [];
    const pending = requestSecret(
      { emit: (frame) => frames.push(frame as { type: string; [key: string]: unknown }) },
      { purpose: "install orbstack", command: "sudo installer -pkg OrbStack.pkg -target /", threadID: "thr_1" },
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "secret.request",
      purpose: "install orbstack",
      command: "sudo installer -pkg OrbStack.pkg -target /",
      kind: "password",
      threadID: "thr_1",
    });
    expect(frames[0]).not.toHaveProperty("value");
    expect(listPendingSecrets()).toHaveLength(1);

    expect(resolveSecret(String(frames[0]?.requestID), "hunter2")).toBe(true);
    await expect(pending).resolves.toBe("hunter2");
    expect(listPendingSecrets()).toHaveLength(0);
    expect(frames.at(-1)).toMatchObject({ type: "secret.cancel", reason: "resolved" });
    expect(resolveSecret(String(frames[0]?.requestID), "again")).toBe(false);
  });

  test("aborting the turn cancels the prompt", async () => {
    const frames: Array<{ type: string; [key: string]: unknown }> = [];
    const controller = new AbortController();
    const pending = requestSecret(
      { emit: (frame) => frames.push(frame as { type: string; [key: string]: unknown }) },
      { purpose: "ssh", command: "ssh host", signal: controller.signal },
    );
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(frames.at(-1)).toMatchObject({ type: "secret.cancel", reason: "cancelled" });
    expect(listPendingSecrets()).toHaveLength(0);
  });

  test("owner cancellation resolves null", async () => {
    const frames: Array<{ type: string; [key: string]: unknown }> = [];
    const pending = requestSecret(
      { emit: (frame) => frames.push(frame as { type: string; [key: string]: unknown }) },
      { purpose: "sudo", command: "sudo true" },
    );
    expect(cancelSecret(String(frames[0]?.requestID), "cancelled by owner")).toBe(true);
    await expect(pending).resolves.toBeNull();
  });
});

describe("secret injection", () => {
  test("passes the secret on stdin and redacts it from output", async () => {
    const result = await runBash({ command: "cat", secret: "s3cret-value" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[redacted]");
    expect(result.stderr).toBe("");
  });

  test("askpass helper can read the secret without putting it in argv", async () => {
    const result = await runBash({ command: '"$SUDO_ASKPASS"', secret: "askpass-value" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[redacted]");
  });

  test("a command that never reads stdin still runs", async () => {
    const result = await runBash({ command: "printf ok", secret: "unused" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test("run_privileged never returns the secret to the model", async () => {
    const registry = new ToolRegistry();
    const frames: Array<{ type: string; [key: string]: unknown }> = [];
    registerSecureExecTool(registry, {
      emit: (frame) => frames.push(frame as { type: string; [key: string]: unknown }),
      threadID: "thr_test",
    });
    const tool = registry.get("run_privileged");
    expect(tool).toBeDefined();
    const run = tool!.handler as unknown as (
      args: Record<string, unknown>,
      ctx: { threadID: string; turnID: string; signal: AbortSignal },
    ) => Promise<{ stdout: string; secretUsed: boolean }>;
    const pending = run(
      { command: "cat", purpose: "prove the secret stays out of the result" },
      { threadID: "thr_test", turnID: "trn_test", signal: new AbortController().signal },
    );
    const request = frames.find((frame) => frame.type === "secret.request");
    expect(request).toBeDefined();
    expect(resolveSecret(String(request?.requestID), "top-secret-value")).toBe(true);
    const result = await pending;
    expect(result.stdout).toBe("[redacted]");
    expect(result.secretUsed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("top-secret-value");
  });

  test("run_privileged refuses when the owner cancels", async () => {
    const registry = new ToolRegistry();
    const frames: Array<{ type: string; [key: string]: unknown }> = [];
    registerSecureExecTool(registry, {
      emit: (frame) => frames.push(frame as { type: string; [key: string]: unknown }),
      threadID: "thr_test",
    });
    const tool = registry.get("run_privileged");
    const run = tool!.handler as unknown as (
      args: Record<string, unknown>,
      ctx: { threadID: string; turnID: string; signal: AbortSignal },
    ) => Promise<unknown>;
    const pending = run(
      { command: "cat", purpose: "cancel this" },
      { threadID: "thr_test", turnID: "trn_test", signal: new AbortController().signal },
    );
    const request = frames.find((frame) => frame.type === "secret.request");
    cancelSecret(String(request?.requestID), "cancelled by owner");
    await expect(pending).rejects.toThrow("did not provide");
  });
});
