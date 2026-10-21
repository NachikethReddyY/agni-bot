import type { Database } from "bun:sqlite";
import type { TaskInfo } from "@agni/protocol";
import { newID, nowISO } from "../util/ids";

export type TaskStatus = "open" | "done" | "snoozed";
export type TaskPriority = "low" | "normal" | "high";
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
}

export interface DelegationBrief {
  goal: string;
  constraints?: string[];
  deadline?: string | null;
  outputSchema?: string | null;
  /** Facts the child may need. Their text travels with the brief. */
  factIDs?: string[];
}

export function createTask(db: Database, input: { title: string; dueAt?: string|null; priority?: TaskPriority; ownerDeviceID?: string }): TaskRow {
  const title=input.title.trim();
  if (!title || title.length>500) throw new Error("task title must be 1–500 characters");
  const priority=input.priority??"normal"; validatePriority(priority);
  const dueAt=validateDate(input.dueAt);
  const row: TaskRow={id:newID("tsk"),title,due_at:dueAt,priority,status:"open",created_at:nowISO(),updated_at:nowISO(),snoozed_until:null,owner_device_id:input.ownerDeviceID??null,owner_agent_id:null,origin:"user_direct",delegate_state:"none",brief:null,result:null,job_id:null,parent_turn_id:null,child_thread_id:null,parent_thread_id:null,parent_channel_id:null,parent_agent_id:null,pending_question:null,pending_question_id:null,result_delivered_at:null,artifact_id:null};
  db.run("INSERT INTO tasks(id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[row.id,row.title,row.due_at,row.priority,row.status,row.created_at,row.updated_at,row.snoozed_until,row.owner_device_id,row.owner_agent_id,row.origin,row.delegate_state,row.brief,row.result,row.job_id,row.parent_turn_id]);
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
  const row: TaskRow = {
    id: newID("tsk"), title: goal, due_at: validateDate(input.dueAt), priority: "normal", status: "open",
    created_at: nowISO(), updated_at: nowISO(), snoozed_until: null, owner_device_id: null,
    owner_agent_id: input.ownerAgentID, origin, delegate_state: "queued",
    brief: JSON.stringify(input.brief), result: null, job_id: null, parent_turn_id: input.parentTurnID ?? null,
    child_thread_id: null, parent_thread_id: input.parentThreadID ?? null, parent_channel_id: input.parentChannelID ?? null,
    parent_agent_id: input.parentAgentID ?? null,
    pending_question: null, pending_question_id: null, result_delivered_at: null, artifact_id: null,
  };
  db.run(
    "INSERT INTO tasks(id,title,due_at,priority,status,created_at,updated_at,snoozed_until,owner_device_id,owner_agent_id,origin,delegate_state,brief,result,job_id,parent_turn_id,child_thread_id,parent_thread_id,parent_channel_id,parent_agent_id,pending_question,pending_question_id,result_delivered_at,artifact_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [row.id, row.title, row.due_at, row.priority, row.status, row.created_at, row.updated_at, row.snoozed_until, row.owner_device_id, row.owner_agent_id, row.origin, row.delegate_state, row.brief, row.result, row.job_id, row.parent_turn_id, row.child_thread_id, row.parent_thread_id, row.parent_channel_id, row.parent_agent_id, row.pending_question, row.pending_question_id, row.result_delivered_at, row.artifact_id],
  );
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

/** Find an in-flight delegation for the same owner and goal (idempotency). */
export function findActiveDelegation(db: Database, ownerAgentID: string, goal: string): TaskRow | null {
  return (
    db
      .query<TaskRow, [string, string]>(
        "SELECT * FROM tasks WHERE owner_agent_id = ? AND title = ? AND delegate_state IN ('queued', 'running', 'needs_input') ORDER BY created_at DESC LIMIT 1",
      )
      .get(ownerAgentID, goal.trim()) ?? null
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

export function setTaskStatus(db: Database,id:string,status:TaskStatus):TaskRow|null {
  validateStatus(status);
  const old=getTask(db,id); if(!old)return null;
  db.run("UPDATE tasks SET status=?,snoozed_until=NULL,updated_at=? WHERE id=?",[status,nowISO(),id]);
  return getTask(db,id);
}

export function snoozeTask(db: Database,id:string,until:string):TaskRow|null {
  const date=validateDate(until); if(!date || Date.parse(date)<=Date.now()) throw new Error("snooze time must be in the future");
  const old=getTask(db,id); if(!old)return null;
  db.run("UPDATE tasks SET status='snoozed',snoozed_until=?,updated_at=? WHERE id=?",[date,nowISO(),id]);
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
    status: task.status,
    snoozedUntil: task.snoozed_until,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    ownerAgentId: task.owner_agent_id,
    origin: task.origin === "ea_delegated" ? "ea_delegated" : "user_direct",
    delegateState,
    jobId: task.job_id,
    result: task.result,
    resultRedacted: false,
  };
}

export function validateDate(value:string|null|undefined):string|null {
  if(value==null||value==="")return null;
  const ms=Date.parse(value); if(!Number.isFinite(ms))throw new Error("date must be a valid ISO timestamp");
  return new Date(ms).toISOString();
}
export function validateStatus(value:string):asserts value is TaskStatus { if(!["open","done","snoozed"].includes(value))throw new Error("invalid task status"); }
export function validatePriority(value:string):asserts value is TaskPriority { if(!["low","normal","high"].includes(value))throw new Error("invalid task priority"); }
