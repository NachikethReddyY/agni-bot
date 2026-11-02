/**
 * Seamless chat header: the current agent at left and connection details at
 * right. Task navigation lives in the sidebar.
 */
import { useState, type ReactNode } from "react";
import { Menu, Monitor } from "lucide-react";
import { format } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import {
  PresenceDot,
  SidebarAgentBadge,
  connectionTitle,
} from "./bits";

export function ThreadHeader() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const agent = model.agent;
  const agentState = agent ? snapshot.agentStates[agent.id] : undefined;
  const working = snapshot.conversation.isStreaming || agentState === "working";

  return (
    <header className="thread-header">
      <button
        type="button"
        className="icon-btn header-menu mobile-only"
        aria-label="Open the agent list"
        onClick={() => model.openSidebar()}
      >
        <Menu size={17} />
      </button>
      <button
        type="button"
        className="agent-pill"
        aria-label={`Open ${agent?.name ?? "the agent"}'s profile`}
        onClick={() => model.openAgentProfile()}
      >
        <span className="agent-pill-avatar">
          <SidebarAgentBadge agent={agent} size={22} />
          {working ? <span className="agent-pill-dot" aria-label="Working" /> : null}
        </span>
        <span className="agent-pill-name">{agent?.name ?? "Agni"}</span>
      </button>
      <span className="thread-header-spacer" />

      <button
        type="button"
        className="icon-btn"
        title="Server connection"
        aria-label="Server connection details"
        onClick={() => {
          setConnectionOpen((open) => !open);
        }}
      >
        <Monitor size={14} />
      </button>

      {connectionOpen ? (
        <HeaderPopover onClose={() => setConnectionOpen(false)}>
          <h3 style={{ marginBottom: 10 }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <PresenceDot online={snapshot.connectionState.kind === "ready"} />
              {connectionTitle(snapshot.connectionState)}
            </span>
          </h3>
          <div className="popover-body">
            <span className="machine" style={{ color: "var(--ink-secondary)", userSelect: "text" }}>
              {snapshot.settings.url}
            </span>
            {snapshot.health ? (
              <p>
                {format.uptime(snapshot.health.uptimeMs)} ·{" "}
                {snapshot.health.providers.filter((provider) => provider.available).length} of{" "}
                {snapshot.health.providers.length} providers available
              </p>
            ) : snapshot.healthError ? (
              <p className="warning-text">{snapshot.healthError}</p>
            ) : null}
            <button
              type="button"
              className="link"
              style={{ alignSelf: "flex-start" }}
              onClick={() => {
                setConnectionOpen(false);
                model.editConnection();
              }}
            >
              Connection settings…
            </button>
          </div>
        </HeaderPopover>
      ) : null}
    </header>
  );
}

function HeaderPopover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="popover-backdrop" onClick={onClose} />
      <div className="popover" role="dialog">
        {children}
      </div>
    </>
  );
}
