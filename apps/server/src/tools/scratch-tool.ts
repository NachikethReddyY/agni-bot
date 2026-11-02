/**
 * `scratch_read` / `scratch_append`: the delegated task's shared notes.
 *
 * Registered only on a delegated turn, keyed by that turn's task, so a bot
 * can leave working notes (sources found, decisions, open questions) that
 * survive retries and that the delegating bot can read with `task_status`
 * instead of everything travelling through one final result.
 */
import type { Database } from "bun:sqlite";
import type { ToolRegistry } from "./registry";
import { appendTaskNote, listTaskNotes } from "../stores/task-notes";

export const SCRATCH_TOOLS = ["scratch_read", "scratch_append"] as const;
const MAX_NOTE_CHARS = 2_000;

export function registerScratchTools(registry: ToolRegistry, deps: { db: Database; taskID: string; agentID: string }): void {
  if (registry.get("scratch_read")) return;
  registry.register({
    name: "scratch_read",
    description: "Read this task's shared scratchpad: the notes bots working the task have left so far.",
    kind: "static",
    timeoutMs: 5_000,
    schema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => ({
      taskID: deps.taskID,
      notes: listTaskNotes(deps.db, deps.taskID).map((note) => ({ agentID: note.agent_id, text: note.text, at: note.created_at })),
    }),
  });
  registry.register({
    name: "scratch_append",
    description: "Add a short note to this task's shared scratchpad (findings, sources, decisions) for the bots working it and the bot that delegated it.",
    kind: "static",
    timeoutMs: 5_000,
    schema: {
      type: "object",
      properties: { text: { type: "string", minLength: 1, maxLength: MAX_NOTE_CHARS } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>) => {
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("scratch_append requires text");
      const note = appendTaskNote(deps.db, deps.taskID, deps.agentID, text.slice(0, MAX_NOTE_CHARS));
      return { ok: true, id: note.id };
    },
  });
}
