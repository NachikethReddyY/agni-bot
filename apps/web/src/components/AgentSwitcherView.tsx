/**
 * Command/Ctrl-K: search the roster and the open conversation.
 *
 * The reference app searches everything from one field and groups what comes
 * back by kind. This does the same over what the browser actually holds: the
 * agents you can talk to, and the messages in the thread that is open. A
 * result you pick is taken to — an agent opens its chat, a message scrolls
 * the transcript to it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MessageSquare, Search } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { AgentAvatar, SidebarAgentBadge } from "./bits";

interface Result {
  kind: "agent" | "message";
  id: string;
  title: string;
  subtitle: string;
  agentID?: string;
}

export function AgentSwitcherView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo<Result[]>(() => {
    const needle = query.trim().toLowerCase();
    const agents: Result[] = snapshot.agents
      .filter((agent) => {
        if (needle.length === 0) return true;
        return `${agent.name} ${agent.role ?? ""} ${agent.model ?? ""}`.toLowerCase().includes(needle);
      })
      .map((agent) => ({
        kind: "agent",
        id: agent.id,
        title: agent.name,
        subtitle: agent.role ?? agent.model ?? "Assistant",
        agentID: agent.id,
      }));
    const messages: Result[] = needle.length === 0
      ? []
      : snapshot.conversation.messages
          .filter((message) => message.text.trim().length > 0)
          .filter((message) => message.text.toLowerCase().includes(needle))
          .slice(-12)
          .reverse()
          .map((message) => ({
            kind: "message",
            id: message.id,
            title: message.text.trim().slice(0, 120),
            subtitle: message.role === "user" ? "You" : message.senderName ?? "The assistant",
          }));
    return [...agents, ...messages];
  }, [query, snapshot.agents, snapshot.conversation.messages]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const chosen = results[highlight];

  const choose = (result: Result | undefined): void => {
    if (!result) return;
    if (result.kind === "agent") {
      const agent = snapshot.agents.find((candidate) => candidate.id === result.agentID);
      if (agent) model.selectAgent(agent);
    } else {
      model.focusMessage(result.id);
    }
    model.closeAgentSwitcher();
  };

  return (
    <div
      className="overlay search-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) model.closeAgentSwitcher();
      }}
    >
      <div className="search-dialog" role="dialog" aria-label="Search">
        <div className="search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlight((index) => Math.min(index + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlight((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(chosen);
              }
            }}
            placeholder="Search agents and messages"
            aria-label="Search agents and messages"
          />
        </div>

        <div className="search-results">
          {results.length === 0 ? (
            <div className="search-empty">Nothing matches “{query.trim()}”.</div>
          ) : (
            <>
              {results.some((result) => result.kind === "agent") ? (
                <div className="search-group">
                  <div className="search-group-title">Agents</div>
                  {results
                    .filter((result) => result.kind === "agent")
                    .map((result) => {
                      const agent = snapshot.agents.find((candidate) => candidate.id === result.agentID);
                      const selected = snapshot.conversation.agentID === result.agentID;
                      const index = results.indexOf(result);
                      return (
                        <button
                          type="button"
                          key={result.id}
                          className={`search-row${index === highlight ? " highlighted" : ""}`}
                          onMouseEnter={() => setHighlight(index)}
                          onClick={() => choose(result)}
                        >
                          {agent ? (
                            <SidebarAgentBadge agent={agent} size={28} />
                          ) : (
                            <AgentAvatar agent={null} size="small" />
                          )}
                          <span className="search-row-text">
                            <span className="search-row-title">{result.title}</span>
                            <span className="search-row-subtitle">{result.subtitle}</span>
                          </span>
                          {selected ? <Check size={13} className="search-row-check" /> : null}
                        </button>
                      );
                    })}
                </div>
              ) : null}

              {results.some((result) => result.kind === "message") ? (
                <div className="search-group">
                  <div className="search-group-title">Messages</div>
                  {results
                    .filter((result) => result.kind === "message")
                    .map((result) => {
                      const index = results.indexOf(result);
                      return (
                        <button
                          type="button"
                          key={result.id}
                          className={`search-row${index === highlight ? " highlighted" : ""}`}
                          onMouseEnter={() => setHighlight(index)}
                          onClick={() => choose(result)}
                        >
                          <span className="search-row-icon">
                            <MessageSquare size={13} />
                          </span>
                          <span className="search-row-text">
                            <span className="search-row-title">{result.title}</span>
                            <span className="search-row-subtitle">{result.subtitle}</span>
                          </span>
                        </button>
                      );
                    })}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
