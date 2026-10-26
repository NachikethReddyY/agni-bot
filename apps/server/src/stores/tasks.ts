import type { Database } from "bun:sqlite";
import { PeerIntentSchema, type PeerIntent, type TaskInfo } from "@agni/protocol";
import { newID, nowISO } from "../util/ids";

export type TaskStatus = "open" | "done" | "snoozed";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type DelegateState = "none" | "queued" | "running" | "needs_input" | "done" | "failed";
export type TaskOrigin = "user_direct" | "ea_delegated";
export interface TaskRow {
  id: string; title: string; due_at: string|null; priority: TaskPriority; status: TaskStatus;
  created_at: string; updated_at: string; snoozed_until: string|null; owner_device_id: string|null;
  owner_agent_id: string|null; origin: string; delegate_state: string; brief: string|null; result: string|null;
  job_id: string|null; parent_turn_id: string|null;
  child_thread_id: string|null; parent_thread_id: string|null; parent_channel_id: string|null;
  parent_agent_id: string|null;
  pending_question: string|null; pending_question_id: string|null; result_delivered_at: string|null;
  artifact_id: string|null;
  list_id: string; description: string|null; parent_task_id: string|null; reminder_at: string|null; deadline_at: string|null; labels: string; attachment_ids: string; reminder_job_id: string|null;
  repeat_rule: "none" | "daily" | "weekly" | "monthly";
  workflow_status: "not_started" | "in_progress" | "ai_review";
  progress_note: string;
}

export interface TaskListRow { id: string; name: string; position: number; created_at: string; updated_at: string }
export interface TaskActivityRow { id: string; task_id: string; actor: string; action: string; detail: string|null; created_at: string }

export interface DelegationBrief {
  goal: string;
  /**
   * What this delegation is for. Phase 1 stores and reports it; the value is
   * not yet used to route or gate the work.
   */
  intent?: PeerIntent;
  constraints?: string[];
  deadline?: string | null;
  outputSchema?: string | null;
  /** Facts the child may need. Their text travels with the brief. */
  factIDs?: string[];
}

