/**
 * Changing an agent, not creating one.
 *
 * The owner describes what an agent is for — "Friday is now an inbox
 * manager: read-only, escalate what matters" — and that description has to
 * land somewhere. Before this tool it could only be said out loud: the
 * agent's role and prompt were set at creation and never again, so a bot
 * the owner redefined kept running as whatever it was born as.
 *
 * The change is durable (the row) and immediate (the in-memory persona), and
 * the roster is broadcast so every client follows.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { ToolRegistry, ToolDefinition } from "./registry";
import { getPersona, personaInfo, mentionRoster, updatePersona } from "../agent/personas";

export interface UpdateAgentDeps {
  db: Database;
  emit: (frame: ServerFrameBody) => void;
}

export interface UpdateAgentArgs {
  /** The agent to change, e.g. "friday". */
  agentID: string;
  /** What this agent is for, in the owner's words. */
  role?: string;
  /** The system prompt, as a template: `{name}` and `{user}` are substituted. */
  prompt?: string;
}

export interface UpdateAgentResult {
  id: string;
  name: string;
  role: string;
  prompt: string;
}

export function updateAgent(db: Database, args: UpdateAgentArgs): UpdateAgentResult {
  const id = args.agentID?.trim();
  if (!id) throw new Error("which agent? give its id");
  if (!getPersona(id)) throw new Error(`no agent with id "${id}"`);
  const updated = updatePersona(db, id, {
    ...(args.role === undefined ? {} : { role: args.role }),
    ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
  });
  if (!updated) throw new Error(`no agent with id "${id}"`);
  return updated;
}

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object", properties, required, additionalProperties: false,
});
const stringProp = { type: "string", minLength: 1 };

/** The `update_agent` tool. */
export function createUpdateAgentTool(deps: UpdateAgentDeps): ToolDefinition<UpdateAgentArgs, UpdateAgentResult> {
  return {
    name: "update_agent",
    description:
      "Change what an agent is for: its role and its system prompt. Use it when the owner redefines an agent " +
      "(\"Friday is now an inbox manager: read-only, escalate what matters, never send\"). " +
      "The prompt is a template — `{name}` and `{user}` are substituted at turn time. " +
      "The change is durable and every client sees it immediately.",
    kind: "static",
    schema: objectSchema({
      agent_id: stringProp,
      role: { type: "string", minLength: 1, maxLength: 500 },
      prompt: { type: "string", minLength: 1, maxLength: 4_000 },
    }, ["agent_id"]),
    timeoutMs: 2_000,
    handler: async (args) => {
      const result = updateAgent(deps.db, args);
      // The roster follows, so the app shows the new role straight away.
      deps.emit({ type: "agents.update", agents: personaInfo(deps.db), mentions: mentionRoster(deps.db) });
      return result;
    },
  };
}
