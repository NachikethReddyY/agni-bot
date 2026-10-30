import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { JobRunner, JobOutcome } from "./runner";
import { enqueueJob, type JobRow } from "../stores/jobs";
import { listTasks } from "../stores/tasks";
import { searchLinks } from "../stores/links";
import { listAgentMemories } from "../stores/agent-memories";
import { appendMessage, createTurn, finishTurn, touchThread, type ThreadRow } from "../stores/threads";
import { backgroundSession, ensureConversation } from "../stores/conversations";
import { defaultPersona } from "../agent/personas";
import { resolveTimeZone } from "../config";
import { newID, nowISO } from "../util/ids";

export function registerBriefJob(runner: JobRunner, deps: { db: Database; emit: (frame: ServerFrameBody) => void; timeZone?: string }): void {
  const timeZone = deps.timeZone ?? resolveTimeZone();
  const existing = deps.db.query<{ id: string }, []>("SELECT id FROM jobs WHERE kind='brief' AND state IN ('queued','running') LIMIT 1").get();
  if (!existing) enqueueJob(deps.db, { kind: "brief", payload: { timeZone }, runAt: nextBriefRunAt(new Date(), timeZone) });
  runner.register("brief", async (job: JobRow): Promise<JobOutcome> => {
    const dateKey = localDate(new Date(), timeZone);
    const outcome = deps.db.transaction(() => {
      const prior = deps.db.query<{ thread_id: string }, [string]>("SELECT thread_id FROM brief_runs WHERE local_date=?").get(dateKey);
      if (prior) return { created: false as const, threadID: prior.thread_id, taskCount: 0 };
      const openTasks = listTasks(deps.db, { status: "open", limit: 50, includeSnoozed: true });
      const links = searchLinks(deps.db, "", 3);
      const memories = listAgentMemories(deps.db, { scope: "global_user", limit: 3 });
      const body = formatBrief(dateKey, openTasks, links, memories);
      const persona = defaultPersona();
      // The brief is a speaker in the user's one conversation with Agni: it
      // lands as its own session block inside it, so the person reads the
      // brief where they already talk — not in a separate chat instance.
      const conversation = ensureConversation(deps.db, persona.id);
      const thread: ThreadRow = backgroundSession(deps.db, conversation, `Morning brief · ${dateKey}`);
      const threadID = thread.id;
      const turnID = newID("trn");
      createTurn(deps.db, { id: turnID, threadID, agentID: persona.id });
      appendMessage(deps.db, { threadID, turnID, role: "assistant", text: body });
      finishTurn(deps.db, { id: turnID, stopReason: "end" });
      touchThread(deps.db, threadID);
      deps.db.run("INSERT INTO brief_runs(local_date,thread_id,notification_sent,created_at) VALUES(?,?,0,?)", [dateKey, threadID, nowISO()]);
      return { created: true as const, threadID, taskCount: openTasks.length };
    })();
    if (!outcome.created) return { result: `brief for ${dateKey} already exists`, nextRunAt: nextBriefRunAt(new Date(), timeZone) };
    deps.db.run("UPDATE brief_runs SET notification_sent=1 WHERE local_date=?", [dateKey]);
    deps.emit({ type: "notify", title: "Agni · morning brief", body: `Morning brief for ${dateKey} is ready. ${outcome.taskCount} open task(s).`, sound: false, threadID: outcome.threadID, agentId: defaultPersona().id });
    return { result: `brief ${dateKey} saved in thread ${outcome.threadID}`, nextRunAt: nextBriefRunAt(new Date(), timeZone) };
  }, { nextRun: () => nextBriefRunAt(new Date(), timeZone) });
}

function formatBrief(date: string, tasks: ReturnType<typeof listTasks>, links: ReturnType<typeof searchLinks>, memories: ReturnType<typeof listAgentMemories>): string {
  const lines = [`Morning brief · ${date}`, ""];
  const due = tasks.filter((task) => task.status === "open" && (!task.snoozed_until || Date.parse(task.snoozed_until) <= Date.now()));
  lines.push("Tasks");
  if (!due.length) lines.push("• Nothing due or overdue.");
  else for (const task of due.slice(0, 8)) lines.push(`• ${task.title}${task.due_at ? ` — due ${task.due_at.slice(0, 10)}` : ""} · ${task.priority}`);
  lines.push("", "Recently saved links");
  if (!links.length) lines.push("• No saved links yet.");
  else for (const link of links) lines.push(`• ${link.title ?? link.url}${link.note ? ` — ${link.note}` : ""} (${link.url})`);
  lines.push("", "Recent memories");
  if (!memories.length) lines.push("• No saved memories yet.");
  else for (const memory of memories) lines.push(`• ${memory.content}`);
  return lines.join("\n");
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function nextBriefRunAt(now: Date, timeZone: string): string {
  const dateKey = localDate(now, timeZone);
  const [year, month, day] = dateKey.split("-").map(Number) as [number, number, number];
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "2-digit" }).format(now));
  const nextDay = hour > 7 || (hour === 7 && minute >= 55);
  const desired = new Date(Date.UTC(year, month - 1, day + (nextDay ? 1 : 0), 7, 55));
  let guess = desired.getTime();
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
    guess += desired.getTime() - represented;
  }
  return new Date(guess).toISOString();
}