export function createTask(db: Database, input: { title: string; description?: string|null; dueAt?: string|null; reminderAt?: string|null; deadlineAt?: string|null; labels?: string[]; repeatRule?: TaskRow["repeat_rule"]; priority?: TaskPriority; ownerDeviceID?: string; actor?: string; listID?: string; parentTaskID?: string|null; attachmentIDs?: string[] }): TaskRow {
  const title=input.title.trim();
  if (!title || title.length>500) throw new Error("task title must be 1–500 characters");
  const priority=input.priority??"normal"; validatePriority(priority);
  const dueAt=validateDate(input.dueAt);
  const listID=input.listID??"lst_inbox";
  if (!getTaskList(db,listID)) throw new Error("task list does not exist");
  if (input.parentTaskID && !getTask(db,input.parentTaskID)) throw new Error("parent task does not exist");
  const row: TaskRow={id:newID("tsk"),title,due_at:dueAt,priority,status:"open",created_at:nowISO(),updated_at:nowISO(),snoozed_until:null,owner_device_id:input.ownerDeviceID??null,owner_agent_id:null,origin:"user_direct",delegate_state:"none",brief:null,result:null,job_id:null,parent_turn_id:null,child_thread_id:null,parent_thread_id:null,parent_channel_id:null,parent_agent_id:null,pending_question:null,pending_question_id:null,result_delivered_at:null,artifact_id:null,list_id:listID,description:input.description?.trim()||null,parent_task_id:input.parentTaskID??null,reminder_at:validateDate(input.reminderAt),deadline_at:validateDate(input.deadlineAt),labels:JSON.stringify(normalizeLabels(input.labels)),attachment_ids:JSON.stringify(input.attachmentIDs??[]),reminder_job_id:null,repeat_rule:input.repeatRule??"none",workflow_status:"not_started",progress_note:""};
  db.run("INSERT INTO tasks(id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id,list_id,description,parent_task_id,reminder_at,deadline_at,labels,attachment_ids,repeat_rule) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[row.id,row.title,row.due_at,row.priority,row.status,row.created_at,row.updated_at,row.snoozed_until,row.owner_device_id,row.owner_agent_id,row.origin,row.delegate_state,row.brief,row.result,row.job_id,row.parent_turn_id,row.list_id,row.description,row.parent_task_id,row.reminder_at,row.deadline_at,row.labels,row.attachment_ids,row.repeat_rule]);
  recordTaskActivity(db,row.id,input.actor??"owner","created",null);
  return row;
}

/** Create an async delegation task owned by the specialist (DEL-001/DEL-005). */
export function createDelegationTask(db: Database, input: {
  ownerAgentID: string;
  brief: DelegationBrief;
  origin?: TaskOrigin;
  parentTurnID?: string | null;
  parentThreadID?: string | null;
  parentChannelID?: string | null;
  parentAgentID?: string | null;
  dueAt?: string | null;
}): TaskRow {
  const goal = input.brief.goal.trim();
  if (!goal || goal.length > 500) throw new Error("delegation goal must be 1–500 characters");
  const origin = input.origin ?? "ea_delegated";
  // The brief is the task's storage for intent too; default it here so every
  // row written from now on carries one explicitly.
  const brief: DelegationBrief = { ...input.brief, intent: input.brief.intent ?? "request" };
  const row: TaskRow = {
    id: newID("tsk"), title: goal, due_at: validateDate(input.dueAt), priority: "normal", status: "open",
    created_at: nowISO(), updated_at: nowISO(), snoozed_until: null, owner_device_id: null,
    owner_agent_id: input.ownerAgentID, origin, delegate_state: "queued",
    brief: JSON.stringify(brief), result: null, job_id: null, parent_turn_id: input.parentTurnID ?? null,
    child_thread_id: null, parent_thread_id: input.parentThreadID ?? null, parent_channel_id: input.parentChannelID ?? null,
    parent_agent_id: input.parentAgentID ?? null,
    pending_question: null, pending_question_id: null, result_delivered_at: null, artifact_id: null,
    list_id: "lst_inbox", description: null, parent_task_id: null, reminder_at: null, deadline_at: null, labels: "[]", attachment_ids: "[]", reminder_job_id: null, repeat_rule: "none", workflow_status:"not_started", progress_note:"",
  };
  db.run(
    "INSERT INTO tasks(id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id,child_thread_id,parent_thread_id,parent_channel_id,parent_agent_id,pending_question,pending_question_id,result_delivered_at,artifact_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [row.id, row.title, row.due_at, row.priority, row.status, row.created_at, row.updated_at, row.snoozed_until, row.owner_device_id, row.owner_agent_id, row.origin, row.delegate_state, row.brief, row.result, row.job_id, row.parent_turn_id, row.child_thread_id, row.parent_thread_id, row.parent_channel_id, row.parent_agent_id, row.pending_question, row.pending_question_id, row.result_delivered_at, row.artifact_id],
  );
  recordTaskActivity(db,row.id,input.ownerAgentID,"created",goal);
  return row;
}

export function setDelegationJob(db: Database, id: string, jobID: string): void {
  db.run("UPDATE tasks SET job_id = ?, updated_at = ? WHERE id = ?", [jobID, nowISO(), id]);
}

/** The specialist's own thread, so a resume continues the same conversation. */
export function setDelegationThread(db: Database, id: string, threadID: string): void {
  db.run("UPDATE tasks SET child_thread_id = ?, updated_at = ? WHERE id = ?", [threadID, nowISO(), id]);
}

/**
 * A delegated task asks the owner something and waits (DEL-006). The
 * question is stored so the answer can be matched to it, and the question id
 * is what makes the answer idempotent: the same question is answered once.
 */
export function setPendingQuestion(
  db: Database,
  id: string,
  question: { text: string; questionID: string },
): void {
  db.run(
    "UPDATE tasks SET pending_question = ?, pending_question_id = ?, delegate_state = 'needs_input', updated_at = ? WHERE id = ?",
    [question.text, question.questionID, nowISO(), id],
  );
}

/** Clear the pending question once it has been answered. */
export function clearPendingQuestion(db: Database, id: string): void {
  db.run("UPDATE tasks SET pending_question = NULL, pending_question_id = NULL, updated_at = ? WHERE id = ?", [
    nowISO(),
    id,
  ]);
}

/** The question a task is waiting on, if any. */
export function getPendingQuestion(db: Database, id: string): { text: string; questionID: string } | null {
  const row = getTask(db, id);
  if (!row?.pending_question || !row.pending_question_id) return null;
  return { text: row.pending_question, questionID: row.pending_question_id };
}

/**
 * Claim the right to wake the parent for this task, and enqueue the wake in
 * the same transaction. `UPDATE ... WHERE result_delivered_at IS NULL` is the
 * claim: a second completion finds nothing to claim and does not wake again,
 * and a crash between the claim and the enqueue cannot leave a task claimed
 * but never woken (the enqueue is in the same transaction).
 */
export function claimResultDelivery(
  db: Database,
  id: string,
  enqueue: () => void,
): boolean {
  return db.transaction((): boolean => {
    const result = db.run(
      "UPDATE tasks SET result_delivered_at = ?, updated_at = ? WHERE id = ? AND result_delivered_at IS NULL",
      [nowISO(), nowISO(), id],
    );
    if (result.changes === 0) return false;
    enqueue();
    return true;
  })();
}

/** The artifact that holds the full result, if one was stored. */
export function setDelegationArtifact(db: Database, id: string, artifactID: string): void {
  db.run("UPDATE tasks SET artifact_id = ?, updated_at = ? WHERE id = ?", [artifactID, nowISO(), id]);
}

export function setDelegationState(db: Database, id: string, state: DelegateState, result?: string | null): TaskRow | null {
  if (!["none", "queued", "running", "needs_input", "done", "failed"].includes(state)) throw new Error("invalid delegate state");
  // A terminal state closes the question with it.
  if (state === "done" || state === "failed") {
    db.run(
      "UPDATE tasks SET delegate_state = ?, result = COALESCE(?, result), pending_question = NULL, pending_question_id = NULL, updated_at = ? WHERE id = ?",
      [state, result ?? null, nowISO(), id],
    );
  } else {
    db.run("UPDATE tasks SET delegate_state = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?", [state, result ?? null, nowISO(), id]);
  }
  return getTask(db, id);
}

export function getTaskByJob(db: Database, jobID: string): TaskRow | null {
  return db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE job_id = ?").get(jobID) ?? null;
}

/**
 * Find an in-flight delegation for the same owner, goal and delegating agent
 * (idempotency). Two different callers asking for the same goal are two
 * pieces of work; one caller retrying its own call is not.
 */
export function findActiveDelegation(
  db: Database,
  ownerAgentID: string,
  goal: string,
  delegatingAgentID: string,
): TaskRow | null {
  return (
    db
      .query<TaskRow, [string, string, string]>(
        "SELECT * FROM tasks WHERE owner_agent_id = ? AND title = ? AND parent_agent_id = ? AND delegate_state IN ('queued', 'running', 'needs_input') ORDER BY created_at DESC LIMIT 1",
      )
      .get(ownerAgentID, goal.trim(), delegatingAgentID) ?? null
  );
}

/** True when a task was cancelled, so a late job result must not revive it. */
export function isDelegationCancelled(db: Database, id: string): boolean {
  const row = getTask(db, id);
  return Boolean(row && row.delegate_state === "failed" && row.result === "cancelled by user");
}

/**
 * Cancel a delegation (DEL-001). A queued job is deleted; a running one is
 * disabled and its task closed, and the turn handler refuses to overwrite the
 * cancellation when the job eventually returns.
 */
export function cancelDelegation(db: Database, id: string): TaskRow | null {
  const task = getTask(db, id);
  if (!task) return null;
  if (task.delegate_state === "none" || task.delegate_state === "done" || task.delegate_state === "failed") {
    return task;
  }
  if (task.job_id) {
    db.run("UPDATE jobs SET enabled = 0, updated_at = ? WHERE id = ? AND state = 'running'", [nowISO(), task.job_id]);
    db.run("DELETE FROM jobs WHERE id = ? AND state = 'queued'", [task.job_id]);
  }
  return setDelegationState(db, id, "failed", "cancelled by user");
}

export function listTasks(db: Database, options: {status?: TaskStatus|"all"; limit?: number; includeSnoozed?: boolean}={}): TaskRow[] {
  const status=options.status??"open", limit=Math.min(200,Math.max(1,Math.floor(options.limit??50)));
  if(status!=="all") validateStatus(status);
  return status==="all"
    ? db.query<TaskRow,[number]>("SELECT * FROM tasks ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at LIMIT ?").all(limit)
    : options.includeSnoozed && status==="open"
      ? db.query<TaskRow,[number]>("SELECT * FROM tasks WHERE status IN ('open','snoozed') ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at LIMIT ?").all(limit)
      : db.query<TaskRow,[TaskStatus,number]>("SELECT * FROM tasks WHERE status=? ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,due_at,created_at LIMIT ?").all(status,limit);
}

export function setTaskStatus(db: Database,id:string,status:TaskStatus,actor="owner"):TaskRow|null {
  validateStatus(status);
  const old=getTask(db,id); if(!old)return null;
  db.run("UPDATE tasks SET status=?,snoozed_until=NULL,updated_at=? WHERE id=?",[status,nowISO(),id]);
  recordTaskActivity(db,id,actor,status === "done" ? "completed" : "reopened",null);
  return getTask(db,id);
}

export function snoozeTask(db: Database,id:string,until:string,actor="owner"):TaskRow|null {
  const date=validateDate(until); if(!date || Date.parse(date)<=Date.now()) throw new Error("snooze time must be in the future");
  const old=getTask(db,id); if(!old)return null;
  db.run("UPDATE tasks SET status='snoozed',snoozed_until=?,updated_at=? WHERE id=?",[date,nowISO(),id]);
  recordTaskActivity(db,id,actor,"snoozed",date);
  return getTask(db,id);
}

export function getTask(db:Database,id:string):TaskRow|null { return db.query<TaskRow,[string]>("SELECT * FROM tasks WHERE id=?").get(id)??null; }

/**
 * The task as clients see it. The owner sees every result; `resultRedacted`
 * says a result exists that this viewer may not see.
 */
export function taskInfo(task: TaskRow): TaskInfo {
  const delegateState = (["none", "queued", "running", "needs_input", "done", "failed"] as const).includes(
    task.delegate_state as "none",
  )
    ? (task.delegate_state as TaskInfo["delegateState"])
    : "none";
  return {
    id: task.id,
    title: task.title,
    dueAt: task.due_at,
    priority: task.priority,
    workflowStatus: task.workflow_status,
    progressNote: task.progress_note,
    status: task.status,
    snoozedUntil: task.snoozed_until,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    ownerAgentId: task.owner_agent_id,
    origin: task.origin === "ea_delegated" ? "ea_delegated" : "user_direct",
    intent: briefIntent(task.brief),
    delegateState,
    jobId: task.job_id,
    result: task.result,
    resultRedacted: false,
    listID: task.list_id,
    parentTaskID: task.parent_task_id,
    description: task.description,
    reminderAt: task.reminder_at,
    deadlineAt: task.deadline_at,
    labels: parseLabels(task.labels),
    repeatRule: task.repeat_rule,
    attachmentIDs: parseAttachmentIDs(task.attachment_ids),
  };
}

export function listTaskLists(db: Database): Array<TaskListRow & { task_count: number }> {
  return db.query<TaskListRow & { task_count: number }, []>(`SELECT l.*, COUNT(t.id) AS task_count FROM task_lists l
    LEFT JOIN tasks t ON t.list_id = l.id AND t.status != 'done'
    GROUP BY l.id ORDER BY l.position, l.created_at`).all();
}

export function getTaskList(db: Database, id: string): TaskListRow | null {
  return db.query<TaskListRow, [string]>("SELECT * FROM task_lists WHERE id = ?").get(id) ?? null;
}

export function createTaskList(db: Database, nameInput: string): TaskListRow {
  const name = nameInput.trim();
  if (!name || name.length > 80) throw new Error("list name must be 1–80 characters");
  if (db.query("SELECT 1 FROM task_lists WHERE lower(name) = lower(?)").get(name)) throw new Error("a list with that name already exists");
  const now = nowISO();
  const row = { id: newID("lst"), name, position: listTaskLists(db).length, created_at: now, updated_at: now };
  db.run("INSERT INTO task_lists(id,name,position,created_at,updated_at) VALUES(?,?,?,?,?)", [row.id,row.name,row.position,now,now]);
  return row;
}

export function editTask(db: Database, id: string, input: { title?: string; description?: string|null; dueAt?: string|null; reminderAt?: string|null; deadlineAt?: string|null; labels?: string[]; workflowStatus?: TaskRow["workflow_status"]; progressNote?: string|null; repeatRule?: TaskRow["repeat_rule"]; priority?: TaskPriority; listID?: string }, actor="owner"): TaskRow | null {
  const old = getTask(db,id); if (!old) return null;
  const title = input.title === undefined ? old.title : input.title.trim();
  if (!title || title.length > 500) throw new Error("task title must be 1–500 characters");
  if (input.priority) validatePriority(input.priority);
  if (input.listID && !getTaskList(db,input.listID)) throw new Error("task list does not exist");
  const workflowStatus=input.workflowStatus??old.workflow_status;
  if(!["not_started","in_progress","ai_review"].includes(workflowStatus)) throw new Error("invalid task workflow status");
  const progressNote=input.progressNote === undefined ? old.progress_note : (input.progressNote ?? "").trim().slice(0,1000);
  db.run(`UPDATE tasks SET title=?, description=?, due_at=?, reminder_at=?, deadline_at=?, labels=?, workflow_status=?, progress_note=?, repeat_rule=?, priority=?, list_id=?, updated_at=? WHERE id=?`,
    [title,input.description === undefined ? old.description : input.description?.trim() || null,input.dueAt === undefined ? old.due_at : validateDate(input.dueAt),input.reminderAt === undefined ? old.reminder_at : validateDate(input.reminderAt),input.deadlineAt === undefined ? old.deadline_at : validateDate(input.deadlineAt),input.labels === undefined ? old.labels : JSON.stringify(normalizeLabels(input.labels)),workflowStatus,progressNote,input.repeatRule ?? old.repeat_rule,input.priority ?? old.priority,input.listID ?? old.list_id,nowISO(),id]);
  const changed = getTask(db,id);
  if (changed) recordTaskActivity(db,id,actor,"edited",null);
  return changed;
}

export function listTaskActivity(db: Database, taskID: string): TaskActivityRow[] {
  return db.query<TaskActivityRow,[string]>("SELECT * FROM task_activity WHERE task_id=? ORDER BY created_at DESC LIMIT 100").all(taskID);
}

export function recordTaskActivity(db: Database, taskID: string, actor: string, action: string, detail: string|null): void {
  db.run("INSERT INTO task_activity(id,task_id,actor,action,detail,created_at) VALUES(?,?,?,?,?,?)",[newID("tac"),taskID,actor.slice(0,120),action.slice(0,40),detail,nowISO()]);
}

export function setTaskReminderJob(db: Database, taskID: string, jobID: string|null): void {
  db.run("UPDATE tasks SET reminder_job_id=?,updated_at=? WHERE id=?",[jobID,nowISO(),taskID]);
}

/** The intent a delegation's stored brief carries; absent or old rows read as "request". */
function briefIntent(brief: string | null): PeerIntent {
  if (!brief) return "request";
  try {
    const parsed: unknown = JSON.parse(brief);
    if (parsed && typeof parsed === "object") {
      const intent = PeerIntentSchema.safeParse((parsed as { intent?: unknown }).intent);
      if (intent.success) return intent.data;
    }
  } catch {
    // A malformed brief is still a request, not a reason to fail the read.
  }
  return "request";
}

function parseAttachmentIDs(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; }
  catch { return []; }
}

function normalizeLabels(labels: string[] | undefined): string[] {
  if (!labels) return [];
  return [...new Set(labels.map((label) => label.trim().replace(/^#/, "")).filter(Boolean))].slice(0, 20);
}

function parseLabels(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? normalizeLabels(parsed.filter((item): item is string => typeof item === "string")) : []; }
  catch { return []; }
}

export function validateDate(value:string|null|undefined):string|null {
  if(value==null||value==="")return null;
  const ms=Date.parse(value); if(!Number.isFinite(ms))throw new Error("date must be a valid ISO timestamp");
  return new Date(ms).toISOString();
}
export function validateStatus(value:string):asserts value is TaskStatus { if(!["open","done","snoozed"].includes(value))throw new Error("invalid task status"); }
export function validatePriority(value:string):asserts value is TaskPriority { if(!["low","normal","high","urgent"].includes(value))throw new Error("invalid task priority"); }
