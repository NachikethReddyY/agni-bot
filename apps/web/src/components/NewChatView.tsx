/**
 * New chat: pressing the roster's "+" clears the conversation and puts the
 * recipient where the agent's name was.
 *
 * One field searches the agents you can message, and the first row makes a new
 * one on the spot — no form to fill in first. The bot that appears is literally
 * named "New bot"; it is named afterwards, by telling it in chat or from its
 * profile. It is a place in the chat column, not a dialog floating over one
 * (blueprint v3 §5).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Plus, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { SidebarAgentBadge } from "./bits";

export function NewChatView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);

  /** The roster, pinned agents first — the same order the sidebar keeps. */
  const agents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = snapshot.agents.filter(
      (agent) =>
        needle.length === 0 ||
        `${agent.name} ${agent.role ?? ""} ${agent.model ?? ""}`.toLowerCase().includes(needle),
    );
    const pinned = new Set(snapshot.preferences.favorites);
    return [
      ...matching.filter((agent) => pinned.has(agent.id)),
      ...matching.filter((agent) => !pinned.has(agent.id)),
    ];
  }, [query, snapshot.agents, snapshot.preferences.favorites]);

  /** The newest thing each agent said, one line — the way the roster reads. */
  const previewFor = (agentID: string): string | undefined => {
    let newest: { updatedAt: string; preview?: string } | undefined;
    for (const thread of snapshot.threads) {
      if (thread.agentID !== agentID) continue;
      if (!newest || thread.updatedAt > newest.updatedAt) {
        newest = { updatedAt: thread.updatedAt, preview: thread.preview };
      }
    }
    return newest?.preview;
  };

  // Every open starts clean, so a half-typed search never reappears later.
  useEffect(() => {
    setQuery("");
    setHighlight(0);
    const frame = requestAnimationFrame(() => queryRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const close = () => model.closeNewChat();

  // Row 0 makes a new bot; the roster follows, so arrow keys walk one list.
  const choose = (index: number) => {
    if (index === 0) {
      // The pane closes itself once the new agent is the conversation.
      model.startNewAgent();
      return;
    }
    const agent = agents[index - 1];
    if (!agent) return;
    model.selectAgent(agent);
    close();
  };

  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const total = agents.length + 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (index + 1) % total);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) => (index - 1 + total) % total);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(highlight);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div className="new-chat">
      <div className="new-chat-surface">
        <span className="new-chat-label">To:</span>
        <input
          ref={queryRef}
          className="new-chat-input"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="new-chat-results"
          aria-autocomplete="list"
          aria-activedescendant={`new-chat-option-${highlight}`}
          aria-label="Start a chat with"
          placeholder="Search agents, or start a new one"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onQueryKeyDown}
        />
        <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
          <X size={15} />
        </button>
      </div>

      <div className="new-chat-list">
        <div className="new-chat-rows" id="new-chat-results" role="listbox" aria-label="Start a chat">
          <button
            type="button"
            role="option"
            id="new-chat-option-0"
            aria-selected={highlight === 0}
            className={`new-chat-row${highlight === 0 ? " highlighted" : ""}`}
            onMouseEnter={() => setHighlight(0)}
            onClick={() => choose(0)}
          >
            <span className="new-chat-row-icon">
              <Plus size={15} />
            </span>
            <span className="new-chat-row-text">
              <span className="new-chat-row-title">New bot</span>
              <span className="new-chat-row-subtitle">Starts as “New bot” — name it in chat or its profile</span>
            </span>
          </button>

          <div className="new-chat-separator" role="separator" />

          {agents.length === 0 ? (
            <div className="new-chat-empty">No agents match “{query.trim()}”.</div>
          ) : (
            agents.map((agent, index) => {
              const selected = snapshot.conversation.agentID === agent.id;
              const subtitle = previewFor(agent.id) ?? agent.role ?? agent.model ?? "Assistant";
              return (
                <button
                  type="button"
                  role="option"
                  id={`new-chat-option-${index + 1}`}
                  aria-selected={highlight === index + 1}
                  key={agent.id}
                  className={`new-chat-row${highlight === index + 1 ? " highlighted" : ""}${
                    selected ? " selected" : ""
                  }`}
                  onMouseEnter={() => setHighlight(index + 1)}
                  onClick={() => choose(index + 1)}
                >
                  <SidebarAgentBadge agent={agent} size={26} />
                  <span className="new-chat-row-text">
                    <span className="new-chat-row-title">{agent.name}</span>
                    <span className="new-chat-row-subtitle">{subtitle}</span>
                  </span>
                  {selected ? <Check size={13} className="new-chat-row-check" /> : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
