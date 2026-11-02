import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { enqueueJob, type JobRow } from "../stores/jobs";
import { editTask, getTask, setTaskReminderJob } from "../stores/tasks";
import type { JobRunner } from "./runner";
import { defaultPersona } from "../agent/personas";

interface ReminderPayload { taskID: string; reminderAt: string }

/** Persist one durable job per live task reminder, including after daemon restarts. */
export function scheduleTaskReminder(db: Database, taskID: string): void {
  const task = getTask(db, taskID);
  if (!task) return;
  if (task.reminder_job_id) {
    db.run("DELETE FROM jobs WHERE id=? AND state='queued'", [task.reminder_job_id]);
    db.run("UPDATE jobs SET enabled=0,updated_at=? WHERE id=? AND state='running'", [new Date().toISOString(),task.reminder_job_id]);
  }
  if (!task.reminder_at || task.status === "done") {
    setTaskReminderJob(db,taskID,null);
    return;
  }
  const job = enqueueJob(db,{kind:"task.reminder",payload:{taskID,reminderAt:task.reminder_at} satisfies ReminderPayload,runAt:task.reminder_at});
  setTaskReminderJob(db,taskID,job.id);
}

export function registerTaskReminderJob(runner: JobRunner, deps: { db: Database; emit: (frame: ServerFrameBody) => void }): void {
  const pending = deps.db.query<{id:string}, []>("SELECT id FROM tasks WHERE reminder_at IS NOT NULL AND status != 'done'").all();
  for (const {id} of pending) {
    const task = getTask(deps.db,id);
    const job = task?.reminder_job_id ? deps.db.query<{state:string;enabled:number}, [string]>("SELECT state,enabled FROM jobs WHERE id=?").get(task.reminder_job_id) : null;
    if (!job || job.state !== "queued" || !job.enabled) scheduleTaskReminder(deps.db,id);
  }
  runner.register("task.reminder", async (job: JobRow) => {
    let payload: ReminderPayload;
    try { payload = JSON.parse(job.payload ?? "") as ReminderPayload; }
    catch { throw new Error("invalid task reminder payload"); }
    const task = getTask(deps.db,payload.taskID);
    if (!task || task.status === "done" || task.reminder_at !== payload.reminderAt) return { result:"task reminder is no longer active" };
    deps.emit({type:"notify",title:"Task reminder",body:task.title,sound:false,agentId:defaultPersona().id});
    if (task.repeat_rule !== "none") {
      // Catch-up after downtime fires once, then lands on the next future occurrence.
      let steps = 0;
      let reminder = advance(new Date(payload.reminderAt),task.repeat_rule);
      while (reminder.getTime() <= Date.now() && steps++ < 5000) reminder = advance(reminder,task.repeat_rule);
      const nextReminder = reminder.toISOString();
      let due = task.due_at ? advance(new Date(task.due_at),task.repeat_rule) : null;
      for (let i = 0; due && i < steps; i += 1) due = advance(due,task.repeat_rule);
      const nextDue = due ? due.toISOString() : null;
      editTask(deps.db,task.id,{reminderAt:nextReminder,dueAt:nextDue},"scheduler");
      scheduleTaskReminder(deps.db,task.id);
    } else setTaskReminderJob(deps.db,task.id,null);
    return { result:`reminded about ${task.title}` };
  });
}

function advance(date: Date, rule: "daily" | "weekly" | "monthly"): Date {
  const next = new Date(date);
  if (rule === "daily") next.setDate(next.getDate() + 1);
  else if (rule === "weekly") next.setDate(next.getDate() + 7);
  else {
    const day = next.getDate();
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(),next.getMonth()+1,0).getDate();
    next.setDate(Math.min(day,lastDay));
  }
  return next;
}
