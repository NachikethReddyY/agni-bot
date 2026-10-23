/**
 * The roster: every agent, pinned ones first, each with its tag and the last
 * thing it said. On a phone it is the same list in a drawer.
 *
 * Each agent has one enduring conversation surface; sessions are seams in it,
 * not list entries (blueprint v3 §5).
 */
import { CalendarDays, CheckCircle2, CheckSquare, Clock3, Inbox, Plus, Search, Star, X } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
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
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const [collectionName, setCollectionName] = useState("");

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
          className={`icon-btn${snapshot.isTasksPresented ? " active" : ""}`}
          aria-pressed={snapshot.isTasksPresented}
          title={snapshot.isTasksPresented ? "Show agents" : "Show tasks and reminders"}
          aria-label={snapshot.isTasksPresented ? "Show agents" : "Show tasks and reminders"}
          onClick={() => model.toggleTasks()}
        >
          <CheckSquare size={15} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Search agents and messages"
          onClick={() => model.openAgentSwitcher()}
        >
          <Search size={15} />
        </button>
        {!snapshot.isTasksPresented ? <button
          type="button"
          className="icon-btn"
          aria-label="Start a new chat"
          title="New chat"
          onClick={() => model.openNewChat()}
        >
          <Plus size={15} />
        </button> : null}
        <button
          type="button"
          className="icon-btn sidebar-close"
          aria-label="Close the agent list"
          onClick={() => model.closeSidebar()}
        >
          <X size={16} />
        </button>
      </div>

      {snapshot.isTasksPresented ? (
        <div className="sidebar-sections task-nav">
          <div className="task-nav-primary">
            <TaskNavButton icon={<CalendarDays size={16} />} label="Today" count={snapshot.tasks.filter((task) => { const at = task.dueAt ?? task.reminderAt; return task.status !== "done" && !!at && new Date(at).setHours(0,0,0,0) <= new Date().setHours(0,0,0,0); }).length} selected={snapshot.taskView.kind === "today"} onClick={() => { model.selectTaskView({ kind: "today" }); model.closeSidebar(); }} />
            <TaskNavButton icon={<Inbox size={16} />} label="Inbox" count={snapshot.tasks.filter((task) => task.listID === "lst_inbox" && task.status !== "done").length} selected={snapshot.taskView.kind === "inbox"} onClick={() => { model.selectTaskView({ kind: "inbox" }); model.closeSidebar(); }} />
            <TaskNavButton icon={<Clock3 size={16} />} label="Upcoming" count={snapshot.tasks.filter((task) => task.status !== "done" && !!(task.dueAt ?? task.reminderAt) && new Date(task.dueAt ?? task.reminderAt!).setHours(0,0,0,0) > new Date().setHours(0,0,0,0)).length} selected={snapshot.taskView.kind === "upcoming"} onClick={() => { model.selectTaskView({ kind: "upcoming" }); model.closeSidebar(); }} />
            <TaskNavButton icon={<CalendarDays size={16} />} label="Calendar" selected={snapshot.taskView.kind === "calendar"} onClick={() => { model.selectTaskView({ kind: "calendar" }); model.closeSidebar(); }} />
            <TaskNavButton icon={<CheckCircle2 size={16} />} label="Completed" count={snapshot.tasks.filter((task) => task.status === "done").length} selected={snapshot.taskView.kind === "completed"} onClick={() => { model.selectTaskView({ kind: "completed" }); model.closeSidebar(); }} />
          </div>
          <div className="task-nav-list-heading">
            <span>Collections</span>
            <button type="button" className="icon-btn" aria-label="Create a collection" title="Create a collection" onClick={() => setNewCollectionOpen(true)}><Plus size={15} /></button>
          </div>
          {snapshot.taskLists.filter((list) => list.id !== "lst_inbox").map((list) => (
            <TaskNavButton key={list.id} icon={<span className="task-list-mark" />} label={list.name} count={list.taskCount} selected={snapshot.taskView.kind === "list" && snapshot.taskView.listID === list.id} onClick={() => { model.selectTaskView({ kind: "list", listID: list.id }); model.closeSidebar(); }} />
          ))}
        </div>
      ) : <div className="sidebar-sections">
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
      </div>}

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
      {newCollectionOpen ? <div className="collection-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setNewCollectionOpen(false); }}><form className="collection-dialog" onSubmit={(event: FormEvent) => { event.preventDefault(); if (!collectionName.trim()) return; model.createTaskList(collectionName); setCollectionName(""); setNewCollectionOpen(false); }}><h2>New collection</h2><p>Group related tasks together.</p><input autoFocus className="text-input" maxLength={80} placeholder="Collection name" value={collectionName} onChange={(event) => setCollectionName(event.target.value)} /><div className="collection-dialog-actions"><button type="button" className="btn" onClick={() => setNewCollectionOpen(false)}>Cancel</button><button type="submit" className="btn primary" disabled={!collectionName.trim()}>Create collection</button></div></form></div> : null}
    </aside>
  );
}

function TaskNavButton({ icon, label, count, selected, onClick }: { icon: ReactNode; label: string; count?: number; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`task-nav-row${selected ? " selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={onClick}>
      <span className="task-nav-icon">{icon}</span><span className="task-nav-label">{label}</span>{count !== undefined ? <span className="task-nav-count">{count}</span> : null}
    </button>
  );
}

function profileName(deviceName: string): string {
  const marker = deviceName.indexOf("'s ");
  if (marker >= 0) return deviceName.slice(0, marker);
  return deviceName.trim().length === 0 ? "This Browser" : deviceName;
}
