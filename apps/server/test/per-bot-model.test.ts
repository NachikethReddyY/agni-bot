import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/db";
import { HealthTracker } from "../src/models/health";
import { Router, preferFirst } from "../src/models/router";
import type { ProviderConfig } from "../src/models/providers";
import { resolvePersona, updatePersona } from "../src/agent/personas";

const groq: ProviderConfig = { id: "groq", label: "Groq", baseUrl: "https://groq.local/v1", apiKey: "k", model: "llama-70b" };
const cerebras: ProviderConfig = { id: "cerebras", label: "Cerebras", baseUrl: "https://cerebras.local/v1", apiKey: "k", model: "qwen" };

let db: Database | undefined;
afterEach(() => { db?.close(); db = undefined; });

describe("per-bot model", () => {
  test("preferFirst matches a provider id, provider:model, or a model id", () => {
    expect(preferFirst([groq, cerebras], null)).toEqual([groq, cerebras]);
    expect(preferFirst([groq, cerebras], "cerebras").map((p) => p.id)).toEqual(["cerebras", "groq"]);
    expect(preferFirst([groq, cerebras], "qwen").map((p) => p.id)).toEqual(["cerebras", "groq"]);
    const [first] = preferFirst([groq, cerebras], "groq:llama-8b:free");
    expect(first).toMatchObject({ id: "groq", model: "llama-8b:free" });
    expect(preferFirst([groq], "missing")).toEqual([groq]);
  });

  test("the router calls the bot's model first and falls back when it is cooling", async () => {
    const calls: string[] = [];
    const fetchStub = async (url: string, init: RequestInit) => {
      calls.push(`${new URL(url).host}:${JSON.parse(String(init.body)).model}`);
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`);
    };
    const health = new HealthTracker();
    const router = new Router([groq, cerebras], health, fetchStub as unknown as typeof fetch);
    const route = (preferredModel: string) => router.route({ messages: [{ role: "user", content: "hi" }], firstTokenTimeoutMs: 1000, onDelta: () => undefined, preferredModel });
    expect((await route("cerebras:qwen-small")).model).toBe("qwen-small");
    health.markFailure("cerebras", 60_000, "down");
    expect((await route("cerebras:qwen-small")).provider).toBe("groq");
    expect(calls).toEqual(["cerebras.local:qwen-small", "groq.local:llama-70b"]);
  });

  test("agents.model is stored, resolved, and cleared", () => {
    db = openDatabase(":memory:");
    updatePersona(db, "researcher", { model: "groq:llama-8b" });
    expect(resolvePersona(db, "researcher")?.model).toBe("groq:llama-8b");
    updatePersona(db, "researcher", { model: "" });
    expect(resolvePersona(db, "researcher")?.model).toBeNull();
  });
});
