/**
 * The forms the agent puts to the owner.
 *
 * A form is either a *choice* — a question with options, one or many of them
 * — or an *email draft* the agent wants the owner to approve. The row is the
 * durable record of the question; the answer arrives on the `form.answer`
 * frame and lands in the same row.
 */
import type { Database } from "bun:sqlite";
import { newID, nowISO } from "../util/ids";

export type FormKind = "choice" | "email";

export interface FormEmail {
  from?: string;
  to: string;
  subject: string;
  body: string;
}

export interface FormRecord {
  id: string;
  threadID: string;
  turnID: string | null;
  kind: FormKind;
  question: string;
  options: string[];
  multiple: boolean;
  email: FormEmail | null;
  status: "pending" | "answered";
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

interface FormRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  kind: string;
  question: string;
  options: string | null;
  multiple: number;
  email: string | null;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function parseEmail(raw: string | null): FormEmail | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FormEmail>;
    if (typeof parsed.to !== "string" || typeof parsed.subject !== "string") return null;
    return {
      from: typeof parsed.from === "string" ? parsed.from : undefined,
      to: parsed.to,
      subject: parsed.subject,
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return null;
  }
}

function toRecord(row: FormRow): FormRecord {
  return {
    id: row.id,
    threadID: row.thread_id,
    turnID: row.turn_id,
    kind: row.kind === "email" ? "email" : "choice",
    question: row.question,
    options: parseArray(row.options),
    multiple: row.multiple === 1,
    email: parseEmail(row.email),
    status: row.status === "answered" ? "answered" : "pending",
    answer: row.answer,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}

export function createForm(
  db: Database,
  spec: {
    threadID: string;
    turnID: string | null;
    kind: FormKind;
    question: string;
    options?: string[];
    multiple?: boolean;
    email?: FormEmail;
  },
): FormRecord {
  const id = newID("frm");
  db.run(
    `INSERT INTO forms (id, thread_id, turn_id, kind, question, options, multiple, email, status, answer, created_at, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    [
      id,
      spec.threadID,
      spec.turnID,
      spec.kind,
      spec.question,
      spec.options ? JSON.stringify(spec.options) : null,
      spec.multiple ? 1 : 0,
      spec.email ? JSON.stringify(spec.email) : null,
      nowISO(),
    ],
  );
  const row = db.query<FormRow, [string]>("SELECT * FROM forms WHERE id = ?").get(id);
  if (!row) throw new Error("the form row did not stick");
  return toRecord(row);
}

export function getForm(db: Database, id: string): FormRecord | null {
  const row = db.query<FormRow, [string]>("SELECT * FROM forms WHERE id = ?").get(id);
  return row ? toRecord(row) : null;
}

/** Record the answer. The first answer wins; a late one is ignored. */
export function answerForm(db: Database, id: string, answer: string): FormRecord | null {
  const form = getForm(db, id);
  if (!form || form.status === "answered") return form;
  db.run("UPDATE forms SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?", [
    answer,
    nowISO(),
    id,
  ]);
  return getForm(db, id);
}

/** The forms still waiting on the owner, for a thread. */
export function pendingForms(db: Database, threadID: string): FormRecord[] {
  const rows = db
    .query<FormRow, [string]>("SELECT * FROM forms WHERE thread_id = ? AND status = 'pending' ORDER BY created_at")
    .all(threadID);
  return rows.map(toRecord);
}
