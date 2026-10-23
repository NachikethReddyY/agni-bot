/**
 * Seamless chat header: the current agent at left, connection details and the
 * conversation export on demand at right.
 */
import { useState, type ReactNode } from "react";
import { Copy, Menu, Monitor, Share } from "lucide-react";
import { format } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import {
  PresenceDot,
  SidebarAgentBadge,
  Spinner,
  connectionTitle,
  copyText,
} from "./bits";

export function ThreadHeader() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [shareOpen, setShareOpen] = useState(false);
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
        title="Share this conversation as a document"
        aria-label="Export this conversation"
        onClick={() => {
          model.exportConversation();
          setConnectionOpen(false);
          setShareOpen(true);
        }}
      >
        <Share size={14} />
      </button>

      <button
        type="button"
        className="icon-btn"
        title="Server connection"
        aria-label="Server connection details"
        onClick={() => {
          setShareOpen(false);
          setConnectionOpen((open) => !open);
        }}
      >
        <Monitor size={14} />
      </button>

      {shareOpen ? (
        <HeaderPopover onClose={() => setShareOpen(false)}>
          <h3>Share this conversation</h3>
          <div className="popover-body">
            {snapshot.isExporting ? (
              <div className="popover-row">
                <Spinner />
                <span className="muted">Rendering the document…</span>
              </div>
            ) : snapshot.exportError ? (
              <p className="warning-text">{snapshot.exportError}</p>
            ) : snapshot.exportedLink ? (
              <>
                <p>
                  A single HTML file with everything in this conversation — what was said,
                  what was run, and what was asked for approval.
                </p>
                <code className="machine" style={{ overflowWrap: "anywhere", userSelect: "text" }}>
                  {snapshot.exportedLink.url}
                </code>
                <span className="tertiary" style={{ fontSize: 11 }}>
                  {snapshot.exportedLink.records} records
                </span>
                <div className="popover-actions">
                  <button
                    type="button"
                    className="btn primary small"
                    onClick={() => {
                      if (snapshot.exportedLink) void copyText(snapshot.exportedLink.url);
                    }}
                  >
                    <Copy size={11} /> Copy link
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      if (snapshot.exportedLink) {
                        window.open(snapshot.exportedLink.url, "_blank", "noopener,noreferrer");
                      }
                    }}
                  >
                    Open
                  </button>
                </div>
              </>
            ) : (
              <p>Render the open conversation to a document the daemon can hand out.</p>
            )}
          </div>
        </HeaderPopover>
      ) : null}

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
