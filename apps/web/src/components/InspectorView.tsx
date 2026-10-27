/**
 * Inspector: the agent, the routines it runs without being asked, the
 * connections it depends on, and today's numbers. Everything here is either
 * reported by the daemon or absent — nothing is estimated.
 */
import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { format, type JobInfo, type MemoryItem, type TaskInfo } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { AgentAvatar, PresenceDot } from "./bits";
import { AddProviderView } from "./AddProviderView";

export function InspectorView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const memories = snapshot.memories;
  const [addingProvider, setAddingProvider] = useState(false);
  const agent = model.agent;
  const openTasks = snapshot.tasks.filter((task) => task.status !== "done");
  const completed = snapshot.tasks.filter((task) => task.status === "done").slice(0, 5);
  const recurring = snapshot.jobs.filter((job) => job.everyMs !== undefined);
  const scheduled = snapshot.jobs.filter((job) => job.everyMs === undefined);

  return (
    <aside className="inspector">
      <section className="card inspector-agent">
        <div className="inspector-agent-head">
          <AgentAvatar agent={agent} alive={snapshot.conversation.isStreaming} size="large" />
          <div>
            <div className="inspector-agent-name">{agent?.name ?? "Agni"}</div>
            <div className="inspector-presence">
              <PresenceDot online={snapshot.connectionState.kind === "ready"} />
              {snapshot.connectionState.kind === "ready" ? "Available" : "Offline"}
            </div>
          </div>
        </div>
        <Row label="Model" value={agent?.model ?? "routed by the daemon"} />
        <Row label="Lane" value="task — tools, up to 16 steps" />
        <Row
          label="Tools"
          value={agent?.tools && agent.tools.length > 0 ? agent.tools.join(", ") : "none in this lane"}
        />
        {snapshot.conversation.threadID ? <Row label="Thread" value={snapshot.conversation.threadID} /> : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-head">
          <div className="section-title">Tasks</div>
          <button type="button" className="link" onClick={() => model.refreshTasks()}>
            Refresh
          </button>
        </div>
        {openTasks.length === 0 ? (
          <div className="empty-note">
            <strong>No open tasks</strong>
            <span>Capture one in chat with “add task: …”.</span>
          </div>
        ) : (
          openTasks.map((task) => <TaskRow key={task.id} task={task} />)
        )}
        {completed.length > 0 ? (
          <>
            <div className="section-title" style={{ paddingTop: 4 }}>
              Completed recently
            </div>
            {completed.map((task) => (
              <div key={task.id} className="settings-row">
                <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {task.title}
                </span>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => model.updateTask(task, "reopen")}>
                  Reopen
                </button>
              </div>
            ))}
          </>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-head">
          <div className="section-title">Memory</div>
          <button type="button" className="link" onClick={() => model.refreshMemories()}>
            Refresh
          </button>
        </div>
        {memories.length === 0 ? (
          <div className="empty-note">
            <strong>Nothing remembered yet</strong>
            <span>Facts the agent keeps show up here — only the ones it can actually recall.</span>
          </div>
        ) : (
          memories.map((memory) => <MemoryRow key={memory.id} memory={memory} />)
        )}
      </section>

      <section className="inspector-section">
        <div className="section-title">Routines</div>
        {snapshot.jobs.length === 0 ? (
          <div className="empty-note">
            <strong>Nothing scheduled</strong>
            <span>
              Routines are background turns the daemon runs while you are away. Add one with
              bun run job add "…" --every 1h.
            </span>
          </div>
        ) : null}
        {recurring.map((job) => (
          <RoutineRow key={job.id} job={job} />
        ))}
        {scheduled.length > 0 ? (
          <div className="section-title" style={{ paddingTop: 4 }}>
            Scheduled once
          </div>
        ) : null}
        {scheduled.map((job) => (
          <RoutineRow key={job.id} job={job} />
        ))}
        {snapshot.jobs.length > 0 ? (
          <button type="button" className="link" onClick={() => model.refreshJobs()} style={{ alignSelf: "flex-start" }}>
            Refresh
          </button>
        ) : null}
      </section>

      <section className="inspector-section">
        <div className="section-title">Connections</div>
        <button
          type="button"
          className="btn small"
          style={{ alignSelf: "flex-start" }}
          disabled={snapshot.connectionState.kind !== "ready"}
          onClick={() => {
            model.prepareToAddProvider();
            setAddingProvider(true);
          }}
        >
          <Plus size={12} /> Add provider
        </button>
        {snapshot.health ? (
          snapshot.health.providers.length === 0 ? (
            <div className="empty-note">
              <strong>No providers configured</strong>
              <span>Add a provider key here. Agni stores it on the daemon host.</span>
            </div>
          ) : (
            snapshot.health.providers.map((provider) => (
              <div key={provider.id} className="provider-row">
                <span className={`provider-dot${provider.available ? "" : " off"}`} style={{ marginTop: 5 }} />
                <div className="provider-main">
                  <div className="provider-name">{provider.label}</div>
                  <div className="provider-model">{provider.model}</div>
                  {!provider.available ? (
                    <div className="provider-note warning-text">
                      {provider.cooldownRemainingMs > 0
                        ? `Cooling ${Math.trunc(provider.cooldownRemainingMs / 1000)}s${
                            provider.lastError ? ` — ${provider.lastError}` : ""
                          }`
                        : provider.lastError ?? "Unavailable"}
                    </div>
                  ) : null}
                  <div className="provider-note">{provider.tiers.join(" · ")}</div>
                </div>
              </div>
            ))
          )
        ) : (
          <div className="empty-note">
            <strong>Daemon status unavailable</strong>
            <span>{snapshot.healthError ?? "Waiting for /health…"}</span>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <div className="section-title">Today</div>
        {snapshot.health ? (
          <>
            <Row label="Turns" value={snapshot.health.usageToday.turns.toLocaleString()} />
            <Row
              label="Tokens"
              value={`${snapshot.health.usageToday.inputTokens.toLocaleString()} in · ${snapshot.health.usageToday.outputTokens.toLocaleString()} out`}
            />
            <Row
              label="Daemon"
              value={`up ${format.uptime(snapshot.health.uptimeMs)} · protocol v${snapshot.health.v}`}
            />
          </>
        ) : (
          <Row label="Usage" value="unknown" />
        )}
        <p className="settings-note">
          Free-tier providers are the default; if a NIM pay-as-you-go key is set, spend is
          capped by the daemon's daily limits.
        </p>
      </section>

      <section className="inspector-section">
        <div className="section-title">This Browser</div>
        <Row label="Server" value={snapshot.settings.url} />
        <Row
          label="Token"
          value={snapshot.secretKind === "memory" ? "kept for this session" : "stored in browser storage"}
        />
        <Row label="Device" value={snapshot.settings.deviceName} />
        <button
          type="button"
          className="btn small"
          style={{ alignSelf: "flex-start" }}
          onClick={() => model.forgetDevice()}
        >
          Forget this device
        </button>
        <p className="settings-note">
          Forgetting removes the token from this browser. The server still knows the device
          until you revoke it with bun run devices.
        </p>
      </section>

      {addingProvider ? <AddProviderView onDismiss={() => setAddingProvider(false)} /> : null}
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
}

/**
 * One remembered thing. The owner can see what the agent holds and where it
 * came from; the list is filtered the way retrieval filters it, so nothing
 * shows here that the agent could not have recalled.
 */
function MemoryRow({ memory }: { memory: MemoryItem }) {
  const used = memory.useCount > 0;
  return (
    <div className="memory-row">
      <div className="memory-text">{memory.text}</div>
      <div className="memory-meta">
        <span>{memory.scope}</span>
        <span>·</span>
        <span>{memory.source}</span>
        <span>·</span>
        <span title="How sure the agent is">{(memory.confidence * 100).toFixed(0)}%</span>
        {used ? (
          <>
            <span>·</span>
            <span title="How often it is recalled">used {memory.useCount}×</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TaskRow({ task }: { task: TaskInfo }) {
  const model = useAppModel();
  const due = task.dueAt ? format.parseISO(task.dueAt) : null;
  const meta = [
    due ? `Due ${format.stamp(due)}` : null,
    task.priority.charAt(0).toUpperCase() + task.priority.slice(1),
    task.status.charAt(0).toUpperCase() + task.status.slice(1),
    task.delegateState && task.delegateState !== "none"
      ? `${task.ownerAgentId ?? "agent"} · ${task.delegateState.replace("_", " ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const cancellable =
    task.delegateState === "queued" || task.delegateState === "running" || task.delegateState === "needs_input";
  return (
    <div className="task-row">
      <div className="task-main">
        <div className="task-title">{task.title}</div>
        <div className="task-meta">{meta}</div>
      </div>
      <select
        className="select btn small"
        style={{ width: 88, padding: "3px 20px 3px 8px", fontSize: 11 }}
        defaultValue=""
        aria-label={`Snooze ${task.title}`}
        onChange={(event) => {
          const value = event.target.value;
          event.currentTarget.value = "";
          if (value === "hour") {
            model.updateTask(task, "snooze", new Date(Date.now() + 3_600_000));
          } else if (value === "tomorrow") {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(9, 0, 0, 0);
            model.updateTask(task, "snooze", tomorrow);
          }
        }}
      >
        <option value="" disabled>
          Snooze
        </option>
        <option value="hour">1 hour</option>
        <option value="tomorrow">Tomorrow</option>
      </select>
      {cancellable ? (
        <button type="button" className="btn small" onClick={() => model.updateTask(task, "cancel")}>
          Cancel
        </button>
      ) : null}
      <button type="button" className="btn primary small" onClick={() => model.updateTask(task, "done")}>
        Done
      </button>
    </div>
  );
}

function RoutineRow({ job }: { job: JobInfo }) {
  const model = useAppModel();
  const cadence = format.cadence(job.everyMs ?? null, format.parseISO(job.runAt));
  const timing =
    job.state === "running"
      ? "Running now"
      : job.enabled && job.everyMs !== undefined && format.parseISO(job.runAt)
        ? `${cadence} · next ${format.stamp(format.parseISO(job.runAt) as Date)}`
        : cadence;
  return (
    <div className="routine-row">
      <div className="routine-main">
        <div className="routine-title">{job.title && job.title.length > 0 ? job.title : job.kind}</div>
        <div className="routine-meta">{timing}</div>
        {job.lastResult && job.lastResult.length > 0 ? (
          <div className="routine-meta tertiary">{format.preview(job.lastResult, 90)}</div>
        ) : null}
        {job.state === "failed" ? (
          <div className="routine-meta warning-text">Failed after {job.attempts} attempts</div>
        ) : null}
        {!job.enabled ? <div className="routine-meta tertiary">Paused</div> : null}
      </div>
      <button
        type="button"
        className="icon-btn"
        title="Run now"
        aria-label={`Run ${job.title ?? job.kind} now`}
        onClick={() => model.runRoutine(job)}
      >
        <RefreshCw size={12} />
      </button>
      <input
        type="checkbox"
        className="toggle"
        checked={job.enabled}
        aria-label={`${job.title ?? job.kind} routine`}
        title={job.enabled ? "Pause this routine" : "Resume this routine"}
        onChange={(event) => model.setRoutine(job, event.target.checked)}
      />
    </div>
  );
}
