/**
 * The roster: every agent, pinned ones first, each with its tag and the last
 * thing it said. On a phone it is the same list in a drawer.
 *
 * Each agent has one enduring conversation surface; sessions are seams in it,
 * not list entries (blueprint v3 §5).
 */
import { useState } from "react";
import { Plus, Search, Star, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { AppTile, SidebarAgentBadge, connectionShortStatus, initials } from "./bits";

function stateLabel(state: string): string {
  if (state === "working") return "Working";
  if (state === "waiting") return "Waiting for you";
  if (state === "blocked") return "Blocked";
  return "Idle";
}

export function SidebarView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [creating, setCreating] = useState(false);

  // Pinned agents go into the grid at the top; the rest keep the roster's
  // order in the list below.
  const pinned = new Set(snapshot.preferences.favorites);
  const roster = model.filteredAgents;
  const favourites = roster.filter((agent) => pinned.has(agent.id));
  const others = roster.filter((agent) => !pinned.has(agent.id));
  const connected = snapshot.plugins.filter((plugin) => plugin.status === "connected");
  const total = snapshot.plugins.length;
  const owner = profileName(snapshot.settings.deviceName);

  /** The newest thing each agent said, one line. */
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

  const row = (agent: (typeof roster)[number]) => {
    const selected = snapshot.conversation.agentID === agent.id;
    // A private agent is worth saying out loud: other agents see a
    // receipt for its work, not the work itself.
    const state = snapshot.agentStates[agent.id];
    const visibilityNote =
      agent.visibility === "private"
        ? " · private"
        : agent.visibility === "summary"
          ? " · summary"
          : "";
    const preview = previewFor(agent.id);
    return (
      <button
        type="button"
        key={agent.id}
        className={`sidebar-row${selected ? " selected" : ""}`}
        onClick={() => model.selectAgent(agent)}
        aria-label={`Open ${agent.name} chat`}
        aria-current={selected ? "true" : undefined}
        title={
          agent.visibility
            ? `${agent.name} — other agents see ${agent.visibility} of its work`
            : undefined
        }
      >
        <SidebarAgentBadge agent={agent} size={36} />
        <span className="sidebar-row-text">
          <span className="sidebar-row-top">
            <span className="sidebar-row-title">{agent.name}</span>
            {agent.role ? <span className="sidebar-tag-chip">{agent.role}</span> : null}
          </span>
          <span className="sidebar-row-subtitle">
            {preview ?? agent.role ?? agent.model ?? "Assistant"}
            {visibilityNote}
          </span>
        </span>
        <span
          className={`sidebar-star${snapshot.preferences.favorites.includes(agent.id) ? " on" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={
            snapshot.preferences.favorites.includes(agent.id)
              ? `Unpin ${agent.name}`
              : `Pin ${agent.name}`
          }
          onClick={(event) => {
            event.stopPropagation();
            model.toggleFavorite(agent.id);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            model.toggleFavorite(agent.id);
          }}
        >
          <Star size={13} />
        </span>
        {model.unreadBlocks(agent.id) ? <span className="unread-dot" aria-label="Unread" /> : null}
        {state && state !== "idle" ? (
          <span className={`agent-state ${state}`} aria-label={state} title={stateLabel(state)} />
        ) : null}
      </button>
    );
  };

  return (
    <aside className={`sidebar${snapshot.isSidebarPresented ? " open" : ""}`}>
      <div className="sidebar-bar">
        <span className="sidebar-bar-spacer" />
        <button
          type="button"
          className="icon-btn"
          aria-label="Search agents and messages"
          onClick={() => model.openAgentSwitcher()}
        >
          <Search size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Create an agent"
          onClick={() => setCreating(true)}
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          className="icon-btn sidebar-close"
          aria-label="Close the agent list"
          onClick={() => model.closeSidebar()}
        >
          <X size={16} />
        </button>
      </div>

      <div className="sidebar-sections">
        {favourites.length > 0 ? (
          <div className="sidebar-grid">
            {favourites.map((agent) => {
              const selected = snapshot.conversation.agentID === agent.id;
              return (
                <button
                  type="button"
                  key={agent.id}
                  className={`sidebar-tile${selected ? " selected" : ""}`}
                  onClick={() => model.selectAgent(agent)}
                  aria-label={`Open ${agent.name} chat`}
                  aria-current={selected ? "true" : undefined}
                >
                  <span className="sidebar-tile-mark">
                    <SidebarAgentBadge agent={agent} size={44} />
                    <span className="sidebar-tile-star" aria-label="Favourite">
                      <Star size={10} />
                    </span>
                  </span>
                  <span className="sidebar-tile-name">{agent.name}</span>
                  {agent.role ? <span className="sidebar-tile-tag">{agent.role}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {others.length === 0 ? (
          <div className="sidebar-empty">
            {snapshot.searchText.trim().length === 0 ? "No agents available" : "No matching agents"}
          </div>
        ) : (
          others.map(row)
        )}
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-owner-row">
          <button
            type="button"
            className="sidebar-owner"
            onClick={() => model.openSettings()}
            title={`${owner} — settings`}
            aria-label={`Open settings for ${owner}`}
          >
            <span className="sidebar-owner-avatar">{initials(owner)}</span>
          </button>
          {snapshot.connectionState.kind !== "ready" ? (
            <span
              className="presence-dot"
              style={{ background: "#f0a04b" }}
              title={connectionShortStatus(snapshot.connectionState)}
            />
          ) : null}
        </div>

        <button
          type="button"
          className="connect-apps"
          onClick={() => model.openSettings()}
          title={`Connect apps — ${connected.length} of ${total} connected`}
          aria-label="Connect apps"
        >
          <span className="connect-apps-label">Connect apps</span>
          {connected.length > 0 ? (
            <span className="connect-apps-icons">
              {connected.map((plugin) => (
                <AppTile key={`${plugin.id}_${plugin.account}`} plugin={plugin} />
              ))}
            </span>
          ) : null}
        </button>
      </div>

      {creating ? <NewAgentSheet onClose={() => setCreating(false)} /> : null}
    </aside>
  );
}

/**
 * The "+" in the roster: name the agent, say what it is for, say what it
 * should do. The daemon creates it the same way the `create_agent` chat tool
 * does, so it lands in the roster with a prompt and a colour.
 */
function NewAgentSheet({ onClose }: { onClose: () => void }) {
  const model = useAppModel();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [prompt, setPrompt] = useState("");
  const ready = name.trim().length > 0 && prompt.trim().length > 0;

  return (
    <div
      className="overlay new-agent-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-label="New agent">
        <div className="dialog-head">
          <h2>New agent</h2>
          <button type="button" className="icon-btn" aria-label="Cancel" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="text-input"
            value={name}
            maxLength={64}
            placeholder="FRIDAY"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Tag</span>
          <input
            className="text-input"
            value={role}
            maxLength={160}
            placeholder="inbox manager"
            onChange={(event) => setRole(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">What it should do</span>
          <textarea
            className="text-area"
            rows={4}
            value={prompt}
            maxLength={8000}
            placeholder="You are FRIDAY. You read my inbox, draft replies, and never send without asking."
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!ready}
            onClick={() => {
              model.createAgent({ name, prompt, role });
              onClose();
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function profileName(deviceName: string): string {
  const marker = deviceName.indexOf("'s ");
  if (marker >= 0) return deviceName.slice(0, marker);
  return deviceName.trim().length === 0 ? "This Browser" : deviceName;
}
