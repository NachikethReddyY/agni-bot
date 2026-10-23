/**
 * The agent's own panel: who it is, what it is for, and what it has been
 * doing.
 *
 * The reference app opens a side panel from the agent's pill — a big mark,
 * the name, the role under it, and tabs. This one does the same and every
 * field in it is real: the name goes through the same rename the chat tool
 * uses, the tag is the role the roster already shows, and the visibility
 * decides what other agents may see of its work.
 */
import { useEffect, useState } from "react";
import { Check, Link2, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { SidebarAgentBadge } from "./bits";

type Tab = "details" | "activity";

const VISIBILITIES: { id: "private" | "summary" | "shared"; label: string; note: string }[] = [
  { id: "private", label: "Private", note: "Other agents see only that it worked." },
  { id: "summary", label: "Summary", note: "Other agents see a one-line summary." },
  { id: "shared", label: "Shared", note: "Other agents see the whole answer." },
];

export function AgentProfileView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const agent = model.agent;
  const [tab, setTab] = useState<Tab>("details");
  const [name, setName] = useState(agent?.name ?? "");
  const [tag, setTag] = useState(agent?.role ?? "");
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setName(agent?.name ?? "");
    setTag(agent?.role ?? "");
  }, [agent?.id, agent?.name, agent?.role]);

  if (!agent) return null;

  const tasks = snapshot.tasks.filter((task) => task.ownerAgentId === agent.id);
  const visibility = agent.visibility ?? "summary";

  return (
    <aside className="profile-panel" aria-label={`${agent.name} profile`}>
      <div className="profile-top">
        <span className="profile-top-title">Agent</span>
        <button
          type="button"
          className="icon-btn profile-close"
          aria-label="Close the profile"
          onClick={() => model.closeAgentProfile()}
        >
          <X size={15} />
        </button>
      </div>

      <div className="profile-identity">
        <div className="profile-avatar">
          <SidebarAgentBadge agent={agent} size={64} />
        </div>

        <div className="profile-name-block">
          <label className="profile-field-label" htmlFor="agent-name">Name</label>
          <input
            id="agent-name"
            className="profile-name-input"
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const trimmed = name.trim();
              if (trimmed.length === 0 || trimmed === agent.name) return;
              model.renameAgent(trimmed, agent.id);
              setSaved("name");
            }}
          />
          <div className="profile-by">by {agent.id}</div>
        </div>

        <div className="profile-tag-block">
          <label className="profile-field-label" htmlFor="agent-tag">Tag</label>
          <input
            id="agent-tag"
            className="profile-tag-input"
            value={tag}
            maxLength={160}
            placeholder="What is it for?"
            onChange={(event) => setTag(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const trimmed = tag.trim();
              if (trimmed === (agent.role ?? "")) return;
              model.updateAgentProfile(agent.id, { role: trimmed });
              setSaved("tag");
            }}
          />
        </div>
      </div>

      <div className="profile-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "details"}
          className={`profile-tab${tab === "details" ? " active" : ""}`}
          onClick={() => setTab("details")}
        >
          Details
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          className={`profile-tab${tab === "activity" ? " active" : ""}`}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
      </div>

      {tab === "details" ? (
        <div className="profile-body">
          <div className="profile-rows">
            <div className="profile-row">
              <span className="profile-row-label">Tag</span>
              <span className="profile-row-value">{agent.role ?? "Not set"}</span>
            </div>
            <div className="profile-row">
              <span className="profile-row-label">Model</span>
              <span className="profile-row-value">{agent.model ?? "The default"}</span>
            </div>
            <div className="profile-row">
              <span className="profile-row-label">Tools</span>
              <span className="profile-row-value">{agent.tools?.length ?? 0}</span>
            </div>
          </div>

          <div className="profile-section">
            <div className="profile-section-title">What other agents see</div>
            <div className="profile-segments">
              {VISIBILITIES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`profile-segment${visibility === option.id ? " active" : ""}`}
                  onClick={() => model.updateAgentProfile(agent.id, { visibility: option.id })}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="settings-note">
              {VISIBILITIES.find((option) => option.id === visibility)?.note}
            </div>
          </div>

          {saved ? (
            <div className="profile-saved">
              <Check size={12} /> Saved
            </div>
          ) : null}
        </div>
      ) : (
        <div className="profile-body">
          {tasks.length === 0 ? (
            <div className="profile-empty">Nothing on its plate right now.</div>
          ) : (
            <div className="profile-rows">
              {tasks.map((task) => (
                <div className="profile-row" key={task.id}>
                  <span className="profile-row-value">{task.title}</span>
                  <span className={`chip ${task.status}`}>{task.status}</span>
                </div>
              ))}
            </div>
          )}
          <div className="profile-section">
            <div className="profile-section-title">Thread</div>
            <div className="profile-rows">
              <div className="profile-row">
                <span className="profile-row-value">
                  <Link2 size={12} /> One conversation, never reset
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
