/**
 * HITL approval broker. Only actions that can *destroy* state pause the loop:
 * destructive shell, writes outside the scratch tree, sends from the owner's
 * mailbox, and payment-style tools. Everything reversible runs free — reading,
 * research, memory, links, tasks, renames, and handoffs.
 *
 * Known reversible tools are listed in `FREE_TOOLS`: a prompt on every
 * reversible step trains the owner to click Allow without reading. Anything
 * not listed (a new tool, an MCP plugin tool) gates by default — a new
 * reversible tool must be added to `FREE_TOOLS` to run free.
 *
 * Approvals are durable: they live in the `approvals` table and are surfaced
 * to the client as `approval.request` frames. The decision is recorded and the
 * loop resumes (or aborts) once the client answers.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";
import { isReadOnlyCommand } from "../tools/bash";
import { isOutsideScratch } from "../tools/write-file";

export type Decision = "once" | "always" | "reject";

const decisionWaiters = new Map<string, (decision: Decision) => void>();

/** Waiters are process-local; the approval row remains the durable authority. */
export function resolveApprovalWaiter(requestID: string, decision: Decision): void {
  decisionWaiters.get(requestID)?.(decision);
}

export function waitForApprovalDecision(db: Database, requestID: string, signal: AbortSignal): Promise<Decision | null> {
  const row = db.query("SELECT status, decision FROM approvals WHERE id = ?").get(requestID) as { status: string; decision: Decision | null } | null;
  if (!row) return Promise.resolve(null);
  if (row.status === "decided" && row.decision) return Promise.resolve(row.decision);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (decision: Decision | null): void => {
      decisionWaiters.delete(requestID);
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = (): void => finish(null);
    decisionWaiters.set(requestID, (decision) => finish(decision));
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the update-before-registration race by reading the durable row again.
    const latest = db.query("SELECT status, decision FROM approvals WHERE id = ?").get(requestID) as typeof row;
    if (latest?.status === "decided" && latest.decision) finish(latest.decision);
  });
}

export interface ApprovalRequest {
  id: string;
  threadID: string;
  turnID: string;
  toolName: string;
  callID: string;
  action: string;
  preview: string;
  status: "pending" | "decided";
  decision: Decision | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovalBrokerDeps {
  db: Database;
  emit: (frame: { type: "approval.request"; requestID: string; action: string; preview: string; buttons: Decision[] }) => void;
  /** Wait for a decision on a pending approval. */
  waitForDecision: (requestID: string, signal: AbortSignal) => Promise<Decision | null>;
}

/** Tools that cannot destroy state or reach outside scratch. Everything else asks. */
const FREE_TOOLS = new Set([
  "ask", "say", "request_owner_input", "expand", "draft_email", "read_artifact",
  "memory_search", "memory_write", "transcript_search", "links_search", "link_save",
  "tasks_list", "task_create", "task_update", "task_status", "task_cancel",
  "remember_fact", "recall_fact", "get_fact", "forget_fact",
  // Confined to the scratch tree by the tools themselves.
  "read_file", "grep", "glob",
  "web_search", "web_fetch", "deep_research", "mail_search", "mail_read",
  "skills_list", "skills_load", "skills_resource",
  "handoff", "delegate_task", "delegate_wait", "rename_agent", "create_agent", "update_agent", "share_thread",
  "job_schedule", "job_list", "job_cancel", "routine_create", "routine_list", "routine_pause", "routine_delete",
]);

export class ApprovalBroker {
  constructor(private readonly deps: ApprovalBrokerDeps) {}

  /** Returns the decision (or null if the caller aborted). */
  async request(
    threadID: string,
    turnID: string,
    toolName: string,
    callID: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Decision | null> {
    const action = describeAction(toolName, args);
    const preview = previewAction(toolName, args);
    const requestID = newID("apr");

    this.deps.db.run(
      `INSERT INTO approvals (id, thread_id, turn_id, action, preview, status, decision, call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      [requestID, threadID, turnID, action, preview, callID, toolName, nowISO()],
    );

    this.deps.emit({ type: "approval.request", requestID, action, preview, buttons: ["once", "always", "reject"] });

    return this.deps.waitForDecision(requestID, signal);
  }

  /**
   * True only for actions that can destroy state — the owner's rule is "ask me
   * about destructive things, and nothing else" (2026-10-19). Everything
   * reversible is free: research, memory, links, tasks, renames, handoffs, and
   * reads. Renaming in particular is a chat-driven identity change that used to
   * stop the turn for a click; it no longer does. A tool this switch and
   * `FREE_TOOLS` do not know gates.
   */
  requiresApproval(toolName: string, args: Record<string, unknown>): boolean {
    switch (toolName) {
      case "bash":
        return !isReadOnlyCommand(String(args.command ?? ""), typeof args.cwd === "string" ? args.cwd : undefined);
      case "write_file":
        // Overwriting a file destroys whatever was there, so writes outside the
        // owner-declared scratch tree gate. Inside scratch they run free.
        return isOutsideScratch(String(args.path ?? ""));
      case "mail_send":
        // Agni's own mailbox ("agent", also the default when omitted) is
        // ungated (AGENTS.md amendment 2026-10-17); every other value gates.
        return !(args.account === undefined || args.account === null || args.account === "agent");
      default:
        return !FREE_TOOLS.has(toolName);
    }
  }
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": return `run shell: ${clip(String(args.command ?? ""), 400)}`;
    case "write_file": return `write file: ${args.path ?? "?"}`;
    case "read_file": return `read file: ${args.path ?? "?"}`;
    case "memory_write": return `save memory: ${String(args.text ?? "").slice(0, 80)}`;
    case "link_save": return `save link: ${args.url ?? "?"}`;
    case "task_create": return `add task: ${args.title ?? "?"}`;
    case "task_update": return `update task ${args.id ?? "?"}`;
    case "mail_send": return `send email to ${Array.isArray(args.to) ? args.to.join(", ") : args.to}: ${String(args.subject ?? "").slice(0, 80)}`;
    case "rename_agent": return args.agentId ? `rename ${args.agentId} to ${args.name}` : `rename the assistant to ${args.name}`;
    default: return `${toolName}(${clip(JSON.stringify(args), 400)})`;
  }
}

function previewAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") return clip(String(args.command ?? ""), 4_000);
  if (toolName === "mail_send") return `${describeAction(toolName, args)}\n\n${clip(String(args.body ?? ""), 4_000)}`;
  return describeAction(toolName, args);
}

/** Cap long text without hiding its end: the dangerous part is often the tail. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)} … ${text.length - 2 * half} chars omitted … ${text.slice(-half)}`;
}
