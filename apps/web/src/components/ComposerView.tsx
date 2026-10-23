/**
 * A full-width, bottom-anchored chat composer with slash commands above it.
 * Enter sends; Shift-Enter inserts a newline; the composer stays a single quiet capsule.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Mic, Plus, UserRound, Paperclip, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type AttachmentInfo } from "@agni/client";

interface DraftAttachment { id: string; file: File; preview?: string; uploaded?: AttachmentInfo; }

interface Command {
  trigger: string;
  title: string;
  subtitle: string;
  action: () => void;
}

export function ComposerView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [error, setError] = useState<string>();
  const [uploadStatus, setUploadStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => () => {
    for (const item of attachmentsRef.current) if (item.preview) URL.revokeObjectURL(item.preview);
  }, []);
  const [actionsOpen, setActionsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const focusToken = useRef(snapshot.focusComposerToken);
  const isStreaming = snapshot.conversation.isStreaming;
  const trimmed = draft.trim();

  const commands: Command[] = [
    {
      trigger: "agent",
      title: "Switch agent…",
      subtitle: "Another conversation surface",
      action: () => model.openAgentSwitcher(),
    },
  ];

  const filtered = trimmed.startsWith("/")
    ? commands.filter((command) => {
        const term = trimmed.slice(1).toLowerCase();
        return command.trigger.startsWith(term) || command.title.toLowerCase().includes(term);
      })
    : [];

  useEffect(() => {
    if (snapshot.focusComposerToken === focusToken.current) return;
    focusToken.current = snapshot.focusComposerToken;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [snapshot.focusComposerToken]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  useEffect(
    () => () => {
      model.updateTypingState(false);
    },
    [model],
  );

  const addFiles = (files: File[]) => {
    if (sendingRef.current) return;
    setError(undefined);
    if (attachmentsRef.current.length + files.length > MAX_ATTACHMENTS) {
      setError("Attach up to five files per message."); return;
    }
    if (files.some((file) => !file.size || file.size > MAX_ATTACHMENT_BYTES)) {
      setError("Each file must be between 1 byte and 10 MB."); return;
    }
    const accepted = /\.(png|jpe?g|webp|pdf|txt|md|markdown|csv|jsonl?|tsx?|jsx?|py|rs|go|java|c|h|cpp|css|html|xml|ya?ml|toml|sql|sh|swift|kt|log)$/i;
    if (files.some((file) => !accepted.test(file.name))) {
      setError("Use PNG, JPEG, WebP, PDF, or a text/source file."); return;
    }
    const added = files.map((file) => ({ id: crypto.randomUUID(), file,
      ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
    }));
    setAttachments((current) => [...current, ...added]);
  };

  const removeAttachment = (item: DraftAttachment) => {
    if (sendingRef.current) return;
    if (item.preview) URL.revokeObjectURL(item.preview);
    if (item.uploaded) void model.removeDraftAttachment(item.uploaded.id).catch(() => undefined);
    setAttachments((current) => current.filter((file) => file.id !== item.id));
    setError(undefined);
  };

  const submit = async () => {
    if (sendingRef.current || (!trimmed && attachments.length === 0)) return;
    // Only recognised slash commands are consumed; paths and unknown commands remain messages.
    if (trimmed.startsWith("/") && filtered[0] && attachments.length === 0) {
      filtered[0].action(); setDraft(""); model.updateTypingState(false); return;
    }
    sendingRef.current = true;
    setSending(true); setError(undefined);
    try {
      if (attachments.length) {
        const uploaded: AttachmentInfo[] = [];
        for (const [index, item] of attachments.entries()) {
          setUploadStatus(`Preparing file ${index + 1} of ${attachments.length}…`);
          const info = item.uploaded ?? await model.uploadAttachment(item.file);
          // Keep completed uploads on retry; do not upload the same bytes twice.
          item.uploaded = info;
          setAttachments((current) => current.map((value) => value.id === item.id ? { ...value, uploaded: info } : value));
          uploaded.push(info);
        }
        setUploadStatus("Sending…");
        await model.sendAttachments(draft, uploaded, snapshot.conversation.agentID);
      } else if (!model.send(draft)) {
        throw new Error("Not connected. Your draft has been kept; try again after reconnecting.");
      }
      for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      setAttachments([]); setDraft(""); model.updateTypingState(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not send. Try again.");
    } finally {
      sendingRef.current = false; setSending(false); setUploadStatus("");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) void submit();
    }
  };

  return (
    <div className="composer-zone" onDragOver={(event) => {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    }} onDrop={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault(); addFiles(Array.from(event.dataTransfer.files));
    }}>
      <input type="file" hidden multiple ref={fileInputRef} aria-label="Attach files"
        accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.markdown,.csv,.json,.jsonl,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.h,.cpp,.css,.html,.xml,.yaml,.yml,.toml,.sql,.sh,.swift,.kt,.log"
        onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      {attachments.length ? <div className="draft-attachments">{attachments.map((item) => <div className="draft-attachment" key={item.id}>
        {item.preview ? <img src={item.preview} alt={item.file.name} /> : <Paperclip size={18} />}
        <span>{item.file.name}<small>{Math.max(1, Math.ceil(item.file.size / 1024))} KB{item.uploaded ? " · Ready" : ""}</small></span>
        <button type="button" disabled={sending} aria-label={`Remove ${item.file.name}`} onClick={() => removeAttachment(item)}><X size={14} /></button>
      </div>)}</div> : null}
      {error ? <div className="composer-error" role="alert">{error}</div> : null}
      {sending ? <div className="composer-hint" role="status">{uploadStatus}</div> : null}
      {filtered.length > 0 ? (
        <div className="slash-menu" role="listbox">
          {filtered.map((command) => (
            <button
              type="button"
              key={command.trigger}
              className="slash-item"
              onClick={() => {
                setDraft("");
                command.action();
              }}
            >
              <span className="slash-trigger">/{command.trigger}</span>
              <span>{command.title}</span>
              <span className="slash-subtitle">{command.subtitle}</span>
            </button>
          ))}
        </div>
      ) : null}

      {actionsOpen ? (
        <>
          <div className="popover-backdrop" style={{ zIndex: 20 }} onClick={() => setActionsOpen(false)} />
          <div className="composer-popover" role="menu">
            <button type="button" role="menuitem" disabled={sending} onClick={() => {
              setActionsOpen(false); fileInputRef.current?.click();
            }}><Paperclip size={13} />Attach files…</button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setActionsOpen(false);
                model.openAgentSwitcher();
              }}
            >
              <UserRound size={13} />
              Switch agent…
            </button>
          </div>
        </>
      ) : null}

      <div className="composer">
        <button
          type="button"
          className="composer-plus"
          title="Conversation actions"
          aria-label="Conversation actions"
          onClick={() => setActionsOpen((open) => !open)}
        >
          <Plus size={14} />
        </button>

        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={draft}
          disabled={sending}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length) { event.preventDefault(); addFiles(files); }
          }}
          onChange={(event) => {
            setDraft(event.target.value);
            model.updateTypingState(event.target.value.trim().length > 0);
          }}
          onKeyDown={onKeyDown}
          placeholder={isStreaming ? "Agni is working — send “stop” to interrupt" : `Message ${model.agent?.name ?? "Agni"}`}
          aria-label={isStreaming ? "Agni is working; send stop to interrupt" : `Message ${model.agent?.name ?? "Agni"}`}
        />

        {isStreaming ? (
          <button
            type="button"
            className="composer-stop"
            title="Stop this turn (⌘.) — or send “stop”"
            aria-label="Stop"
            onClick={() => model.stopTurn()}
          >
            <span
              aria-hidden="true"
              style={{ width: 10, height: 10, borderRadius: 2, background: "currentColor" }}
            />
          </button>
        ) : null}
        <button
          type="button"
          className={`composer-send${trimmed.length === 0 && attachments.length === 0 ? " is-mic" : ""}`}
          disabled={sending || (trimmed.length === 0 && attachments.length === 0)}
          title="Send (Enter); new line (Shift+Enter)"
          aria-label="Send"
          onClick={() => void submit()}
        >
          {trimmed.length === 0 && attachments.length === 0 ? <Mic size={14} /> : <ArrowUp size={15} strokeWidth={2.4} />}
        </button>
      </div>
      <div className="composer-hint">Enter to send · Shift+Enter for a new line · Drop files here</div>
    </div>
  );
}
