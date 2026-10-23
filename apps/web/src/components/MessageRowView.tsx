/**
 * One row of the transcript. A person's message is a bubble on the right; the
 * assistant's reply is unfilled prose in a quiet bubble, so long answers read
 * like something written to you rather than a card that was delivered.
 *
 * The name is never spelled out again — the header already says who you are
 * talking to, and a thread is a conversation, not a stack of labels.
 *
 * Tool activity is shown as one quiet, collapsible line under the answer —
 * enough to see that the work happened, not enough to turn the transcript
 * into a log. The `say` tool is for the milestones that deserve words.
 */
import { useState, type FormEvent } from "react";
import { MarkdownText } from "./MarkdownText";
import { AttachmentCard } from "./AttachmentCard";
import { Check, Copy, TextCursor } from "lucide-react";
import { isStreaming, stopExplanation, type AgentInfo, type ChatMessage } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { copyText, SidebarAgentBadge } from "./bits";

export function MessageRowView({
  message,
  agent,
  isSelected,
  onToggleSelect,
}: {
  message: ChatMessage;
  agent: AgentInfo | null | undefined;
  isSelected: boolean;
  onToggleSelect: () => void;
}) {
  const model = useAppModel();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const explanation = stopExplanation(message);
  const emptySystemRow = message.role === "system" && message.text.length === 0 && message.uiHint !== "handoff_notice";
  // The name prompt is settled once the agent has a name. The daemon says so;
  // the agent's own flag settles it the moment a rename lands.
  const onboarded = agent?.onboarded === true;
  const onboardingHint =
    message.uiHint === "onboarding_name_prompt" && onboarded ? "onboarding_completed" : message.uiHint;

  return (
    <div
      className={`message-row ${message.role}${isSelected ? " selected" : ""}`}
      data-message-id={message.id}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({
          x: Math.min(event.clientX, window.innerWidth - 190),
          y: Math.min(event.clientY, window.innerHeight - 92),
        });
      }}
    >
      {emptySystemRow ? null : message.role === "user" ? (
        <UserBubble message={message} />
      ) : message.role === "assistant" ? (
        <AssistantProse message={message} agent={agent} explanation={explanation} />
      ) : message.uiHint === "handoff_notice" ? (
        <HandoffNotice message={message} />
      ) : (
        <div className="system-note">{message.text}</div>
      )}

      {onboardingHint === "onboarding_name_prompt" ? (
        <NamePrompt onSave={(name) => model.renameAgent(name)} />
      ) : null}

      {onboardingHint === "onboarding_completed" ? (
        <div className="onboarding-done">
          <Check size={12} />
          Renamed to {agent?.name ?? message.senderName ?? "your assistant"}
        </div>
      ) : null}

      {message.uiHint === "needs_input" && message.taskId && message.questionId ? (
        <TaskQuestion taskID={message.taskId} questionID={message.questionId} />
      ) : null}

      {menu ? (
        <>
          <div
            className="popover-backdrop"
            style={{ zIndex: 59 }}
            onClick={() => setMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu(null);
            }}
          />
          <div className="message-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onToggleSelect();
                setMenu(null);
              }}
            >
              {isSelected ? <Check size={12} /> : <TextCursor size={12} />}
              {isSelected ? "Deselect message" : "Select message"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void copyText(message.text);
                setMenu(null);
              }}
            >
              <Copy size={12} />
              Copy message
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="user-bubble">
      <div className="user-bubble-text"><MarkdownText text={message.text} /></div>
      {message.attachments?.map((attachment) => <AttachmentCard key={attachment.id} attachment={attachment} />)}
      {message.state.kind === "failed" ? (
        <div className="user-bubble-error">{message.state.reason}</div>
      ) : null}
    </div>
  );
}

