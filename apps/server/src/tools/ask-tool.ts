/**
 * `ask` and `draft_email` — the two things an agent puts to the owner.
 *
 * `ask` is a question with options: the model uses it when the work turns on
 * a decision only the owner can make, and the owner answers by choosing (or
 * by typing, which dismisses the question and steers the work instead).
 *
 * `draft_email` is a composed email, drawn as a card the owner can send or
 * discard. It does not send anything: the owner decides, and the agent sends
 * with `mail_send` only if the answer was "send".
 */
import type { Database } from "bun:sqlite";
import type { ToolRegistry } from "./registry";
import type { FormBroker } from "../agent/form-broker";

export interface AskToolDeps {
  db: Database;
  broker: FormBroker;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});

/** The owner may take a while to answer; the turn waits rather than fails. */
const OWNER_TIMEOUT_MS = 600_000;

export function registerAskTool(registry: ToolRegistry, deps: AskToolDeps): void {
  if (registry.get("ask")) return;
  registry.register({
    name: "ask",
    description:
      "Ask the owner to choose, and wait for the answer. Use it when the work turns on a decision only the owner can make: " +
      "which of two plans to take, what to include, how far to go. Give a short question and, when the choices are clear, " +
      "the options as a list; the owner picks one (or several), or types their own answer instead. " +
      "Do not ask a question you could answer yourself from the brief or the tools.",
    kind: "static",
    timeoutMs: OWNER_TIMEOUT_MS,
    schema: objectSchema({
      question: { type: "string", minLength: 1, maxLength: 500, description: "The question, in one or two sentences." },
      options: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 200 },
        description: "The choices, when there are a small number of clear ones.",
      },
      multiple: {
        type: "boolean",
        description: "True when the owner may pick more than one option. Default false.",
      },
    }, ["question"]),
    handler: async (args, ctx) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const question = String(input.question ?? "").trim();
      if (!question) throw new Error("question is required");
      const rawOptions = Array.isArray(input.options) ? input.options : [];
      const options = rawOptions
        .map((option) => String(option).trim())
        .filter((option) => option.length > 0)
        .slice(0, 8);
      const answer = await deps.broker.request(
        {
          threadID: ctx.threadID,
          turnID: ctx.turnID,
          kind: "choice",
          question,
          options,
          multiple: input.multiple === true,
        },
        ctx.signal,
      );
      if (answer === null) return { answered: false, note: "the owner did not answer" };
      return { answered: true, answer, options };
    },
  });
}

export function registerDraftEmailTool(registry: ToolRegistry, deps: AskToolDeps): void {
  if (registry.get("draft_email")) return;
  registry.register({
    name: "draft_email",
    description:
      "Show the owner a composed email and wait for their decision. Use it before any email leaves the machine: " +
      "compose the draft, put it up with draft_email, and send it with mail_send only if the owner says send. " +
      "If the owner discards it, do not send anything.",
    kind: "static",
    timeoutMs: OWNER_TIMEOUT_MS,
    schema: objectSchema({
      to: { type: "string", minLength: 1, maxLength: 320, description: "Who the email is for." },
      subject: { type: "string", minLength: 1, maxLength: 300, description: "The subject line." },
      body: { type: "string", minLength: 1, maxLength: 20_000, description: "The body of the email, as plain text." },
      from: { type: "string", maxLength: 320, description: "Who it is from, when it is not the default account." },
    }, ["to", "subject", "body"]),
    handler: async (args, ctx) => {
      const input = (args ?? {}) as Record<string, unknown>;
      const to = String(input.to ?? "").trim();
      const subject = String(input.subject ?? "").trim();
      const body = String(input.body ?? "").trim();
      if (!to) throw new Error("to is required");
      if (!subject) throw new Error("subject is required");
      if (!body) throw new Error("body is required");
      const from = String(input.from ?? "").trim();
      const answer = await deps.broker.request(
        {
          threadID: ctx.threadID,
          turnID: ctx.turnID,
          kind: "email",
          question: "Send this email?",
          email: { from: from || undefined, to, subject, body },
        },
        ctx.signal,
      );
      if (answer === null) return { decided: false, note: "the owner did not decide" };
      const decision = answer.trim().toLowerCase();
      const send = decision.startsWith("send") || decision === "yes";
      return {
        decided: true,
        decision: send ? "send" : "discard",
        answer,
        ...(send ? {} : { note: "the owner discarded the draft — do not send it" }),
      };
    },
  });
}
