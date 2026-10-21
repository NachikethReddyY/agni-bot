/**
 * The roster, and nothing else. Each agent has one enduring conversation
 * surface; sessions are seams in it, not list entries (blueprint v3 §5).
 */
import { Search, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { AppTile, SidebarAgentBadge, connectionShortStatus, initials } from "./bits";

export function SidebarView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const agents = model.filteredAgents;
  const connected = snapshot.plugins.filter((plugin) => plugin.status === "connected");
  const total = snapshot.plugins.length;
  const owner = profileName(snapshot.settings.deviceName);

  return (
    <aside className="sidebar">
      <div className="sidebar-header" />

      <div className="sidebar-search">
        <Search size={12} aria-hidden="true" />
        <input
          value={snapshot.searchText}
          onChange={(event) => model.setSearchText(event.target.value)}
          placeholder="Search"
          aria-label="Search agents"
        />
        {snapshot.searchText.length > 0 ? (
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear search"
            onClick={() => model.setSearchText("")}
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <div className="sidebar-sections">
        <div className="sidebar-section-title">Agents</div>
        {agents.length === 0 ? (
          <div className="sidebar-empty">
            {snapshot.searchText.trim().length === 0 ? "No agents available" : "No matching agents"}
          </div>
        ) : (
          agents.map((agent) => {
            const selected = snapshot.conversation.agentID === agent.id;
            // A private agent is worth saying out loud: other agents see a
            // receipt for its work, not the work itself.
            const visibilityNote =
              agent.visibility === "private"
                ? " · private"
                : agent.visibility === "summary"
                  ? " · summary"
                  : "";
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
                  <span className="sidebar-row-title">{agent.name}</span>
                  <span className="sidebar-row-subtitle">
                    {agent.role ?? agent.model ?? "Assistant"}
                    {visibilityNote}
                  </span>
                </span>
                {model.unreadBlocks(agent.id) ? <span className="unread-dot" aria-label="Unread" /> : null}
              </button>
            );
          })
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-owner"
          onClick={() => model.openSettings()}
          title={`${owner} — settings`}
          aria-label={`Open settings for ${owner}`}
        >
          <span className="sidebar-owner-avatar">{initials(owner)}</span>
          {snapshot.connectionState.kind !== "ready" ? (
            <span
              className="presence-dot"
              style={{ background: "#f0a04b" }}
              title={connectionShortStatus(snapshot.connectionState)}
            />
          ) : null}
        </button>

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
    </aside>
  );
}

function profileName(deviceName: string): string {
  const marker = deviceName.indexOf("'s ");
  if (marker >= 0) return deviceName.slice(0, marker);
  return deviceName.trim().length === 0 ? "This Browser" : deviceName;
}