function AssistantProse({
  message,
  agent,
  explanation,
}: {
  message: ChatMessage;
  agent: AgentInfo | null | undefined;
  explanation: string | null;
}) {
  const snapshot = useAppSnapshot();
  const failureText = explanation
    ? `No reply — ${explanation.toLowerCase()}.`
    : `${agent?.name ?? "The assistant"} produced no reply, and the daemon recorded no reason. Ask it to share this thread to see the records.`;

  const streaming = isStreaming(message);

  return (
    <div className="assistant-bubble">
      {message.text.length === 0 && streaming ? (
        <div className="thinking-pill">
          <ThinkingDots />
          Thinking
        </div>
      ) : message.text.length > 0 ? (
        <MarkdownText text={message.text} />
      ) : message.state.kind === "failed" ? (
        <div className="prose">{message.state.reason}</div>
      ) : (
        <div className="prose">{failureText}</div>
      )}

      {explanation && message.text.length > 0 ? (
        <div className="stop-explanation">Response didn't finish · {explanation}</div>
      ) : null}

      {message.tools.length > 0 && snapshot.preferences.showActivity ? (
        <ActivityStrip message={message} />
      ) : null}
    </div>
  );
}

/**
 * The activity strip: what the agent did, quietly. The transcript answers
 * "what did I ask and what came back" — this is the progress behind it, one
 * line until the owner wants to see it. It is here so the UI shows that
 * work is happening even when the model forgets to narrate.
 */
function ActivityStrip({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const tools = message.tools;
  const running = tools.find((tool) => tool.state === "running");
  const failed = tools.filter((tool) => tool.state === "failed").length;
  const summary = running
    ? `Working · ${running.name}`
    : `${tools.length} step${tools.length === 1 ? "" : "s"}${failed > 0 ? ` · ${failed} failed` : ""}`;
  return (
    <div className="activity-strip">
      <button type="button" className="activity-summary" onClick={() => setOpen(!open)}>
        {summary}
      </button>
      {open ? (
        <ul className="activity-list">
          {tools.map((tool) => (
            <li key={tool.id} className={tool.state}>
              <span className="activity-name">{tool.name}</span>
              {tool.preview ? <span className="activity-preview">{tool.preview}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * "Messaged  F.R.I.D.A.Y." — the agent's badge, and the name opens that
 * agent's chat. The brief the delegating agent wrote is internal routing; it
 * belongs in the tool call, not in the conversation.
 */
function HandoffNotice({ message }: { message: ChatMessage }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const target = message.toAgentId
    ? snapshot.mentionAgents.find((agent) => agent.id === message.toAgentId) ??
      snapshot.agents.find((agent) => agent.id === message.toAgentId)
    : undefined;
  if (!target) {
    return (
      <div className="handoff-notice">
        <span className="handoff-flow">{message.text}</span>
      </div>
    );
  }
  return (
    <div className="handoff-notice">
      <span className="handoff-flow">Messaged</span>
      <SidebarAgentBadge agent={target} size={16} />
      <button
        type="button"
        className="handoff-link"
        onClick={() => model.selectAgent(target)}
        aria-label={`Open ${target.name} chat`}
      >
        {target.name}
      </button>
    </div>
  );
}

function NamePrompt({ onSave }: { onSave: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onSave(trimmed);
    setName("");
  };
  return (
    <form className="onboarding-prompt" onSubmit={submit}>
      <input
        className="text-input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Type your preferred name…"
        aria-label="Preferred name"
      />
      <button type="submit" className="btn primary">
        Save
      </button>
    </form>
  );
}

/**
 * DEL-006: a delegated task asked the owner something. The answer goes back
 * through its own frame, so a normal message can never resume a task by
 * accident.
 */
function TaskQuestion({ taskID, questionID }: { taskID: string; questionID: string }) {
  const model = useAppModel();
  const [answer, setAnswer] = useState("");
  const [sent, setSent] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = answer.trim();
    if (trimmed.length === 0) return;
    model.answerTask(taskID, questionID, trimmed);
    setAnswer("");
    setSent(true);
  };
  if (sent) {
    return (
      <div className="task-answer-sent">
        <Check size={12} />
        Answer sent
      </div>
    );
  }
  return (
    <form className="task-question" onSubmit={submit}>
      <input
        className="text-input"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Answer the question…"
        aria-label="Answer the question"
      />
      <button type="submit" className="btn primary">
        Send
      </button>
    </form>
  );
}

function ThinkingDots() {  return (
    <span className="thinking-dots" aria-label="Agni is thinking">
      <span />
      <span />
      <span />
    </span>
  );
}
