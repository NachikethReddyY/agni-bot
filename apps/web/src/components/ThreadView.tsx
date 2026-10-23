/**
 * The thread: transcript, anything waiting for you, the composer, and a quiet
 * status strip. Prose is left-aligned in a capped measure; only day dividers
 * and system notes centre, because they belong to the thread, not a person.
 */
import { useEffect, useRef, useState } from "react";
import { Hand, KeyRound, MessageCircleQuestion } from "lucide-react";
import {
  decisionTitle,
  format,
  type AgentInfo,
  type ApprovalRow,
  type ChatMessage,
  type FormRow,
  type SecretRow,
} from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { MessageRowView } from "./MessageRowView";
import { ComposerView } from "./ComposerView";
import { copyText } from "./bits";

export function ThreadView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const conversation = snapshot.conversation;
  const messages = conversation.messages;
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const last = messages[messages.length - 1];
  const lastText = last?.text ?? "";
  const lastID = last?.id ?? "";

  // A fresh agent surface starts a fresh selection.
  useEffect(() => {
    setSelected(new Set());
  }, [conversation.agentID, conversation.conversationID]);

  useEffect(() => {
    pinned.current = true;
    const element = scrollRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [conversation.agentID, conversation.conversationID]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "user") pinned.current = true;
    if (!pinned.current) return;
    const element = scrollRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, lastText, lastID, conversation.threadID]);

  // Search picks a message: bring it into view and stop following the tail.
  useEffect(() => {
    const target = snapshot.focusMessageID;
    if (!target) return;
    pinned.current = false;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(target)}"]`,
      );
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    model.clearFocusMessage();
    return () => cancelAnimationFrame(frame);
  }, [snapshot.focusMessageID, model]);

  const toggleSelection = (id: string) => {    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="thread">
      {messages.length === 0 ? (
        <div className="transcript-empty">
          Message {model.agent?.name ?? "Agni"} — one conversation, it never resets
        </div>
      ) : (
        <div
          className="transcript"
          ref={scrollRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          <div className="transcript-inner">
            {messages.map((message, index) => (
              <MessageBlock
                key={message.id}
                message={message}
                index={index}
                messages={messages}
                agent={model.agent}
                selected={selected.has(message.id)}
                onToggleSelect={() => toggleSelection(message.id)}
              />
            ))}
          </div>
        </div>
      )}

      <PendingInbox />
      {snapshot.statusText ? (
        <div className="status-strip">
          <span className="status-strip-dot" />
          <span>{snapshot.statusText}</span>
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="selection-bar">
          <span>{selected.size} selected</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn primary small"
            onClick={() => {
              const text = messages
                .filter((message) => selected.has(message.id))
                .map((message) => message.text)
                .join("\n\n");
              void copyText(text);
              setSelected(new Set());
            }}
          >
            Copy
          </button>
          <button type="button" className="btn plain small" onClick={() => setSelected(new Set())}>
            Cancel
          </button>
        </div>
      ) : null}

      <ComposerView />
    </div>
  );
}

