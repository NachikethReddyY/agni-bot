import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import type { ProviderConfig } from "../src/models/providers";
import { Router } from "../src/models/router";
import { runTaskTurn } from "../src/agent/task-loop";
import { resetSecretBroker, resolveSecret } from "../src/agent/secret-broker";
import { resolveApprovalWaiter } from "../src/agent/approval-broker";
import type { ResolvedPersona } from "../src/agent/personas";
import { createThread } from "../src/stores/threads";

/**
 * End-to-end through the task lane: the model asks for a password, the owner
 * answers on the wire, the command runs, and the model only ever sees output.
 * A second test proves `say` produces its own progress bubble.
 */

const provider: ProviderConfig = {
  id: "test", label: "Test", baseUrl: "https://test.local/v1", apiKey: "test", model: "mock",
};

const persona: ResolvedPersona = {
  id: "agni", name: "Agni", color: "#f0b95a", role: "front desk",
  systemPromptTemplate: "Be helpful.", systemPrompt: "Be helpful.",
  tools: ["bash"],
};

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  resetSecretBroker();
});

function streamResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  }), { status: 200 });
}

function toolCall(name: string, args: unknown): Response {
  return streamResponse([{
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `call-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  }]);
}

function finalText(text: string): Response {
  return streamResponse([{ choices: [{ delta: { content: text } }] }]);
}

describe("secure input through the task lane", () => {
  test("run_privileged asks the owner, runs once, and returns only redacted output", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    let request = 0;
    const router = new Router([provider], new HealthTracker(), (async () => {
      request += 1;
      return request === 1
        ? toolCall("run_privileged", { command: "cat", purpose: "prove the secret stays out" })
        : finalText("Done.");
    }) as unknown as typeof fetch);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];

    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id,
      text: "Run the privileged command",
      persona,
      emit: (frame) => {
        const typed = frame as { type: string; [key: string]: unknown };
        emitted.push(typed);
        // run_privileged gates on an approval card before the secret prompt.
        if (typed.type === "approval.request") {
          db!.run("UPDATE approvals SET status = 'decided', decision = 'once', decided_at = ? WHERE id = ?", [new Date().toISOString(), String(typed.requestID)]);
          resolveApprovalWaiter(String(typed.requestID), "once");
        }
        if (typed.type === "secret.request") {
          expect(resolveSecret(String(typed.requestID), "top-secret-value")).toBe(true);
        }
      },
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Done.");
    const asked = emitted.find((frame) => frame.type === "secret.request");
    expect(asked).toMatchObject({
      purpose: "prove the secret stays out",
      command: "cat",
      kind: "password",
    });
    expect(JSON.stringify(asked)).not.toContain("top-secret-value");

    const row = db.query<{ result: string }, [string]>(
      "SELECT result FROM tool_calls WHERE turn_id = ?",
    ).get(result.turnID);
    expect(row?.result).toContain("[redacted]");
    expect(row?.result).not.toContain("top-secret-value");
    expect(emitted.some((frame) => frame.type === "secret.cancel")).toBe(true);
  });

  test("say posts a separate progress message while the turn continues", async () => {
    db = openDatabase(":memory:");
    const thread = createThread(db, persona.id);
    let request = 0;
    const router = new Router([provider], new HealthTracker(), (async () => {
      request += 1;
      return request === 1
        ? toolCall("say", { text: "Checking the installer first." })
        : finalText("Installed.");
    }) as unknown as typeof fetch);
    const emitted: Array<{ type: string; [key: string]: unknown }> = [];

    const result = await runTaskTurn(db, router, { firstTokenTimeoutMs: 1000, turnTimeoutMs: 5000 }, {
      threadID: thread.id,
      text: "Install it",
      persona,
      channelID: "main",
      emit: (frame) => emitted.push(frame as { type: string; [key: string]: unknown }),
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("Installed.");
    const progress = emitted.find((frame) => frame.type === "msg.new" && frame.uiHint === "progress");
    expect(progress).toMatchObject({
      text: "Checking the installer first.",
      fromType: "agent",
      channelId: "main",
    });
    expect(emitted.some((frame) => frame.type === "turn.end")).toBe(true);
  });
});
