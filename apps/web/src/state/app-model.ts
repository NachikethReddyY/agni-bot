/**
 * The app model: pairing, the connection, the open transcript, the roster, the
 * daemon's health, and every user intent the views need. Views call methods
 * here; frames arrive here from AgniConnection; nothing else reaches the
 * network. This is the TypeScript port of `AppModel.swift`.
 */
import {
  AgniConnection,
  Conversation,
  SecretStore,
  SettingsStore,
  defaultServerSettings,
  fetchHealth,
  healthURL,
  isKnownFrame,
  isReady,
  websocketURL,
  type AgentInfo,
  type ApprovalRow,
  type ChatMessage,
  type ClientFrame,
  type ConnectionEvent,
  type ConnectionState,
  type ConversationEffect,
  type FormRow,
  type FrameTransport,
  type HealthReport,
  type IncomingFrame,
  type JobInfo,
  type NoticeKind,
  type NoticeRow,
  type PluginInfo,
  type ProviderStatus,
  type SecretRow,
  type SecretStoreKind,
  type ServerSettings,
  type TaskInfo,
  type ThreadInfo,
} from "@agni/client";
import { browserNotifications, type NotificationBridge } from "./notifications";

export type AppScreen = "pairing" | "chat";

export interface ExportLink {
  url: string;
  token: string;
  records: number;
}

export interface AppSnapshot {
  screen: AppScreen;
  connectionState: ConnectionState;
  settings: ServerSettings;
  secretKind: SecretStoreKind | null;
  tokenIsStored: boolean;
  isCheckingServer: boolean;
  isPairing: boolean;
  pairingError: string | null;

  conversation: Conversation;
  threads: ThreadInfo[];
  agents: AgentInfo[];
  /** Full roster for `@mention` and handoff links, including hidden agents. */
  mentionAgents: AgentInfo[];
  unread: ReadonlySet<string>;
  /** What each agent is doing: idle, working, waiting, blocked. */
  agentStates: Readonly<Record<string, "idle" | "working" | "waiting" | "blocked">>;

  health: HealthReport | null;
  healthError: string | null;
  configuredProviders: ProviderStatus[];
  plugins: PluginInfo[];
  jobs: JobInfo[];
  tasks: TaskInfo[];

  isAddingProvider: boolean;
  providerAddError: string | null;
  providerAddSuccess: string | null;
  providerModels: string[];
  providerModelsError: string | null;

  isExporting: boolean;
  exportedLink: ExportLink | null;
  exportError: string | null;

  isInspectorPresented: boolean;
  isSettingsPresented: boolean;
  isAgentSwitcherPresented: boolean;
  searchText: string;
  focusComposerToken: number;
  statusText: string | null;
  toast: NoticeRow | null;
}

export interface AppModelEnv {
  settingsStore?: SettingsStore;
  makeTransport?: () => FrameTransport;
  healthFetch?: (url: string) => Promise<HealthReport>;
  notifier?: NotificationBridge;
  healthPollMs?: number;
}

const PRIMARY_AGENTS = new Set(["ea", "agni"]);

export function isPrimaryAgent(agent: AgentInfo | null | undefined): boolean {
  return !agent || PRIMARY_AGENTS.has(agent.id);
}

function seedAgents(): AgentInfo[] {
  return [{ id: "ea", name: "Agni Bot", color: "#f0b95a", tools: [] }];
}

function notice(kind: NoticeKind, title: string, body: string, threadID: string | null = null): NoticeRow {
  return {
    id: `${kind}_${Math.random().toString(36).slice(2)}`,
    kind,
    title,
    body,
    createdAt: new Date(),
    threadID,
  };
}

export class AppModel {
  private readonly listeners = new Set<() => void>();
  private snapshotValue: AppSnapshot;

  private screen: AppScreen = "pairing";
  private connectionState: ConnectionState = { kind: "idle" };
  private settings: ServerSettings;
  private secretKind: SecretStoreKind | null = null;
  private tokenIsStored = false;
  private isCheckingServer = false;
  private isPairing = false;
  private pairingError: string | null = null;

  private conversation = new Conversation("ea");
  private threads: ThreadInfo[] = [];
  private agents: AgentInfo[] = seedAgents();
  /** Hidden specialists are absent from the sidebar but still addressable. */
  private mentionAgents: AgentInfo[] = seedAgents();
  /** The channel this client is bound to, when it bound itself to an agent. */
  private boundChannelID: string | null = null;
  private unread = new Set<string>();
  private agentStates: Record<string, "idle" | "working" | "waiting" | "blocked"> = {};