function MessageBlock({
  message,
  index,
  messages,
  agent,
  selected,
  onToggleSelect,
}: {
  message: ChatMessage;
  index: number;
  messages: ChatMessage[];
  agent: AgentInfo | null | undefined;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  return (
    <>
      {isNewDay(messages, index) ? (
        <div className="day-divider">
          {format.dayTitle(message.createdAt ?? new Date())}
        </div>
      ) : null}
      {startsNewMoment(messages, index) ? (
        <div className="time-divider">
          {format.time(message.createdAt ?? new Date())}
        </div>
      ) : null}
      <MessageRowView
        message={message}
        agent={agent}
        isSelected={selected}
        onToggleSelect={onToggleSelect}
      />
    </>
  );
}

/**
 * A stamp of the clock, the way the reference app marks a moment in the
 * thread: one small centred time above a run of messages, not a timestamp on
 * every bubble. A new run starts after five quiet minutes.
 */
function startsNewMoment(messages: ChatMessage[], index: number): boolean {
  const message = messages[index];
  if (!message?.createdAt) return false;
  if (index === 0) return true;
  const previous = messages[index - 1]?.createdAt;
  if (!previous) return true;
  return message.createdAt.getTime() - previous.getTime() >= 5 * 60 * 1000;
}

function isNewDay(messages: ChatMessage[], index: number): boolean {
  const message = messages[index];
  if (!message) return false;
  const date = message.createdAt;
  if (!date) return false;
  if (index === 0) return true;
  const previous = messages[index - 1]?.createdAt;
  if (!previous) return true;
  return (
    date.getFullYear() !== previous.getFullYear() ||
    date.getMonth() !== previous.getMonth() ||
    date.getDate() !== previous.getDate()
  );
}

/** Anything blocking the agent's next move sits directly above the composer. */
function PendingInbox() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const approvals = snapshot.conversation.openApprovals;
  const forms = snapshot.conversation.openForms;
  const secrets = snapshot.conversation.openSecrets;
  if (approvals.length === 0 && forms.length === 0 && secrets.length === 0) return null;
  return (
    <div className="pending-inbox">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          onAnswer={(decision) => model.answer(approval, decision)}
        />
      ))}
      {forms.map((form) => (
        <FormCard key={form.id} form={form} onAnswer={(option) => model.answerForm(form, option)} />
      ))}
      {secrets.map((secret) => (
        <SecretCard
          key={secret.id}
          secret={secret}
          onSubmit={(value) => model.submitSecret(secret, value)}
          onCancel={() => model.cancelSecret(secret)}
        />
      ))}
    </div>
  );
}

function ApprovalCard({ approval, onAnswer }: { approval: ApprovalRow; onAnswer: (decision: string) => void }) {
  return (
    <div className="approval-card">
      <div className="card-heading">
        <Hand size={12} color="var(--ember)" />
        Agni wants to run something
        <span className="spacer" />
        <span className="card-heading-id">{approval.id}</span>
      </div>
      <div className="approval-action">{approval.action}</div>
      {approval.preview.length > 0 ? <div className="approval-preview">{approval.preview}</div> : null}
      <div className="card-actions">
        {approval.decisions.map((decision) => (
          <button
            key={decision}
            type="button"
            className={`btn small${decision === "once" ? " primary" : ""}`}
            onClick={() => onAnswer(decision)}
          >
            {decisionTitle(decision)}
          </button>
        ))}
      </div>
    </div>
  );
}

function FormCard({ form, onAnswer }: { form: FormRow; onAnswer: (option: string) => void }) {
  return (
    <div className="form-card">
      <div className="card-heading">
        <MessageCircleQuestion size={12} color="var(--amber)" />
        {form.question}
      </div>
      {form.options.length > 0 ? (
        <div className="form-options">
          {form.options.map((option, index) => (
            <button
              key={option}
              type="button"
              className="form-option"
              onClick={() => onAnswer(option)}
            >
              <span className="form-option-key" aria-hidden="true">
                {String.fromCharCode(65 + index)}
              </span>
              <span className="form-option-label">{option}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="form-hint">Or answer in your own words below.</div>
    </div>
  );
}

/**
 * One-time secret prompt. The value stays in this component's local state and
 * is cleared before the card unmounts; it is never copied into app state, the
 * transcript, or a log.
 */
function SecretCard({
  secret,
  onSubmit,
  onCancel,
}: {
  secret: SecretRow;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const submit = (): void => {
    if (!value) return;
    const typed = value;
    setValue("");
    onSubmit(typed);
  };
  return (
    <div className="secret-card">
      <div className="card-heading">
        <KeyRound size={12} color="var(--ember)" />
        {secret.purpose}
        <span className="spacer" />
        <span className="card-heading-id">{secret.id}</span>
      </div>
      <div className="secret-command">{secret.command}</div>
      <div className="secret-row">
        <input
          className="secret-input"
          type={secret.kind === "password" ? "password" : "text"}
          name={`agni-secret-${secret.id}`}
          value={value}
          autoFocus
          autoComplete="one-time-code"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore="true"
          placeholder={secret.kind === "password" ? "Password" : "Value"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
            if (event.key === "Escape") onCancel();
          }}
        />
        <button type="button" className="btn small ink" onClick={submit} disabled={!value}>
          Authorize
        </button>
        <button type="button" className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="form-hint">
        Sent once to the daemon for this command. It is never shown to the model, stored in the transcript, or written to a log.
      </div>
    </div>
  );
}
