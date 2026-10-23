/**
 * Store tools. memory.search, links.search, tasks.list, and writes — all
 * bounded and indexed at write time (S2/S4). These run without approval.
 */
import type { Database } from "bun:sqlite";
import {
  listAgentMemories,
  putAgentMemory,
  getAgentMemory,
  deleteAgentMemory,
  normalizeTags,
  type AgentMemoryRow,
} from "../stores/agent-memories";
import { searchLinks, saveLink, updateLink, deleteLink } from "../stores/links";
import { listTasks, createTask, editTask, setTaskStatus, snoozeTask, getTask } from "../stores/tasks";
import { fetchPage } from "./fetch-url";

export interface MemorySearchArgs {
  query: string;
  limit?: number;
  /** The agent asking. Scope and visibility are enforced against it. */
  callerAgentID?: string | null;
}

export interface MemorySearchResult {
  memories: { id: string; text: string; summary: string | null; tags: string | null }[];
}

export function memorySearch(db: Database, args: MemorySearchArgs): MemorySearchResult {
  const rows = listAgentMemories(db, {
    scope: "global_user",
    limit: args.limit ?? 8,
    query: args.query,
    callerAgentID: args.callerAgentID ?? null,
  });
  return { memories: rows.map((row) => ({ id: row.id, text: row.content, summary: null, tags: row.tags })) };
}

export interface MemoryWriteArgs {
  text: string;
  tags?: string[];
}

export interface MemoryWriteResult {
  id: string;
  text: string;
}

export function memoryWrite(db: Database, args: MemoryWriteArgs): MemoryWriteResult {
  const row = putAgentMemory(db, {
    scope: "global_user",
    agentID: null,
    keySlug: slugForMemory(args.text),
    type: "fact",
    content: args.text,
    tags: args.tags,
  });
  return { id: row.id, text: row.content };
}

export interface MemoryUpdateArgs {
  id: string;
  text?: string;
  tags?: string[];
}

export function memoryUpdate(db: Database, args: MemoryUpdateArgs): MemoryWriteResult | null {
  const current = getAgentMemory(db, args.id);
  if (!current) return null;
  const row = putAgentMemory(db, {
    scope: current.scope,
    agentID: current.agent_id,
    keySlug: current.key_slug,
    type: current.type,
    content: args.text ?? current.content,
    tags: args.tags,
    importance: current.importance,
  });
  return { id: row.id, text: row.content };
}

export interface MemoryDeleteArgs {
  id: string;
}

export function memoryDelete(db: Database, args: MemoryDeleteArgs): boolean {
  return deleteAgentMemory(db, args.id);
}

export interface LinksSearchArgs {
  query: string;
  limit?: number;
}

export interface LinksSearchResult {
  links: { id: string; url: string; title: string | null; summary: string | null; note: string | null; tags: string | null }[];
}

export function linksSearch(db: Database, args: LinksSearchArgs): LinksSearchResult {
  const rows = searchLinks(db, args.query, args.limit ?? 8);
  return { links: rows.map((row) => ({ id: row.id, url: row.url, title: row.title, summary: row.summary, note: row.note, tags: row.tags })) };
}

export interface LinkSaveArgs {
  url: string;
  note?: string;
  tags?: string[];
}

export interface LinkSaveResult {
  id: string;
  url: string;
  title: string | null;
  summary: string | null;
}

export async function linkSave(db: Database, args: LinkSaveArgs): Promise<LinkSaveResult> {
  let page: { title: string | null; summary: string | null } = { title: null, summary: null };
  try { page = await fetchPage(args.url); } catch { /* URL and note are still saved */ }
  const row = saveLink(db, { url: args.url, ...page, note: args.note, tags: args.tags });
  return { id: row.id, url: row.url, title: row.title, summary: row.summary };
}

export interface TasksListArgs {
  status?: "open" | "done" | "snoozed" | "all";
  limit?: number;
}

export interface TasksListResult {
  tasks: { id: string; title: string; dueAt: string | null; priority: string; status: string; snoozedUntil: string | null }[];
}

export function tasksList(db: Database, args: TasksListArgs): TasksListResult {
  const rows = listTasks(db, { status: args.status ?? "open", limit: args.limit ?? 20, includeSnoozed: args.status === "open" });
  return { tasks: rows.map((row) => ({ id: row.id, title: row.title, dueAt: row.due_at, priority: row.priority, status: row.status, snoozedUntil: row.snoozed_until })) };
}

export interface TaskCreateArgs {
  title: string;
  dueAt?: string;
  reminderAt?: string;
  deadlineAt?: string;
  labels?: string[];
  repeatRule?: "none" | "daily" | "weekly" | "monthly";
  priority?: "low" | "normal" | "high" | "urgent";
  actor?: string;
}

export interface TaskCreateResult {
  id: string;
  title: string;
  dueAt: string | null;
  priority: string;
}

export function taskCreate(db: Database, args: TaskCreateArgs): TaskCreateResult {
  const row = createTask(db, { title: args.title, dueAt: args.dueAt, reminderAt: args.reminderAt, deadlineAt: args.deadlineAt, labels: args.labels, repeatRule: args.repeatRule, priority: args.priority, actor: args.actor });
  return { id: row.id, title: row.title, dueAt: row.due_at, priority: row.priority };
}

export interface TaskUpdateArgs {
  id: string;
  action: "done" | "reopen" | "snooze" | "edit";
  until?: string;
  title?: string;
  dueAt?: string | null;
  reminderAt?: string | null;
  deadlineAt?: string | null;
  labels?: string[];
  workflowStatus?: "not_started" | "in_progress" | "ai_review";
  progressNote?: string | null;
  repeatRule?: "none" | "daily" | "weekly" | "monthly";
  priority?: "low" | "normal" | "high" | "urgent";
  description?: string | null;
  actor?: string;
}

export function taskUpdate(db: Database, args: TaskUpdateArgs): TaskCreateResult | null {
  const old = getTask(db, args.id);
  if (!old) return null;
  let updated;
  if (args.action === "done") updated = setTaskStatus(db, old.id, "done", args.actor);
  else if (args.action === "reopen") updated = setTaskStatus(db, old.id, "open", args.actor);
  else if (args.action === "snooze") {
    if (!args.until) throw new Error("snooze requires an ISO timestamp in the future");
    updated = snoozeTask(db, old.id, args.until, args.actor);
  } else if (args.action === "edit") {
    updated = editTask(db,old.id,{title:args.title,description:args.description,dueAt:args.dueAt,reminderAt:args.reminderAt,deadlineAt:args.deadlineAt,labels:args.labels,workflowStatus:args.workflowStatus,progressNote:args.progressNote,repeatRule:args.repeatRule,priority:args.priority},args.actor);
  } else throw new Error("unknown task action");
  return updated ? { id: updated.id, title: updated.title, dueAt: updated.due_at, priority: updated.priority } : null;
}

function slugForMemory(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "saved-memory";
}
