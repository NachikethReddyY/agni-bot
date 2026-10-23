/**
 * Forms: the questions an agent puts to the owner.
 *
 * A form is a *choice* — a question with options, one or many of them — or
 * an *email draft* the agent wants the owner to look at before it goes out.
 * The broker writes the durable row, draws the card on the client, and waits
 * for the answer; the answer comes back on the `form.answer` frame and the
 * turn carries on with it.
 *
 * If the owner would rather type than choose, the client answers the form
 * with their own words and sends their message on: the question is dismissed
 * and the message steers the work.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import { answerForm, createForm, getForm, type FormEmail, type FormKind } from "../stores/forms";

/** Waiters are process-local; the row remains the durable authority. */
const formWaiters = new Map<string, (answer: string) => void>();

export function resolveFormWaiter(requestID: string, answer: string): void {
  formWaiters.get(requestID)?.(answer);
}

/** Resolve a form the owner answered, and wake the turn waiting on it. */
export function answerFormAndWake(db: Database, requestID: string, answer: string): boolean {
  const form = getForm(db, requestID);
  if (!form) return false;
  answerForm(db, requestID, answer);
  resolveFormWaiter(requestID, answer);
  return true;
}

export function waitForFormAnswer(db: Database, requestID: string, signal: AbortSignal): Promise<string | null> {
  const form = getForm(db, requestID);
  if (!form) return Promise.resolve(null);
  if (form.status === "answered" && form.answer) return Promise.resolve(form.answer);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (answer: string | null): void => {
      formWaiters.delete(requestID);
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    const onAbort = (): void => finish(null);
    formWaiters.set(requestID, (answer) => finish(answer));
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the update-before-registration race by reading the row again.
    const latest = getForm(db, requestID);
    if (latest?.status === "answered" && latest.answer) finish(latest.answer);
  });
}

export interface FormRequestSpec {
  threadID: string;
  turnID: string | null;
  kind: FormKind;
  question: string;
  options?: string[];
  multiple?: boolean;
  email?: FormEmail;
}

export interface FormBrokerDeps {
  db: Database;
  emit: (body: ServerFrameBody) => void;
}

export class FormBroker {
  constructor(private readonly deps: FormBrokerDeps) {}

  /** Puts the question to the owner and waits for the answer. */
  async request(spec: FormRequestSpec, signal: AbortSignal): Promise<string | null> {
    const form = createForm(this.deps.db, {
      threadID: spec.threadID,
      turnID: spec.turnID,
      kind: spec.kind,
      question: spec.question,
      options: spec.options,
      multiple: spec.multiple,
      email: spec.email,
    });
    this.deps.emit({
      type: "form.request",
      requestID: form.id,
      question: form.question,
      options: form.options.length > 0 ? form.options : undefined,
      multiple: form.multiple,
      kind: form.kind,
      email: form.email ?? undefined,
    });
    return waitForFormAnswer(this.deps.db, form.id, signal);
  }
}