  private health: HealthReport | null = null;
  private healthError: string | null = null;
  private configuredProviders: ProviderStatus[] = [];
  private plugins: PluginInfo[] = [];
  private jobs: JobInfo[] = [];
  private tasks: TaskInfo[] = [];

  private isAddingProvider = false;
  private providerAddError: string | null = null;
  private providerAddSuccess: string | null = null;
  private providerModels: string[] = [];
  private providerModelsError: string | null = null;
  private pendingProviderID: string | null = null;

  private isExporting = false;
  private exportedLink: ExportLink | null = null;
  private exportError: string | null = null;

  private isInspectorPresented = false;
  private isSettingsPresented = false;
  private isAgentSwitcherPresented = false;
  private searchText = "";
  private focusComposerToken = 0;
  private statusText: string | null = null;
  private toast: NoticeRow | null = null;

  private connection: AgniConnection | null = null;
  private pendingPairing: { settings: ServerSettings; token: string } | null = null;
  private token = "";

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  private readonly settingsStore: SettingsStore;
  private readonly notifier: NotificationBridge;
  private readonly healthFetch: (url: string) => Promise<HealthReport>;
  private readonly makeTransport: (() => FrameTransport) | undefined;
  private readonly healthPollMs: number;

  constructor(env: AppModelEnv = {}) {
    this.settingsStore = env.settingsStore ?? new SettingsStore();
    this.notifier = env.notifier ?? browserNotifications;
    this.healthFetch = env.healthFetch ?? ((url) => fetchHealth(url));
    this.makeTransport = env.makeTransport;
    this.healthPollMs = env.healthPollMs ?? 20_000;
    this.settings = this.settingsStore.load();
    const stored = SecretStore.load();
    if (stored) {
      this.token = stored.token;
      this.secretKind = stored.kind;
      this.tokenIsStored = true;
    }
    this.snapshotValue = this.buildSnapshot();
    this.publish();
  }

  // MARK: store plumbing

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppSnapshot => this.snapshotValue;

  private buildSnapshot(): AppSnapshot {
    return {
      screen: this.screen,
      connectionState: this.connectionState,
      settings: this.settings,
      secretKind: this.secretKind,
      tokenIsStored: this.tokenIsStored,
      isCheckingServer: this.isCheckingServer,
      isPairing: this.isPairing,
      pairingError: this.pairingError,
      conversation: this.conversation,
      threads: this.threads,
      agents: this.agents,
      mentionAgents: this.mentionAgents,
      unread: new Set(this.unread),
      agentStates: { ...this.agentStates },
      health: this.health,
      healthError: this.healthError,
      configuredProviders: this.configuredProviders,
      plugins: this.plugins,
      jobs: this.jobs,
      tasks: this.tasks,
      isAddingProvider: this.isAddingProvider,
      providerAddError: this.providerAddError,
      providerAddSuccess: this.providerAddSuccess,
      providerModels: this.providerModels,
      providerModelsError: this.providerModelsError,
      isExporting: this.isExporting,
      exportedLink: this.exportedLink,
      exportError: this.exportError,
      isInspectorPresented: this.isInspectorPresented,
      isSettingsPresented: this.isSettingsPresented,
      isAgentSwitcherPresented: this.isAgentSwitcherPresented,
      searchText: this.searchText,
      focusComposerToken: this.focusComposerToken,
      statusText: this.statusText,
      toast: this.toast,
    };
  }

  private publish(): void {
    this.snapshotValue = this.buildSnapshot();
    for (const listener of this.listeners) listener();
    if (typeof document !== "undefined") {
      document.title = this.agent?.name ?? "Agni";
    }
  }

