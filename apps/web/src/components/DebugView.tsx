/**
 * Bot debugger: a full-screen view of what the bots did and why. The turn
 * list on the left, the selected turn as a flow in the middle (what was
 * asked, every model step and tool call, what came back, why it stopped),
 * and the daemon's live state — sessions, jobs, providers — on the right.
 * Everything comes from GET /debug/*; nothing here is estimated except the
 * ~token counts in the context tab, which say so.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDot, Info, RefreshCw, X, XCircle } from "lucide-react";
import { useAppModel } from "../state/use-app-model";
import {
  buildFlow,
  diagnoseTurn,
  isProblem,
  reportedError,
  stepsUsed,
  stopReasonText,
  turnDurationMs,
  type DebugContextMessage,
  type DebugLimits,
  type DebugOverview,
  type DebugToolCall,
  type DebugTurnDetail,
  type DebugTurnRow,
  type Finding,
} from "../state/debug";

const POLL_MS = 2500;

export function DebugView() {
  const model = useAppModel();
  const [overview, setOverview] = useState<DebugOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DebugTurnDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState("all");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<Tab>("flow");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") model.toggleDebug(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model]);

  useEffect(() => {
    const controller = new AbortController();
    model.debugData<DebugOverview>("overview?limit=200", controller.signal)
      .then((data) => {
        setOverview(data);
        setError(null);
        setSelected((current) => current ?? data.turns[0]?.id ?? null);
      })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(message(reason)); });
    return () => controller.abort();
  }, [model, tick]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((value) => value + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  // A running turn's detail follows the poll; a finished one is fetched once.
  const selectedRow = overview?.turns.find((turn) => turn.id === selected);
  const detailKey = selectedRow && !selectedRow.ended_at ? tick : -1;
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    model.debugData<DebugTurnDetail>(`turns/${encodeURIComponent(selected)}`, controller.signal)
      .then((data) => { setDetail(data); setDetailError(null); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setDetailError(message(reason)); });
    return () => controller.abort();
  }, [model, selected, detailKey]);

  const agentName = useMemo(() => {
    const names = new Map((overview?.agents ?? []).map((agent) => [agent.id, agent.name]));
    return (id: string | null | undefined) => (id ? names.get(id) ?? id : "—");
  }, [overview]);

  const turns = (overview?.turns ?? []).filter((turn) =>
    (agentFilter === "all" || turn.agent_id === agentFilter)
    && (!problemsOnly || (overview && isProblem(turn, overview.limits)))
    && (!search.trim() || `${turn.tool_names ?? ""} ${turn.id} ${turn.stop_reason ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())),
  );

  return (
    <div className="debug-overlay" role="dialog" aria-label="Bot debugger">
      <header className="debug-top">
        <strong className="debug-title">Bot debugger</strong>
        {overview ? <TopStats overview={overview} /> : null}
        <span className="spacer" />
        <label className="debug-check">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} /> Live
        </label>
        <button type="button" className="icon-btn" title="Refresh now" aria-label="Refresh" onClick={() => setTick((value) => value + 1)}>
          <RefreshCw size={13} />
        </button>
        <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close bot debugger" onClick={() => model.toggleDebug()}>
          <X size={14} />
        </button>
      </header>
      {error ? <div className="debug-banner">Could not load debugger data: {error.replace(/\.$/, "")}.{error.includes("404") ? " Restart the server so it picks up the debugger." : ""}</div> : null}

      <div className="debug-body">
        <aside className="debug-left">
          {overview ? <RunningNow overview={overview} agentName={agentName} onPick={setSelected} /> : null}
          <div className="debug-filters">
            <select className="text-input" aria-label="Filter by bot" value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)}>
              <option value="all">All bots</option>
              {(overview?.agents ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
            <input className="text-input" placeholder="Search tool, id, reason" aria-label="Search turns" value={search} onChange={(event) => setSearch(event.target.value)} />
            <label className="debug-check">
              <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} /> Problems only
            </label>
          </div>
          <div className="debug-section-title">Turns ({turns.length})</div>
          <div className="debug-turn-list">
            {turns.length === 0 ? <div className="debug-empty">{overview ? "No turns match." : "Loading…"}</div> : null}
            {overview && turns.map((turn) => (
              <TurnRow key={turn.id} turn={turn} limits={overview.limits} name={agentName(turn.agent_id)} active={turn.id === selected} onPick={() => setSelected(turn.id)} />
            ))}
          </div>
        </aside>

        <main className="debug-main">
          {detailError ? <div className="debug-banner">Could not load this turn: {detailError}</div> : null}
          {detail && overview && detail.turn.id === selected
            ? <TurnDetail detail={detail} limits={overview.limits} tab={tab} onTab={setTab} />
            : <div className="debug-empty">{selected ? "Loading turn…" : "Pick a turn on the left. A turn is one reply: everything a bot does for one message."}</div>}
        </main>

        <aside className="debug-right">{overview ? <SystemPanel overview={overview} agentName={agentName} /> : null}</aside>
      </div>
    </div>
  );
}

// MARK: top bar

function TopStats({ overview }: { overview: DebugOverview }) {
  const { limits, usageToday, capacity, providers } = overview;
  return (
    <div className="debug-stats">
      <Stat label="Providers" value={providers.length === 0 ? "none" : `${providers.filter((provider) => provider.available).length}/${providers.length} up`} bad={providers.every((provider) => !provider.available)} />
      <Stat label="Model streams" value={`${capacity.active}/${capacity.capacity}`} bad={capacity.active >= capacity.capacity} />
      <Stat label="Today" value={`${usageToday.turns} turns · ${compact(usageToday.inputTokens)} in · ${compact(usageToday.outputTokens)} out`} />
      <Stat label="Limits per turn" value={`${limits.maxSteps} tools · ${compact(limits.maxTokens)} tokens · ${Math.round(limits.turnTimeoutMs / 1000)}s`} />
    </div>
  );
}

function Stat({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <span className={`debug-stat${bad ? " bad" : ""}`}>
      <span className="debug-stat-label">{label}</span>
      <span className="machine">{value}</span>
    </span>
  );
}

// MARK: left column

function RunningNow({ overview, agentName, onPick }: { overview: DebugOverview; agentName: (id: string | null) => string; onPick: (id: string) => void }) {
  const active = overview.sessions.filter((session) => session.state === "running" || session.state === "awaiting_approval" || session.state === "waiting");
  return (
    <div className="debug-running">
      <div className="debug-section-title">Working now ({active.length})</div>
      {active.length === 0 ? <div className="debug-empty small">No bot is mid-task.</div> : null}
      {active.map((session) => (
        <button key={session.thread_id} type="button" className="debug-running-row" onClick={() => onPick(session.turn_id)}>
          <span className={`debug-dot ${session.state === "running" ? "working" : "waiting"}`} />
          <span className="debug-running-name">{agentName(session.agent_id)}</span>
          <span className="machine muted">{session.state.replace("_", " ")}</span>
          <Meter value={session.step_count} max={session.max_steps} label="tools" />
        </button>
      ))}
    </div>
  );
}

function TurnRow({ turn, limits, name, active, onPick }: { turn: DebugTurnRow; limits: DebugLimits; name: string; active: boolean; onPick: () => void }) {
  const steps = stepsUsed(turn);
  const problem = isProblem(turn, limits);
  return (
    <button type="button" className={`debug-turn-row${active ? " active" : ""}`} onClick={onPick}>
      <div className="debug-row-line">
        <StatusIcon reason={turn.stop_reason} problem={problem} />
        <span className="debug-turn-name">{name}</span>
        <span className="spacer" />
        <span className="machine muted">{ago(turn.started_at)}</span>
      </div>
      <div className="debug-row-line machine muted">
        <span>{turn.stop_reason ?? "running"}</span>
        <span>· {seconds(turnDurationMs(turn))}</span>
        <span className={steps >= limits.maxSteps ? "debug-bad-text" : ""}>· {steps}/{limits.maxSteps} tools</span>
        {turn.failed_count > 0 ? <span className="debug-bad-text">· {turn.failed_count} failed</span> : null}
      </div>
      {turn.tool_names ? <div className="machine tertiary debug-clip">{toolSummary(turn.tool_names)}</div> : null}
    </button>
  );
}

// MARK: middle column

type Tab = "flow" | "context" | "raw";

function TurnDetail({ detail, limits, tab, onTab }: { detail: DebugTurnDetail; limits: DebugLimits; tab: Tab; onTab: (tab: Tab) => void }) {
  const { turn, tools, session } = detail;
  const findings = diagnoseTurn(detail, limits);
  const duration = turnDurationMs(turn);
  const steps = session?.step_count ?? tools.length;
  const failed = tools.filter((tool) => !tool.ok).length;

  return (
    <div className="debug-detail">
      <div className="debug-detail-head">
        <div>
          <div className="debug-detail-title">
            <StatusIcon reason={turn.stop_reason} problem={findings.some((finding) => finding.severity !== "info")} />
            {turn.agent_name ?? turn.agent_id}
            {turn.thread_title ? <span className="muted"> · {turn.thread_title}</span> : null}
          </div>
          <div className="machine muted">
            {new Date(turn.started_at).toLocaleString()} · {turn.provider ?? "?"} · {turn.model ?? "?"} · {turn.input_tokens ?? "?"} in / {turn.output_tokens ?? "?"} out tokens (last model call)
          </div>
          <div className="machine tertiary debug-select">turn {turn.id} · session {turn.thread_id}</div>
        </div>
      </div>

      <div className="debug-card">
        <div className="debug-section-title">What happened</div>
        <div className="debug-verdict">{stopReasonText(turn.stop_reason, limits)}</div>
        <div className="debug-findings">
          {findings.map((finding, index) => <FindingRow key={index} finding={finding} />)}
        </div>
      </div>

      <div className="debug-meters">
        <MeterCard title="Tool calls (steps)" value={steps} max={session?.max_steps ?? limits.maxSteps} note={`${failed} failed`} />
        <MeterCard title="Output tokens" value={session?.token_count ?? null} max={session?.max_tokens ?? limits.maxTokens} note={session ? "written by the bot this turn" : "not kept for this turn"} />
        <MeterCard title="Time" value={Math.round(duration / 1000)} max={Math.round(limits.turnTimeoutMs / 1000)} unit="s" note={turn.ended_at ? "total turn time" : "still running"} />
        <MeterCard title="Last model call" value={turn.latency_ms === null ? null : Math.round(turn.latency_ms / 100) / 10} max={Math.round(limits.firstTokenTimeoutMs / 1000)} unit="s" note="vs first-token timeout" />
      </div>

      <div className="debug-tabs" role="tablist">
        {(["flow", "context", "raw"] as const).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className={tab === name ? "active" : ""} onClick={() => onTab(name)}>
            {name === "flow" ? "Flow" : name === "context" ? "What the model saw" : "Raw data"}
          </button>
        ))}
      </div>
      {tab === "flow" ? <FlowView detail={detail} duration={duration} limits={limits} /> : null}
      {tab === "context" ? <ContextView detail={detail} /> : null}
      {tab === "raw" ? <pre className="debug-pre">{JSON.stringify(detail, null, 2)}</pre> : null}
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const Icon = finding.severity === "error" ? XCircle : finding.severity === "warn" ? AlertTriangle : Info;
  return (
    <div className={`debug-finding ${finding.severity}`}>
      <Icon size={13} />
      <div>
        <div className="debug-finding-title">{finding.title}</div>
        {finding.detail ? <div className="debug-finding-detail">{finding.detail}</div> : null}
      </div>
    </div>
  );
}

function FlowView({ detail, duration, limits }: { detail: DebugTurnDetail; duration: number; limits: DebugLimits }) {
  const items = buildFlow(detail);
  let toolNumber = 0;
  return (
    <ol className="debug-flow">
      {items.map((item, index) => {
        switch (item.kind) {
          case "history":
            return (
              <FlowNode key={index} tone="muted" label="Earlier chat">
                <details>
                  <summary>{item.messages.length} earlier messages were sent along as context</summary>
                  {item.messages.map((message, i) => <ContextMessage key={i} message={message} />)}
                </details>
              </FlowNode>
            );
          case "system":
            return <FlowNode key={index} tone="muted" label="System note"><Clamp text={item.text} /></FlowNode>;
          case "user":
            return <FlowNode key={index} tone="user" label="Asked"><Clamp text={item.text} /></FlowNode>;
          case "step":
            return (
              <FlowNode key={index} tone="model" label={`Model step ${item.index}`}>
                <div className="muted">Decided to call {item.calls.length} tool{item.calls.length === 1 ? "" : "s"}{item.text.trim() ? " and said:" : "."}</div>
                {item.text.trim() ? <Clamp text={item.text} /> : null}
                {item.reasoning ? <details><summary>Reasoning</summary><pre className="debug-pre">{item.reasoning}</pre></details> : null}
                {item.calls.map((call) => {
                  toolNumber += 1;
                  return <ToolCallCard key={call.id} number={toolNumber} name={call.name} args={call.record?.args ?? call.arguments} record={call.record} result={call.record?.result ?? call.result ?? null} skipped={call.skipped} duration={duration} maxSteps={limits.maxSteps} />;
                })}
              </FlowNode>
            );
          case "tool":
            toolNumber += 1;
            return (
              <FlowNode key={index} tone="model" label={`Tool call ${toolNumber}`}>
                <ToolCallCard number={toolNumber} name={item.record.tool_name} args={item.record.args} record={item.record} result={item.record.result} skipped={false} duration={duration} maxSteps={limits.maxSteps} />
              </FlowNode>
            );
          case "answer":
            return <FlowNode key={index} tone="answer" label="Answer"><Clamp text={item.text || "(empty)"} /></FlowNode>;
        }
      })}
      <FlowNode tone={detail.turn.stop_reason === "end" ? "answer" : detail.turn.stop_reason ? "bad" : "model"} label="Stopped">
        {stopReasonText(detail.turn.stop_reason, limits)}
      </FlowNode>
    </ol>
  );
}

function FlowNode({ tone, label, children }: { tone: "user" | "model" | "answer" | "bad" | "muted"; label: string; children: ReactNode }) {
  return (
    <li className={`debug-flow-node ${tone}`}>
      <div className="debug-flow-label">{label}</div>
      <div className="debug-flow-body">{children}</div>
    </li>
  );
}

function ToolCallCard({ number, name, args, record, result, skipped, duration, maxSteps }: {
  number: number; name: string; args: unknown; record?: DebugToolCall; result: string | null; skipped: boolean; duration: number; maxSteps: number;
}) {
  const ok = skipped ? null : record ? record.ok : null;
  // Rows written before durations were recorded say 0: unknown, not instant.
  const took = record?.duration_ms || null;
  const softError = record?.ok ? reportedError(result) : null;
  return (
    <details className={`debug-tool${ok === false || softError ? " failed" : ""}${skipped ? " skipped" : ""}`}>
      <summary>
        <ChevronRight size={12} className="debug-chevron" />
        {skipped ? <CircleDot size={13} className="muted" /> : ok === false ? <XCircle size={13} className="debug-bad-text" /> : softError ? <AlertTriangle size={13} className="debug-warn-text" /> : ok ? <CheckCircle2 size={13} className="debug-ok-text" /> : <CircleDot size={13} className="muted" />}
        <span className={`machine${number > maxSteps ? " debug-bad-text" : ""}`}>#{number}</span>
        <span className="machine debug-tool-name">{name}</span>
        <span className="debug-clip muted machine">{argsPreview(args)}</span>
        <span className="spacer" />
        {skipped ? <span className="machine muted">skipped duplicate</span> : null}
        {record?.error ? <span className="machine debug-bad-text debug-clip">{record.error}</span> : null}
        {softError ? <span className="machine debug-warn-text debug-clip" title={softError}>returned an error</span> : null}
        <span className="machine muted">{took === null ? "" : seconds(took)}</span>
      </summary>
      {took !== null && duration > 0 ? <div className="debug-timebar"><span style={{ width: `${Math.min(100, (took / duration) * 100)}%` }} /></div> : null}
      <div className="debug-kv">Input</div>
      <pre className="debug-pre">{typeof args === "string" ? args : JSON.stringify(args, null, 2)}</pre>
      <div className="debug-kv">Result{result ? ` · ${result.length.toLocaleString()} chars` : ""}</div>
      <pre className="debug-pre">{result ? pretty(result) : record ? "(no result — interrupted before it finished)" : "(not recorded)"}</pre>
    </details>
  );
}

function ContextView({ detail }: { detail: DebugTurnDetail }) {
  if (!detail.context) {
    return <div className="debug-empty">The exact context is kept only for the newest turn of each chat session, and this one has been replaced. The Flow tab still shows its tool calls.</div>;
  }
  const chars = detail.context.reduce((sum, message) => sum + (message.content?.length ?? 0) + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0), 0);
  return (
    <div className="debug-context">
      <div className="muted">
        {detail.context.length} messages · {chars.toLocaleString()} chars · ~{compact(Math.round(chars / 4))} tokens (estimate: chars ÷ 4).
        The bot's rules, tool list and memory are added on top of this when each call is made, and are not stored.
      </div>
      {detail.session?.summary ? (
        <div className="debug-card">
          <div className="debug-section-title">Compaction summary (older history squashed into this)</div>
          <Clamp text={detail.session.summary} />
        </div>
      ) : null}
      {detail.context.map((message, index) => <ContextMessage key={index} message={message} />)}
    </div>
  );
}

function ContextMessage({ message }: { message: DebugContextMessage }) {
  const size = (message.content?.length ?? 0) + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0);
  return (
    <div className={`debug-ctx ${message.role}`}>
      <div className="debug-ctx-head machine">
        <span className="debug-ctx-role">{message.role}</span>
        {message.toolCallID ? <span className="muted">result of {message.toolCallID}</span> : null}
        <span className="spacer" />
        <span className="muted">{size.toLocaleString()} chars · ~{compact(Math.round(size / 4))} tok</span>
      </div>
      {message.content ? <Clamp text={message.content} /> : null}
      {message.toolCalls?.map((call) => (
        <div key={call.id} className="machine muted">→ calls {call.name}({call.arguments ?? ""})</div>
      ))}
    </div>
  );
}

// MARK: right column

function SystemPanel({ overview, agentName }: { overview: DebugOverview; agentName: (id: string | null) => string }) {
  const lastTurn = new Map<string, DebugTurnRow>();
  for (const turn of overview.turns) if (!lastTurn.has(turn.agent_id)) lastTurn.set(turn.agent_id, turn);
  return (
    <>
      <div className="debug-section-title">How a reply works</div>
      <div className="debug-card debug-explain">
        <div><b>Every reply</b> — chat and background jobs alike: the bot loops <i>think → call a tool → read the result</i> until it can answer. Each tool call is one step.</div>
        <div><b>Limits</b> — {overview.limits.maxSteps} tool calls, {overview.limits.maxTokens.toLocaleString()} written tokens, {Math.round(overview.limits.turnTimeoutMs / 1000)}s per turn; a model gets {Math.round(overview.limits.firstTokenTimeoutMs / 1000)}s to start replying before the next provider is tried.</div>
      </div>

      <div className="debug-section-title">Providers</div>
      {overview.providers.length === 0 ? <div className="debug-empty small">None configured — bots cannot answer.</div> : null}
      {overview.providers.map((provider) => (
        <div key={provider.id} className="debug-card debug-compact">
          <div className="debug-row-line">
            <span className={`debug-dot ${provider.available ? "ok" : "bad"}`} />
            <strong>{provider.label}</strong>
            <span className="spacer" />
            <span className="machine muted">{provider.available ? "ready" : `cooling down ${Math.ceil(provider.cooldownRemainingMs / 1000)}s`}</span>
          </div>
          <div className="machine muted debug-clip">{provider.model}</div>
          {provider.lastError ? <div className="machine debug-bad-text">{provider.lastError}</div> : null}
          {provider.lastSuccessAt ? <div className="machine tertiary">last success {ago(new Date(provider.lastSuccessAt).toISOString())}</div> : null}
        </div>
      ))}

      <div className="debug-section-title">Bots</div>
      {overview.agents.map((agent) => {
        const turn = lastTurn.get(agent.id);
        return (
          <div key={agent.id} className="debug-card debug-compact">
            <div className="debug-row-line">
              <strong>{agent.name}</strong>
              <span className="machine tertiary">{agent.id}</span>
              <span className="spacer" />
              <span className="machine muted">{toolCount(agent.tools)}</span>
            </div>
            <div className="machine muted">{turn ? `last turn ${ago(turn.started_at)} · ${turn.stop_reason ?? "running"}` : "no turns yet"}</div>
          </div>
        );
      })}

      <div className="debug-section-title">Background jobs ({overview.jobs.length})</div>
      {overview.jobs.length === 0 ? <div className="debug-empty small">Nothing scheduled.</div> : null}
      {overview.jobs.map((job) => (
        <div key={job.id} className="debug-card debug-compact">
          <div className="debug-row-line">
            <span className={`debug-dot ${job.state === "failed" ? "bad" : job.state === "running" ? "working" : job.state === "done" ? "ok" : "waiting"}`} />
            <strong className="debug-clip">{job.title ?? job.kind}</strong>
            <span className="spacer" />
            <span className="debug-badge">{job.kind}</span>
          </div>
          <div className="machine muted">
            {job.state}{job.attempts > 0 ? ` · ${job.attempts} attempts` : ""}{job.agentID ? ` · ${agentName(job.agentID)}` : ""} · {job.state === "queued" ? `runs ${new Date(job.run_at).toLocaleTimeString()}` : ago(job.updated_at)}
            {job.enabled ? "" : " · paused"}
          </div>
          {job.result ? <div className="machine tertiary debug-clip" title={job.result}>{job.result}</div> : null}
        </div>
      ))}
    </>
  );
}

// MARK: bits

function StatusIcon({ reason, problem }: { reason: string | null; problem: boolean }) {
  if (reason === null) return <span className="debug-dot working" aria-label="running" />;
  if (reason === "end" && !problem) return <span className="debug-dot ok" aria-label="finished" />;
  if (reason === "needs_input" || reason === "cancelled") return <span className="debug-dot waiting" aria-label={reason} />;
  return <span className="debug-dot bad" aria-label="problem" />;
}

function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className="debug-meter" title={`${value}/${max} ${label}`}>
      <span className={ratio >= 1 ? "full" : ratio >= 0.8 ? "high" : ""} style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

function MeterCard({ title, value, max, unit = "", note }: { title: string; value: number | null; max: number; unit?: string; note: string }) {
  return (
    <div className="debug-card debug-meter-card">
      <div className="debug-section-title">{title}</div>
      <div className="debug-meter-value machine">{value === null ? "—" : `${value.toLocaleString()}${unit}`}<span className="muted"> / {max.toLocaleString()}{unit}</span></div>
      <Meter value={value ?? 0} max={max} label={title} />
      <div className="machine tertiary">{note}</div>
    </div>
  );
}

function Clamp({ text }: { text: string }) {
  if (text.length <= 600) return <div className="debug-text">{text}</div>;
  return (
    <details className="debug-text">
      <summary>{text.slice(0, 600)}… <span className="muted">({text.length.toLocaleString()} chars — show all)</span></summary>
      {text}
    </details>
  );
}

function toolSummary(names: string): string {
  const counts = new Map<string, number>();
  for (const name of names.split(",")) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join(" · ");
}

function toolCount(tools: string | null): string {
  try {
    const list = JSON.parse(tools ?? "null") as unknown;
    return Array.isArray(list) ? `${list.length} tools` : "default tools";
  } catch {
    return "default tools";
  }
}

function argsPreview(args: unknown): string {
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text && text !== "{}" ? text.slice(0, 120) : "";
}

function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function compact(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
