/**
 * `request_owner_input` — a delegated task asks the owner a question and
 * waits for the answer (DEL-006).
 *
 * The specialist is on its own thread with only the brief. Sometimes the
 * brief is not enough: a password prompt, a missing document, a decision
 * that is the owner's to make. Rather than guess, the task asks, and the
 * turn stops with `needs_input`. The answer comes back through the
 * `task.answer` frame, matched to the question, and the task resumes in the
 * same conversation.
 *
 * The question is posted where the owner is watching — the channel the
 * delegating agent was in — and it is a `needs_input` message, so the
 * client can render it as a question rather than as chatter.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry } from "./registry";
import { appendChannelMessage } from "../stores/channels";
import { setPendingQuestion, getTask, taskInfo } from "../stores/tasks";
import { newID } from "../util/ids";
import { stripPeerTags } from "../agent/peer-message";

export interface RequestOwnerInputDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
  /** The delegation this question belongs to. */
  task: {
    id: string;
    /** The agent doing the work — it asks. */
    ownerAgentID: string;
    /** The agent that delegated, and gets the answer. */
    parentAgentID: string | null;
    /** The channel the owner is watching. */
    parentChannelID: string | null;
  };
  /** Called once the question is asked; the turn stops after this step. */
  onNeedsInput: (questionID: string) => void;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

export function registerRequestOwnerInputTool(registry: ToolRegistry, deps: RequestOwnerInputDeps): void {
  if (registry.get("request_owner_input")) return;
  registry.register({
    name: "request_owner_input",
    description:
      "Ask the owner a question you cannot answer yourself, and wait for the answer. " +
      "Use it when the work is blocked on something only the owner has: a missing file, a decision, a credential. " +
      "The turn stops and resumes with the answer; the owner sees the question where they are talking. " +
      "Do not guess, and do not ask a question you could answer from the brief or the tools.",
    kind: "static",
    timeoutMs: 2_000,
    schema: objectSchema({
      question: { type: "string", minLength: 1, maxLength: 1_000, description: "The question, in one or two sentences." },
    }, ["question"]),
    handler: async (args, ctx) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const rawQuestion = String(input.question ?? "").trim();
      const question = ctx.peerInput ? stripPeerTags(rawQuestion) : rawQuestion;
      if (!question) throw new Error("question is required");
      if (question.length > 1_000) throw new Error("question must be at most 1000 characters");

      const questionID = newID("qst");
      setPendingQuestion(deps.db, deps.task.id, { text: question, questionID });

      const channelID = deps.task.parentChannelID ?? "main";
      const agent = deps.db
        .query<{ display_name: string | null; avatar_color: string | null }, [string]>(
          "SELECT display_name, avatar_color FROM agents WHERE id = ?",
        )
        .get(deps.task.ownerAgentID);
      const row = appendChannelMessage(deps.db, {
        channelID,
        fromType: "agent",
        fromID: deps.task.ownerAgentID,
        text: question,
        uiHint: "needs_input",
        toAgentID: deps.task.parentAgentID,
        peerInfluenced: Boolean(ctx.peerInput),
      });
      deps.emit({
        type: "msg.new",
        id: row.id,
        channelId: channelID,
        fromType: "agent",
        fromId: deps.task.ownerAgentID,
        senderName: agent?.display_name ?? deps.task.ownerAgentID,
        senderColor: agent?.avatar_color ?? undefined,
        text: question,
        internal: false,
        uiHint: "needs_input",
        taskId: deps.task.id,
        questionId: questionID,
        ...(deps.task.parentAgentID ? { toAgentId: deps.task.parentAgentID } : {}),
        createdAt: row.created_at,
      });
      deps.onNeedsInput(questionID);
      // DEL-006: the task moved to `needs_input`; the clients show it.
      const task = getTask(deps.db, deps.task.id);
      if (task) deps.emit({ type: "task.updated", task: taskInfo(task) });
      return { asked: true, taskID: deps.task.id, questionID };
    },
  });
}