  // MARK: lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    this.notifier.request();
    this.screen = this.canConnect ? "chat" : "pairing";
    this.publish();
    if (this.canConnect) this.connect();
  }

  get canConnect(): boolean {
    return this.token.length > 0 && websocketURL(this.settings) !== null;
  }

  get agent(): AgentInfo | null {
    // A hidden specialist reached through `@name` is not in the sidebar but
    // is still the agent this conversation belongs to.
    return (
      this.mentionAgents.find((agent) => agent.id === this.conversation.agentID) ??
      this.agents.find((agent) => agent.id === this.conversation.agentID) ??
      this.agents[0] ??
      null
    );
  }

  get activeThreadTitle(): string | null {
    return this.conversation.title;
  }

  get serverAddress(): string {
    return this.settings.url;
  }

  get tokenForConnectionForm(): string {
    return this.token;
  }

  /** Pairing: keep the token in browser storage, then open the socket. */
  pair(url: string, enteredToken: string, device: string): void {
    void this.performPair(url, enteredToken, device);
  }

  private async performPair(url: string, enteredToken: string, device: string): Promise<void> {
    const name = device.trim().length === 0 ? "This Browser" : device.trim();
    const candidate: ServerSettings = {
      url: url.trim(),
      deviceName: name,
      lastSeq: 0,
    };
    if (!websocketURL(candidate)) {
      this.pairingError =
        "That is not a server address. Try 127.0.0.1:8787, or ws://100.x.x.x:8787/ws for Tailscale.";
      this.publish();
      return;
    }
    const candidateToken = enteredToken.trim();
    if (candidateToken.length === 0) {
      this.pairingError = "A device token is required — mint one with bun run pair.";
      this.publish();
      return;
    }

    this.pairingError = null;
    this.isCheckingServer = true;
    this.publish();
    try {
      const target = healthURL(candidate);
      if (!target) throw new Error("The server address could not be converted to a health URL.");
      const report = await this.healthFetch(target);
      if (!report.ok) throw new Error("The server health check did not return OK.");
      this.pendingPairing = { settings: candidate, token: candidateToken };
      this.isPairing = true;
      this.health = report;
      this.connect(candidate, candidateToken);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.pairingError = `Could not reach Agni at ${candidate.url}. Check that the daemon is running and the address is correct. ${detail}`;
    } finally {
      this.isCheckingServer = false;
      this.publish();
    }
  }

  editConnection(): void {
    this.pairingError = null;
    this.screen = "pairing";
    this.publish();
  }

  cancelConnectionEdit(): void {
    if (!this.tokenIsStored) return;
    this.pendingPairing = null;
    this.isPairing = false;
    this.connection?.stop();
    this.connection = null;
    this.screen = "chat";
    this.connect();
    this.publish();
  }

  forgetDevice(): void {
    this.disconnect();
    SecretStore.clear();
    this.token = "";
    this.tokenIsStored = false;
    this.secretKind = null;
    this.threads = [];
    this.agents = seedAgents();
    this.mentionAgents = seedAgents();
    this.conversation = new Conversation("ea");
    this.health = null;
    this.configuredProviders = [];
    this.jobs = [];
    this.tasks = [];
    this.plugins = [];
    this.settings = { ...this.settings, lastSeq: 0 };
    this.settingsStore.save(this.settings);
    this.screen = "pairing";
    this.publish();
  }

  private connect(targetSettings?: ServerSettings, targetToken?: string): void {
    const settings = { ...(targetSettings ?? this.settings) };
    const token = targetToken ?? this.token;
    if (token.length === 0 || !websocketURL(settings)) return;
    this.connection?.stop();
    const next = new AgniConnection({
      settings,
      token,
      ...(this.makeTransport ? { makeTransport: this.makeTransport } : {}),
    });
    next.onEvent = (event) => this.handle(event);
    this.connection = next;
    next.start();
  }

  private disconnect(): void {
    this.connection?.stop();
    this.connection = null;
    this.stopHealthPolling();
  }

  retryNow(): void {
    if (!this.connection) {
      this.connect();
      return;
    }
    this.connection.retryNow();
  }

  // MARK: intents

  /** Open (or resolve) the bound conversation surface for an agent. */
  openConversation(agentID: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void (async () => {
      await connection.send({ type: "agent.select", agentID }).catch(() => undefined);
      await connection
        .send({ type: "conversation.open", conversationID: "", agentID })
        .catch(() => undefined);
    })();
  }

  /** Re-request the surface's transcript — after reconnect, gap, or on demand. */
  reloadConversation(): void {
    const conversationID = this.conversation.conversationID;
    const connection = this.connection;
    if (!conversationID || !connection || !isReady(this.connectionState)) return;
    void (async () => {
      await connection
        .send({
          type: "conversation.open",
          conversationID,
          agentID: this.conversation.agentID,
        })
        .catch(() => undefined);
      await connection
        .send({ type: "conversation.history", conversationID, limit: 400 })
        .catch(() => undefined);
    })();
  }

  refreshThreadList(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "thread.list", limit: 100 }).catch(() => undefined);
  }

  refreshJobs(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "job.list", limit: 50 }).catch(() => undefined);
  }

  refreshTasks(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "task.list", status: "all", limit: 200 }).catch(() => undefined);
  }

  refreshPlugins(): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "plugin.list" }).catch(() => undefined);
  }

  /**
   * Render the open conversation to a shareable HTML document on the daemon.
   * The daemon does the rendering, so the file is identical no matter which
   * client asked, and the link works for someone who has never run the app.
   */
  exportConversation(): void {
    this.exportedLink = null;
    this.exportError = null;
    const conversationID = this.conversation.conversationID;
    const connection = this.connection;
    if (!conversationID || !connection || !isReady(this.connectionState)) {
      this.exportError = "Open a conversation first — there is nothing to export yet.";
      this.publish();
      return;
    }
    this.isExporting = true;
    this.publish();
    void connection.send({ type: "thread.export", conversationID }).catch((error: unknown) => {
      this.isExporting = false;
      this.exportError = `Could not reach the daemon: ${error instanceof Error ? error.message : String(error)}`;
      this.publish();
    });
  }

  connectPlugin(pluginID: string, account: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection
      .send({ type: "plugin.connect", pluginID, account: account as "agent" | "owner" })
      .catch(() => undefined);
  }

  /**
   * Send a plugin's credentials to the daemon and connect it. The daemon
   * writes them to its own mode-600 plugins.json; this process keeps nothing.
   */
  configurePlugin(
    pluginID: string,
    account: string,
    credentials: {
      user?: string;
      pass?: string;
      key?: string;
      url?: string;
      clientID?: string;
      clientSecret?: string;
    },
  ): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.showToast(notice("info", "Plugin", "Connect to the daemon before connecting a plugin."));
      return;
    }
    void connection
      .send({
        type: "plugin.configure",
        pluginID,
        account: account as "agent" | "owner",
        ...credentials,
      })
      .catch(() => undefined);
  }

  disconnectPlugin(connectionID: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    void connection.send({ type: "plugin.disconnect", connectionID }).catch(() => undefined);
  }

  updateTask(task: TaskInfo, action: "done" | "reopen" | "snooze" | "cancel", until?: Date): void {
    const connection = this.connection;
    if (!connection) return;
    void connection
      .send({
        type: "task.update",
        taskID: task.id,
        action,
        ...(until ? { until: until.toISOString() } : {}),
      })
      .catch(() => undefined);
  }

  /**
   * DEL-006: answer a question a delegated task asked. Its own frame, so a
   * normal message can never resume a task by accident.
   */
  answerTask(taskID: string, questionID: string, text: string): void {
    const connection = this.connection;
    const answer = text.trim();
    if (!connection || !answer) return;
    void connection.send({ type: "task.answer", taskID, questionID, text: answer }).catch(() => undefined);
  }

  /** Pin this client to an agent's conversation and its DM channel. */
  bindDirect(agentID: string): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "bind.direct", agentID }).catch(() => undefined);
  }

  /** Resolve a leading `@name`/`@id` against the visible roster. */
  private resolveMention(text: string): { agent: AgentInfo; text: string } | null {
    const prefix = /^\s*@/.exec(text);
    if (!prefix) return null;
    const after = text.slice(prefix[0].length);
    const lowered = after.toLowerCase();
    const roster = new Map<string, AgentInfo>();
    for (const agent of [...this.agents, ...this.mentionAgents]) roster.set(agent.id, agent);
    const candidates = [...roster.values()].sort(
      (a, b) => Math.max(b.id.length, b.name.length) - Math.max(a.id.length, a.name.length),
    );
    for (const agent of candidates) {
      for (const name of [agent.id, agent.name]) {
        const needle = name.toLowerCase();
        if (!lowered.startsWith(needle)) continue;
        const boundary = after.slice(needle.length);
        // A mention ends at whitespace or punctuation; `@fridayish` is not a
        // message to Friday.
        if (boundary !== "" && !/^[\s,:;.!?-]/.test(boundary)) continue;
        return { agent, text: boundary.replace(/^[\s,:;.!?-]+/, "").trim() };
      }
    }
    return null;
  }

  send(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // `@friday write the email` opens Friday's chat and sends there, the way
    // a messaging app treats an address. The server routes it too, but the
    // surface has to follow or the reply would stream into a chat the owner
    // is not looking at.
    const mention = this.resolveMention(trimmed);
    if (mention && mention.agent.id !== this.conversation.agentID) this.selectAgent(mention.agent);
    const outgoing = mention ? mention.text : trimmed;
    if (outgoing.length === 0) return;
    const localID = this.conversation.appendLocalUserMessage(outgoing);
    this.publish();
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.conversation.markLocalFailure(localID, "Not connected — this message was not sent.");
      this.showToast(
        notice("failure", "Not connected", "Reconnecting. Your message was kept in the list but was not sent."),
      );
      this.publish();
      return;
    }
    const specialistID = this.conversation.agentID === "ea" ? undefined : this.conversation.agentID;
    const channelID = this.boundChannelID ?? (specialistID ? `dm:${specialistID}` : "main");
    void connection
      .send({
        type: "msg.send",
        text: outgoing,
        channelId: channelID,
        ...(specialistID ? { toAgentId: specialistID } : {}),
      })
      .catch((error: unknown) => {
        this.conversation.markLocalFailure(
          localID,
          `Send failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.publish();
      });
  }

  renameAgent(name: string, agentID = "ea"): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "agent.rename", agentId: agentID, name }).catch(() => undefined);
  }

  updateTypingState(isTyping: boolean): void {
    if (this.typingTimer !== null) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    const channelID = this.conversation.agentID === "ea" ? "main" : `dm:${this.conversation.agentID}`;
    void connection.send({ type: "user.typing", channelId: channelID, isTyping }).catch(() => undefined);
    if (!isTyping) return;
    this.typingTimer = setTimeout(() => this.updateTypingState(false), 1000);
  }

  stopTurn(): void {
    const turnID = this.conversation.inFlightTurnID;
    const connection = this.connection;
    if (!turnID || !connection) return;
    void connection.send({ type: "msg.cancel", turnID }).catch(() => undefined);
  }

  answer(approval: ApprovalRow, decision: string): void {
    this.conversation.resolveApproval(approval.id, decision);
    this.publish();
    const connection = this.connection;
    if (!connection) return;
    void connection
      .send({ type: "approve.reply", requestID: approval.id, decision: decision as "once" | "always" | "reject" })
      .catch(() => undefined);
  }

  answerForm(form: FormRow, option: string): void {
    this.conversation.resolveForm(form.id, option);
    this.send(option);
  }

  /**
   * Send a one-time secret. The value is never put into app state or the
   * transcript; the row disappears before the frame leaves.
   */
  submitSecret(secret: SecretRow, value: string): void {
    this.conversation.resolveSecret(secret.id);
    this.publish();
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "secret.reply", requestID: secret.id, value }).catch(() => undefined);
  }

  cancelSecret(secret: SecretRow): void {
    this.conversation.resolveSecret(secret.id);
    this.publish();
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "secret.cancel", requestID: secret.id }).catch(() => undefined);
  }

  selectAgent(agent: AgentInfo): void {
    if (agent.id === this.conversation.agentID && this.conversation.conversationID !== null) {
      this.reloadConversation();
      return;
    }
    this.conversation = new Conversation(agent.id);
    const agentThread = this.threads.find((thread) => thread.agentID === agent.id);
    if (agentThread) this.unread.delete(agentThread.id);
    this.openConversation(agent.id);
    this.focusComposer();
    this.publish();
  }

  /** A notification names a session block; the surface is the agent's conversation. */
  openThreadFromNotification(threadID: string): void {
    const thread = this.threads.find((candidate) => candidate.id === threadID);
    const agent = thread ? this.agents.find((candidate) => candidate.id === thread.agentID) : undefined;
    if (agent) this.selectAgent(agent);
    else this.reloadConversation();
  }

  setRoutine(job: JobInfo, enabled: boolean): void {
    const connection = this.connection;
    if (!connection) return;
    void connection
      .send({ type: "job.set", jobID: job.id, action: enabled ? "resume" : "pause" })
      .catch(() => undefined);
  }

  runRoutine(job: JobInfo): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "job.set", jobID: job.id, action: "run" }).catch(() => undefined);
  }

  openTask(_job: JobInfo): void {
    // A task's results land as session blocks inside the agent's one
    // conversation — there is no separate chat window to open.
    this.reloadConversation();
    this.focusComposer();
  }

  deleteTask(job: JobInfo): void {
    const connection = this.connection;
    if (!connection || job.state === "running") return;
    void connection.send({ type: "job.delete", jobID: job.id }).catch(() => undefined);
  }

  addProvider(providerID: string, apiKey: string, model?: string, baseUrl?: string, label?: string): void {
    const key = apiKey.trim();
    if (key.length === 0) {
      this.providerAddError = "Enter an API key.";
      this.publish();
      return;
    }
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.providerAddError = "Connect to the daemon before adding a provider.";
      this.publish();
      return;
    }
    this.isAddingProvider = true;
    this.providerAddError = null;
    this.providerAddSuccess = null;
    this.pendingProviderID = providerID;
    this.publish();
    void connection
      .send({
        type: "provider.add",
        providerID: providerID as "groq" | "cerebras" | "nim" | "gemini" | "openrouter" | "custom",
        apiKey: key,
        ...(model ? { model } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(label ? { label } : {}),
      })
      .catch((error: unknown) => {
        this.isAddingProvider = false;
        this.pendingProviderID = null;
        this.providerAddError = `Could not send the provider key: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publish();
      });
  }

  setProviderModel(providerID: string, model: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.providerAddError = "Connect to the daemon before changing a model.";
      this.publish();
      return;
    }
    this.isAddingProvider = true;
    this.pendingProviderID = providerID;
    this.providerAddError = null;
    this.providerAddSuccess = null;
    this.publish();
    void connection
      .send({
        type: "provider.model.set",
        providerID: providerID as "groq" | "cerebras" | "nim" | "gemini" | "openrouter",
        model,
      })
      .catch((error: unknown) => {
        this.isAddingProvider = false;
        this.pendingProviderID = null;
        this.providerAddError = `Could not update the model: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publish();
      });
  }

  loadProviderModels(providerID: string): void {
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.providerModelsError = "Connect to the daemon to load available models.";
      this.publish();
      return;
    }
    this.providerModels = [];
    this.providerModelsError = null;
    this.publish();
    void connection
      .send({
        type: "provider.models.list",
        providerID,
      })
      .catch((error: unknown) => {
        this.providerModelsError = `Could not request models: ${
          error instanceof Error ? error.message : String(error)
        }`;
        this.publish();
      });
  }

  prepareToAddProvider(): void {
    this.providerAddError = null;
    this.providerAddSuccess = null;
    this.pendingProviderID = null;
    this.publish();
  }

  // MARK: chrome

  setSearchText(text: string): void {
    this.searchText = text;
    this.publish();
  }

  focusComposer(): void {
    this.focusComposerToken += 1;
    this.publish();
  }

  dismissToast(): void {
    this.toast = null;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.publish();
  }

  toggleInspector(): void {
    this.isInspectorPresented = !this.isInspectorPresented;
    this.publish();
  }

  openSettings(): void {
    this.isSettingsPresented = true;
    this.publish();
  }

  closeSettings(): void {
    this.isSettingsPresented = false;
    this.publish();
  }

  openAgentSwitcher(): void {
    this.isAgentSwitcherPresented = true;
    this.publish();
  }

  closeAgentSwitcher(): void {
    this.isAgentSwitcherPresented = false;
    this.publish();
  }

  // MARK: derived views

  unreadBlocks(agentID: string): boolean {
    return [...this.unread].some((id) => this.threads.find((thread) => thread.id === id)?.agentID === agentID);
  }

  get filteredAgents(): AgentInfo[] {
    const query = this.searchText.trim().toLowerCase();
    if (query.length === 0) return this.agents;
    return this.agents.filter(
      (agent) => agent.name.toLowerCase().includes(query) || (agent.model ?? "").toLowerCase().includes(query),
    );
  }

  get filteredJobs(): JobInfo[] {
    const query = this.searchText.trim().toLowerCase();
    if (query.length === 0) return this.jobs;
    return this.jobs.filter(
      (job) =>
        (job.title ?? "").toLowerCase().includes(query) ||
        job.kind.toLowerCase().includes(query) ||
        job.state.toLowerCase().includes(query),
    );
  }

  // MARK: connection events

  private handle(event: ConnectionEvent): void {
    switch (event.type) {
      case "state": {
        const wasReady = isReady(this.connectionState);
        this.connectionState = event.state;
        switch (event.state.kind) {
          case "ready": {
            if (this.pendingPairing) {
              const accepted = { ...this.pendingPairing.settings };
              accepted.lastSeq = this.connection?.lastSeq ?? accepted.lastSeq;
              this.settings = accepted;
              this.token = this.pendingPairing.token;
              this.secretKind = SecretStore.save(this.pendingPairing.token);
              this.tokenIsStored = true;
              this.settingsStore.save(this.settings);
              this.pendingPairing = null;
              this.isPairing = false;
              this.screen = "chat";
            }
            this.refreshThreadList();
            this.refreshJobs();
            this.refreshTasks();
            this.refreshPlugins();
            this.startHealthPolling();
            if (!wasReady) this.openConversation(this.conversation.agentID);
            break;
          }
          case "refused":
            if (this.pendingPairing) {
              this.pairingError = event.state.reason;
              this.pendingPairing = null;
              this.isPairing = false;
            } else {
              this.notifyUser("Agni cannot connect", event.state.reason);
            }
            break;
          case "waiting":
            this.stopHealthPolling();
            break;
          default:
            break;
        }
        this.publish();
        return;
      }

      case "frame":
        this.handleFrame(event.frame);
        return;

      case "malformed":
        this.conversation.note(notice("failure", "Unreadable frame", event.detail));
        this.publish();
        return;

      case "durableReloadRequired":
        this.conversation.note(
          notice(
            "info",
            "Reloaded history",
            "The daemon could not replay that far back, so this conversation was reloaded from the database.",
          ),
        );
        this.refreshThreadList();
        this.reloadConversation();
        this.publish();
        return;

      case "lastSeq":
        this.settings = { ...this.settings, lastSeq: event.seq };
        this.settingsStore.save(this.settings);
        this.publish();
        return;
    }
  }

  private activeChannel(): string {
    return this.conversation.agentID === "ea" ? "main" : `dm:${this.conversation.agentID}`;
  }

  private handleFrame(frame: IncomingFrame): void {
    // A frame type this build does not know is data, not an instruction.
    if (!isKnownFrame(frame)) return;

    // AppModel owns channel routing; the reducer owns the transcript.
    if (frame.type === "status.update") {
      if (frame.channelId === this.activeChannel()) {
        this.statusText = frame.transient ? frame.text : null;
        this.publish();
      }
      return;
    }

    if (frame.type === "msg.new") {
      if (frame.channelId !== this.activeChannel() || frame.internal) return;
      this.statusText = null;
      this.run(this.conversation.apply(frame));
      this.publish();
      return;
    }

    if (frame.type === "agent.updated") {
      const rename = (agent: AgentInfo): AgentInfo =>
        agent.id === frame.agentId
          ? { ...agent, name: frame.displayName, onboarded: frame.onboarded }
          : agent;
      this.agents = this.agents.map(rename);
      this.mentionAgents = this.mentionAgents.map(rename);
      this.conversation.apply(frame);
      this.publish();
      return;
    }

    if (frame.type === "thread.list.ok") {
      this.threads = [...frame.threads].sort((a, b) => {
        if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      });
      this.publish();
      return;
    }

    if (frame.type === "conversation.ok") {
      // A reply for the agent the owner has already navigated away from must
      // not drag the surface back: the frames carry no request id, so the
      // agent they name is what tells a live reply from a stale one.
      if (frame.agentID !== this.conversation.agentID) return;
      const freshSurface = this.conversation.conversationID !== frame.conversationID;
      if (freshSurface) {
        this.conversation.bind(
          frame.conversationID,
          frame.agentID,
          frame.sessionID.length === 0 ? null : frame.sessionID,
        );
      } else if (frame.sessionID.length > 0) {
        this.conversation.startSession(frame.sessionID, frame.conversationID);
      }
      const connection = this.connection;
      if (connection && isReady(this.connectionState)) {
        void connection
          .send({ type: "conversation.history", conversationID: frame.conversationID, limit: 400 })
          .catch(() => undefined);
      }
      this.publish();
      return;
    }

    if (frame.type === "thread.export.ok") {
      this.isExporting = false;
      this.exportError = null;
      this.exportedLink = { url: frame.url, token: frame.token, records: frame.records };
      this.publish();
      return;
    }

    if (frame.type === "conversation.history.ok") {
      // Same seam: a transcript for a conversation the owner has left is not
      // the one on screen.
      if (frame.conversationID !== this.conversation.conversationID) return;
      this.conversation.loadConversationHistory(
        frame.conversationID,
        this.conversation.agentID,
        frame.messages,
      );
      if (this.conversation.threadID === null) {
        const connection = this.connection;
        if (connection && isReady(this.connectionState)) {
          void connection
            .send({
              type: "conversation.open",
              conversationID: frame.conversationID,
              agentID: this.conversation.agentID,
            })
            .catch(() => undefined);
        }
      }
      this.publish();
      return;
    }

    if (frame.type === "job.list.ok") {
      this.jobs = frame.jobs;
      this.publish();
      return;
    }

    if (frame.type === "task.list.ok") {
      this.tasks = frame.tasks;
      this.publish();
      return;
    }

    if (frame.type === "task.update.ok") {
      const index = this.tasks.findIndex((task) => task.id === frame.task.id);
      if (index === -1) this.tasks = [...this.tasks, frame.task];
      else this.tasks = this.tasks.map((task) => (task.id === frame.task.id ? frame.task : task));
      this.publish();
      return;
    }

    if (frame.type === "provider.add.ok") {
      this.configuredProviders = frame.providers.map((provider) => {
        const maybeTiers = (provider as { tiers?: string[] }).tiers;
        return {
          id: provider.id,
          label: provider.label,
          model: provider.model,
          tiers: maybeTiers ?? [],
          available: provider.available,
          cooldownRemainingMs: Math.trunc(provider.cooldownRemainingMs),
          ...(provider.lastError !== undefined ? { lastError: provider.lastError } : {}),
          ...(provider.lastSuccessAt !== undefined ? { lastSuccessAt: provider.lastSuccessAt } : {}),
        };
      });
      if (this.health) this.health = { ...this.health, providers: this.configuredProviders };
      const added = frame.providers.find((provider) => provider.id === this.pendingProviderID);
      this.providerAddSuccess = `${added?.label ?? "Provider"} is configured with ${
        added?.model ?? "the selected model"
      }.`;
      this.providerAddError = null;
      this.isAddingProvider = false;
      this.pendingProviderID = null;
      this.publish();
      return;
    }

    if (frame.type === "provider.models.ok") {
      this.providerModels = frame.models;
      this.providerModelsError = null;
      this.publish();
      return;
    }

    if (frame.type === "plugin.list.ok" || frame.type === "plugin.state") {
      this.plugins = frame.plugins;
      this.publish();
      return;
    }

    if (frame.type === "plugin.connect.ok") {
      if (frame.authorizeURL && typeof window !== "undefined") {
        window.open(frame.authorizeURL, "_blank", "noopener,noreferrer");
      }
      this.publish();
      return;
    }

    if (frame.type === "hello.ok") return;

    if (frame.type === "error") {
      if (
        this.isAddingProvider &&
        ["unknown_provider", "invalid_key", "provider_exists", "provider_storage"].includes(frame.code)
      ) {
        this.providerAddError = frame.message;
        this.isAddingProvider = false;
        this.pendingProviderID = null;
        this.publish();
        return;
      }
      if (frame.code === "provider_models") {
        this.providerModelsError = frame.message;
        this.publish();
        return;
      }
      if (
        [
          "unknown_plugin",
          "unknown_connection",
          "plugin_not_configured",
          "plugin_unavailable",
          "plugin_connect_failed",
        ].includes(frame.code)
      ) {
        this.showToast(notice("info", "Plugin", frame.message));
        return;
      }
      if (frame.code === "unknown_conversation") {
        this.conversation.conversationID = null;
        this.openConversation(this.conversation.agentID);
        this.publish();
        return;
      }
      if (frame.code === "export_failed") {
        this.isExporting = false;
        this.exportError = frame.message;
        this.publish();
        return;
      }
    }

    if (frame.type === "agents.update" && frame.mentions) this.mentionAgents = frame.mentions;
    const effects = this.conversation.apply(frame);
    if (frame.type === "turn.end" || frame.type === "turn.start") this.refreshThreadList();
    this.run(effects);
    this.publish();
  }

  private run(effects: ConversationEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case "refreshThreadList":
          this.refreshThreadList();
          break;
        case "reloadDurableState":
          this.refreshThreadList();
          this.reloadConversation();
          break;
        case "notify":
          this.notifyUser(effect.title, effect.body, effect.sound, effect.threadID);
          break;
        case "focusComposer":
          this.focusComposer();
          break;
        case "unread":
          if (effect.threadID !== this.conversation.threadID) this.unread.add(effect.threadID);
          break;
        case "agentsChanged":
          if (JSON.stringify(effect.agents) !== JSON.stringify(this.agents)) this.agents = effect.agents;
          break;
        case "taskChanged":
          this.tasks = this.tasks.map((task) => (task.id === effect.task.id ? effect.task : task));
          break;
        case "bound":
          // The server resolved the agent's conversation and channel; the
          // client follows it from here.
          this.conversation.bind(effect.conversationID, effect.agentID, effect.sessionID || null);
          this.boundChannelID = effect.channelID;
          break;
        case "agentPresence":
          // What the agent is doing: the owner can tell "working" from
          // "waiting for you" without asking.
          this.agentStates = { ...this.agentStates, [effect.agentID]: effect.state };
          break;
        case "presence":
          break;
      }
    }
  }

  // MARK: health

  private startHealthPolling(): void {
    this.stopHealthPolling();
    if (this.healthPollMs <= 0) return;
    void this.refreshHealth();
    this.healthTimer = setInterval(() => void this.refreshHealth(), this.healthPollMs);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer !== null) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  async refreshHealth(): Promise<void> {
    const url = healthURL(this.settings);
    if (!url) return;
    try {
      const report = await this.healthFetch(url);
      this.health = report;
      this.configuredProviders = report.providers;
      this.healthError = null;
    } catch (error) {
      this.healthError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  async refreshSettingsData(): Promise<void> {
    await this.refreshHealth();
    this.refreshJobs();
    this.refreshTasks();
    this.refreshPlugins();
  }

  // MARK: notifications

  private notifyUser(title: string, body: string, sound = false, threadID?: string): void {
    this.showToast(notice("info", title, body, threadID ?? null));
    this.notifier.post(title, body, sound, threadID, (id) => this.openThreadFromNotification(id));
  }

  private showToast(row: NoticeRow): void {
    this.toast = row;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.publish();
    }, 6000);
    this.publish();
  }
}

export type { ChatMessage };
