import { AttachmentInfoSchema, type AttachmentInfo } from "@agni/client";
import { AppearanceProfileSchema, type AppearanceProfile } from "@agni/protocol";
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
  type ChatGPTConnection,
  type ConnectionEvent,
  type ConnectionState,
  type ConversationEffect,
  type FormRow,
  type FrameTransport,
  type HealthReport,
  type IncomingFrame,
  type JobInfo,
  type MemoryItem,
  type NoticeKind,
  type NoticeRow,
  type PluginInfo,
  type ProviderStatus,
  type SecretRow,
  type SecretStoreKind,
  type ServerSettings,
  type TaskInfo,
  type TaskListInfo,
  type TaskActivityInfo,
  type ThreadInfo,
} from "@agni/client";
import { browserNotifications, type NotificationBridge } from "./notifications";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./preferences";
import { cacheAppearance, defaultAppearance, loadCachedAppearance } from "../appearance";

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
  /** What the agent can remember, filtered the way retrieval filters it. */
  memories: MemoryItem[];

  health: HealthReport | null;
  healthError: string | null;
  configuredProviders: ProviderStatus[];
  plugins: PluginInfo[];
  jobs: JobInfo[];
  tasks: TaskInfo[];
  taskLists: TaskListInfo[];
  taskActivity: { taskID: string; entries: TaskActivityInfo[] } | null;
  taskView: { kind: "today" | "inbox" | "upcoming" | "calendar" | "completed" | "list"; listID?: string };

  isAddingProvider: boolean;
  providerAddError: string | null;
  providerAddSuccess: string | null;
  providerModels: string[];
  providerModelsError: string | null;
  chatgpt: ChatGPTConnection | null;
  chatgptLogin: { loginID: string; authorizeURL: string; expiresAt: string } | null;
  chatgptBusy: boolean;
  chatgptError: string | null;

  isExporting: boolean;
  exportedLink: ExportLink | null;
  exportError: string | null;

  isInspectorPresented: boolean;
  /** The full-screen bot debugger is open. */
  isDebugPresented: boolean;
  /** The left pane is showing the task/reminder list instead of the roster. */
  isTasksPresented: boolean;
  isSettingsPresented: boolean;
  isAgentSwitcherPresented: boolean;
  /** The composer's "To:" list: pick who the chat is with, or make a new agent. */
  isNewChatPresented: boolean;
  /** Phone layout: the agent roster slides in over the conversation. */
  isSidebarPresented: boolean;
  /** The agent's own profile panel, opened from the header pill. */
  isAgentProfilePresented: boolean;
  /** Browser-local preferences: the switches in Settings. */
  preferences: Preferences;
  appearance: AppearanceProfile;
  appearanceProfiles: AppearanceProfile[];
  /** A message the transcript should scroll to (from search). */
  focusMessageID: string | null;
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
  return [{ id: "ea", name: "New Bot", color: "#f0b95a", tools: [] }];
}

/** What the "+" button makes: an agent with a placeholder name, not a form. */
const NEW_AGENT_NAME = "New bot";
const NEW_AGENT_ROLE = "unnamed";
const NEW_AGENT_PROMPT = `You are {name}, an agent {user} just created in the app. You have no job description yet.

Open with one short line, then ask two things: what they want to call you, and what you should do for them.
When they give you a name, call rename_agent so the app shows it — do not simply agree in prose.
When they describe your job, call update_agent with a short role and a prompt written as instructions to yourself.
Until then, answer what is asked, briefly.`;

/** The slug the daemon derives from a name, so both sides land on one id. */
function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "agent";
}

/**
 * The name and id for the next placeholder bot: "New bot", then "New bot 2",
 * and so on past any the roster already has — including ones renamed since,
 * whose id still holds the slot.
 */
export function nextNewAgent(known: readonly AgentInfo[]): { id: string; name: string } {
  const takenIDs = new Set(known.map((agent) => agent.id));
  const takenNames = new Set(known.map((agent) => agent.name.trim().toLowerCase()));
  let name = NEW_AGENT_NAME;
  for (let n = 2; takenIDs.has(agentSlug(name)) || takenNames.has(name.toLowerCase()); n += 1) {
    name = `${NEW_AGENT_NAME} ${n}`;
  }
  return { id: agentSlug(name), name };
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
  private memories: MemoryItem[] = [];

  private health: HealthReport | null = null;
  private healthError: string | null = null;
  private configuredProviders: ProviderStatus[] = [];
  private plugins: PluginInfo[] = [];
  private jobs: JobInfo[] = [];
  private tasks: TaskInfo[] = [];
  private taskLists: TaskListInfo[] = [];
  private taskActivity: AppSnapshot["taskActivity"] = null;
  private taskView: AppSnapshot["taskView"] = { kind: "today" };
  private pendingAgentRoute: string | null = null;

  private isAddingProvider = false;
  private providerAddError: string | null = null;
  private providerAddSuccess: string | null = null;
  private providerModels: string[] = [];
  private providerModelsError: string | null = null;
  private pendingProviderID: string | null = null;
  private chatgpt: ChatGPTConnection | null = null;
  private chatgptLogin: AppSnapshot["chatgptLogin"] = null;
  private chatgptBusy = false;
  private chatgptError: string | null = null;
  private chatgptPopup: Window | null = null;
  private chatgptStartCancelled = false;

  private isExporting = false;
  private exportedLink: ExportLink | null = null;
  private exportError: string | null = null;

  private isInspectorPresented = false;
  private isDebugPresented = false;
  private isTasksPresented = false;
  private isSettingsPresented = false;
  private isAgentSwitcherPresented = false;
  private isNewChatPresented = false;
  private isSidebarPresented = false;
  private isAgentProfilePresented = false;
  private preferences: Preferences = loadPreferences();
  private appearance: AppearanceProfile = loadCachedAppearance();
  private appearanceProfiles: AppearanceProfile[] = [this.appearance];
  private focusMessageID: string | null = null;
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
    this.applyLocationRoute(false);
    if (typeof window !== "undefined") window.addEventListener("popstate", this.onLocationChange);
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
      memories: this.memories,
      health: this.health,
      healthError: this.healthError,
      configuredProviders: this.configuredProviders,
      plugins: this.plugins,
      jobs: this.jobs,
      tasks: this.tasks,
      taskLists: this.taskLists,
      taskActivity: this.taskActivity,
      taskView: this.taskView,
      isAddingProvider: this.isAddingProvider,
      providerAddError: this.providerAddError,
      providerAddSuccess: this.providerAddSuccess,
      providerModels: this.providerModels,
      providerModelsError: this.providerModelsError,
      chatgpt: this.chatgpt,
      chatgptLogin: this.chatgptLogin,
      chatgptBusy: this.chatgptBusy,
      chatgptError: this.chatgptError,
      isExporting: this.isExporting,
      exportedLink: this.exportedLink,
      exportError: this.exportError,
      isInspectorPresented: this.isInspectorPresented,
      isDebugPresented: this.isDebugPresented,
      isTasksPresented: this.isTasksPresented,
      isSettingsPresented: this.isSettingsPresented,
      isAgentSwitcherPresented: this.isAgentSwitcherPresented,
      isNewChatPresented: this.isNewChatPresented,
      isSidebarPresented: this.isSidebarPresented,
      isAgentProfilePresented: this.isAgentProfilePresented,
      preferences: this.preferences,
      appearance: this.appearance,
      appearanceProfiles: this.appearanceProfiles,
      focusMessageID: this.focusMessageID,
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
    if (this.canConnect && typeof window !== "undefined" && window.location.pathname === "/") this.navigatePath(agentPath(this.agent));
    this.publish();
    if (this.canConnect) this.connect();
  }

  private onLocationChange = (): void => { this.applyLocationRoute(true); };

  private applyLocationRoute(refresh: boolean): void {
    if (typeof window === "undefined") return;
    const parts = decodeURIComponent(window.location.pathname).split("/").filter(Boolean);
    if (parts[0] === "tasks") {
      this.isTasksPresented = true;
      const kind = parts[1];
      this.taskView = kind === "inbox" ? { kind: "inbox" } : kind === "upcoming" ? { kind: "upcoming" } : kind === "calendar" ? { kind: "calendar" } : kind === "completed" ? { kind: "completed" } : kind === "collection" && parts[2] ? { kind: "list", listID: parts[2] } : { kind: "today" };
      this.pendingAgentRoute = null;
      if (refresh) this.refreshTasks();
    } else {
      this.isTasksPresented = false;
      this.taskView = { kind: "today" };
      this.pendingAgentRoute = parts[0] === "agent" ? parts[1] ?? null : null;
      if (this.pendingAgentRoute) this.syncAgentRoute();
    }
    this.publish();
  }

  private syncAgentRoute(): void {
    if (!this.pendingAgentRoute) return;
    const key = this.pendingAgentRoute.toLowerCase();
    const agent = [...this.mentionAgents, ...this.agents].find((item) => item.id.toLowerCase() === key || item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === key);
    if (!agent) return;
    this.pendingAgentRoute = null;
    this.selectAgent(agent, false);
  }

  private navigatePath(path: string): void {
    if (typeof window === "undefined" || window.location.pathname === path) return;
    window.history.pushState({}, "", path);
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
    this.cancelChatGPTLogin();
    this.chatgpt = null;
    this.chatgptError = null;
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

  selectTaskView(view: AppSnapshot["taskView"]): void {
    this.taskView = view;
    this.isTasksPresented = true;
    this.navigatePath(view.kind === "list" ? `/tasks/collection/${encodeURIComponent(view.listID ?? "lst_inbox")}` : view.kind === "today" ? "/tasks" : `/tasks/${view.kind}`);
    if (view.kind === "today" || view.kind === "inbox" || view.kind === "list") this.refreshTasks();
    this.publish();
  }

  createTask(input: { title: string; description?: string; dueAt?: Date; reminderAt?: Date; deadlineAt?: Date; labels?: string[]; repeatRule?: "none" | "daily" | "weekly" | "monthly"; priority?: "low" | "normal" | "high" | "urgent"; listID?: string; parentTaskID?: string; attachmentIDs?: string[] }): void {
    const connection = this.connection;
    const title = input.title.trim();
    if (!connection || !title) return;
    void connection.send({ type: "task.create", title, ...(input.description ? { description: input.description } : {}), ...(input.dueAt ? { dueAt: input.dueAt.toISOString() } : {}), ...(input.reminderAt ? { reminderAt: input.reminderAt.toISOString() } : {}), ...(input.deadlineAt ? { deadlineAt: input.deadlineAt.toISOString() } : {}), ...(input.labels ? { labels: input.labels } : {}), ...(input.repeatRule ? { repeatRule: input.repeatRule } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.listID ? { listID: input.listID } : {}), ...(input.parentTaskID ? { parentTaskID: input.parentTaskID } : {}), ...(input.attachmentIDs ? { attachmentIDs: input.attachmentIDs } : {}) }).catch(() => undefined);
  }

  createTaskList(name: string): void {
    const connection = this.connection;
    if (!connection || !name.trim()) return;
    void connection.send({ type: "task.list.create", name: name.trim() }).catch(() => undefined);
  }

  requestTaskActivity(taskID: string): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "task.activity", taskID }).catch(() => undefined);
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

  editTask(task: TaskInfo, fields: { title?: string; description?: string | null; dueAt?: Date | null; reminderAt?: Date | null; deadlineAt?: Date | null; labels?: string[]; workflowStatus?: "not_started" | "in_progress" | "ai_review"; progressNote?: string | null; repeatRule?: "none" | "daily" | "weekly" | "monthly"; priority?: "low" | "normal" | "high" | "urgent"; listID?: string }): void {
    const connection = this.connection;
    if (!connection) return;
    const { dueAt, reminderAt, deadlineAt, ...rest } = fields;
    void connection.send({ type: "task.update", taskID: task.id, action: "edit", ...rest, ...(dueAt !== undefined ? { dueAt: dueAt?.toISOString() ?? null } : {}), ...(reminderAt !== undefined ? { reminderAt: reminderAt?.toISOString() ?? null } : {}), ...(deadlineAt !== undefined ? { deadlineAt: deadlineAt?.toISOString() ?? null } : {}) }).catch(() => undefined);
  }

  handoffTask(task: TaskInfo, agent: AgentInfo): void {
    this.editTask(task, { workflowStatus: "in_progress", progressNote: `Handed off to ${agent.name}` });
    this.selectAgent(agent);
    this.send(`Please work on this task for me. Task ID: ${task.id}\nTitle: ${task.title}${task.description ? `\nDetails: ${task.description}` : ""}${task.dueAt ? `\nDue: ${task.dueAt}` : ""}${task.deadlineAt ? `\nDeadline: ${task.deadlineAt}` : ""}${task.labels?.length ? `\nLabels: ${task.labels.join(", ")}` : ""}\nUpdate the task's progressNote as you work so I can see what you are doing, add relevant labels if needed, and move its workflow status to AI review when your work is ready. Tell me what you did and what still needs my review.`);
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

  /** Ask what the agent can remember (PR 8). */
  refreshMemories(scope: "global_user" | "agent" = "global_user"): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "memory.list", scope, limit: 100 }).catch(() => undefined);
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

  send(text: string, attachments: AttachmentInfo[] = []): boolean {
    const content = text.trim() ? text : (attachments.length ? "Please review the attached files." : "");
    const trimmed = content.trim();
    if (trimmed.length === 0) return false;
    // `@friday write the email` opens Friday's chat and sends there, the way
    // a messaging app treats an address. The server routes it too, but the
    // surface has to follow or the reply would stream into a chat the owner
    // is not looking at.
    const mention = this.resolveMention(trimmed);
    if (mention && mention.agent.id !== this.conversation.agentID) this.selectAgent(mention.agent);
    const outgoing = mention ? mention.text : content;
    if (outgoing.length === 0) return false;
    const localID = this.conversation.appendLocalUserMessage(outgoing, new Date(), attachments);
    this.publish();
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) {
      this.conversation.markLocalFailure(localID, "Not connected — this message was not sent.");
      this.showToast(
        notice("failure", "Not connected", "Reconnecting. Your message was kept in the list but was not sent."),
      );
      this.publish();
      return false;
    }
    const specialistID = this.conversation.agentID === "ea" ? undefined : this.conversation.agentID;
    const channelID = this.boundChannelID ?? (specialistID ? `dm:${specialistID}` : "main");
    void connection
      .send({
        type: "msg.send",
        text: outgoing,
        ...(attachments.length ? { files: attachments.map((file) => file.id) } : {}),
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
    return true;
  }

  private async attachmentRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const base = healthURL(this.settings);
    if (!base || !this.token) throw new Error("Connect to the server first.");
    const response = await fetch(new URL(path, base), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Attachment request failed (${response.status}).`);
    }
    return response;
  }

  async uploadAttachment(file: File): Promise<AttachmentInfo> {
    const body = new FormData();
    body.append("file", file);
    const response = await this.attachmentRequest("/attachments", { method: "POST", body });
    const payload = await response.json() as { attachment: unknown };
    return AttachmentInfoSchema.parse(payload.attachment);
  }

  async uploadTaskAttachment(file: File): Promise<AttachmentInfo> {
    const body = new FormData();
    body.append("file", file);
    body.append("purpose", "task");
    const response = await this.attachmentRequest("/attachments", { method: "POST", body });
    const payload = await response.json() as { attachment: unknown };
    return AttachmentInfoSchema.parse(payload.attachment);
  }

  async removeDraftAttachment(id: string): Promise<void> {
    await this.attachmentRequest(`/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async attachmentBlob(id: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.attachmentRequest(`/attachments/${encodeURIComponent(id)}`, { signal })).blob();
  }

  async uploadBackground(file: File): Promise<{ id: string }> {
    const body = new FormData();
    body.append("file", file);
    const response = await this.attachmentRequest("/backgrounds", { method: "POST", body });
    return await response.json() as { id: string };
  }

  async backgroundBlob(id: string, signal?: AbortSignal): Promise<Blob> {
    return (await this.attachmentRequest(`/backgrounds/${encodeURIComponent(id)}`, { signal })).blob();
  }

  async removeBackground(id: string): Promise<void> {
    await this.attachmentRequest(`/backgrounds/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async sendAttachments(text: string, attachments: AttachmentInfo[], expectedAgentID?: string): Promise<void> {
    await this.attachmentRequest("/attachments/validate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: attachments.map((file) => file.id) }),
    });
    if (expectedAgentID && this.conversation.agentID !== expectedAgentID) throw new Error("The selected agent changed. Review your draft and send it again.");
    if (!this.send(text, attachments)) throw new Error("Not connected. Your draft has been kept; try again after reconnecting.");
  }

  renameAgent(name: string, agentID = "ea"): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "agent.rename", agentId: agentID, name }).catch(() => undefined);
  }

  /** Change an agent's tag (what it is for) and how much other agents see. */
  updateAgentProfile(
    agentID: string,
    changes: { role?: string; visibility?: "private" | "summary" | "shared" },
  ): void {
    const connection = this.connection;
    if (!connection) return;
    void connection.send({ type: "agent.profile", agentId: agentID, ...changes }).catch(() => undefined);
  }

  updateTypingState(isTyping: boolean): void {
    if (this.typingTimer !== null) clearTimeout(this.typingTimer);
    this.typingTimer = null;
    const connection = this.connection;
    if (!connection || !isReady(this.connectionState)) return;
    // The browser-local preference decides whether we tell the server at all.
    if (isTyping && !this.preferences.typingIndicator) return;
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

  /**
   * Answer a question the agent asked. The answer goes back on its own frame
   * so the turn waiting on it can carry on.
   */
  answerForm(form: FormRow, answer: string): void {
    this.conversation.resolveForm(form.id, answer);
    this.publish();
    const connection = this.connection;
    if (!connection) return;
    void connection
      .send({ type: "form.answer", requestID: form.id, answer })
      .catch(() => undefined);
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

  selectAgent(agent: AgentInfo, updateRoute = true): void {
    // Picking an agent from anywhere — the roster, the switcher, the new-chat
    // field — means the conversation is the surface again.
    this.closeSidebar();
    this.isTasksPresented = false;
    if (updateRoute) this.navigatePath(agentPath(agent));
    this.isNewChatPresented = false;
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
    this.chatgptError = null;
    this.refreshChatGPT();
    this.publish();
  }

  refreshChatGPT(): void {
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "provider.auth.status", providerID: "chatgpt" }).catch(() => {});
  }

  startChatGPTLogin(accountID?: string): void {
    if (!this.connection || !isReady(this.connectionState)) {
      this.chatgptError = "Connect to Agni before signing in to ChatGPT.";
      this.publish(); return;
    }
    const host = new URL(websocketURL(this.settings)!).hostname;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
      this.chatgptError = "Open Agni on the same computer as its server to sign in to ChatGPT.";
      this.publish(); return;
    }
    if (this.chatgptBusy || this.chatgpt?.status === "pending") return;
    this.chatgptStartCancelled = false;
    // Open during the user's click so popup blockers do not prevent OAuth.
    this.chatgptPopup = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
    if (this.chatgptPopup) this.chatgptPopup.opener = null;
    this.chatgptBusy = true; this.chatgptError = null; this.providerAddSuccess = null;
    this.publish();
    void this.connection.send({ type: "provider.auth.start", providerID: "chatgpt", ...(accountID ? { accountID } : {}) }).catch(() => {
      this.chatgptError = "Could not start ChatGPT sign-in. Try again.";
      this.chatgptBusy = false; this.chatgptPopup?.close(); this.chatgptPopup = null; this.publish();
    });
  }

  cancelChatGPTLogin(): void {
    this.chatgptStartCancelled = true;
    if (this.chatgptLogin) void this.connection?.send({ type: "provider.auth.cancel", providerID: "chatgpt", loginID: this.chatgptLogin.loginID }).catch(() => {});
    this.chatgptLogin = null; this.chatgptBusy = false;
    this.chatgptPopup?.close(); this.chatgptPopup = null; this.publish();
  }

  changeChatGPTAccount(accountID: string, disconnect = false): void {
    if (!this.connection || !isReady(this.connectionState) || this.chatgptBusy) return;
    this.chatgptBusy = true; this.chatgptError = null; this.publish();
    void this.connection.send({ type: disconnect ? "provider.auth.disconnect" : "provider.auth.select", providerID: "chatgpt", accountID }).catch(() => {
      this.chatgptBusy = false; this.chatgptError = "Could not update the ChatGPT account. Try again."; this.publish();
    });
  }

  acknowledgeChatGPTPlan(): void {
    const accountID = this.chatgpt?.activeAccountID;
    if (!this.connection || !accountID || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "provider.auth.acknowledge", providerID: "chatgpt", accountID }).catch(() => {
      this.chatgptError = "Could not save your preference. Please try again."; this.publish();
    });
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

  toggleDebug(): void {
    this.isDebugPresented = !this.isDebugPresented;
    this.publish();
  }

  /** Read the daemon's owner-only bot debugger data (GET /debug/*). */
  async debugData<T>(path: string, signal?: AbortSignal): Promise<T> {
    return await (await this.attachmentRequest(`/debug/${path}`, { signal })).json() as T;
  }

  /** Show the task/reminder list in place of the roster. */
  toggleTasks(): void {
    this.isTasksPresented = !this.isTasksPresented;
    if (this.isTasksPresented) {
      this.isSidebarPresented = false;
      this.refreshTasks();
      this.navigatePath("/tasks");
    } else {
      this.navigatePath(agentPath(this.agent));
    }
    this.publish();
  }

  closeTasks(): void {
    if (!this.isTasksPresented) return;
    this.isTasksPresented = false;
    this.navigatePath(agentPath(this.agent));
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
    this.isNewChatPresented = false;
    this.isAgentSwitcherPresented = true;
    this.publish();
  }

  closeAgentSwitcher(): void {
    this.isAgentSwitcherPresented = false;
    this.publish();
  }

  /**
   * The "To:" line at the top of the chat, opened by the roster's "+": one
   * field that both picks a conversation and makes a new agent.
   */
  openNewChat(): void {
    this.isAgentSwitcherPresented = false;
    this.isSidebarPresented = false;
    this.isNewChatPresented = true;
    this.publish();
  }

  closeNewChat(): void {
    if (!this.isNewChatPresented) return;
    this.isNewChatPresented = false;
    this.publish();
  }

  /** The phone roster drawer. */
  openSidebar(): void {
    this.isSidebarPresented = true;
    this.publish();
  }

  /** The agent's profile panel. */
  openAgentProfile(): void {
    this.isAgentProfilePresented = true;
    this.publish();
  }

  closeAgentProfile(): void {
    if (!this.isAgentProfilePresented) return;
    this.isAgentProfilePresented = false;
    this.publish();
  }

  closeSidebar(): void {
    if (!this.isSidebarPresented) return;
    this.isSidebarPresented = false;
    this.publish();
  }

  /** A preference switch, applied and stored at once. */
  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    if (this.preferences[key] === value) return;
    this.preferences = { ...this.preferences, [key]: value };
    savePreferences(this.preferences);
    if (key === "typingIndicator" && !value) this.updateTypingState(false);
    this.publish();
  }

  /** Pin an agent to the top of the roster, or unpin it. */
  toggleFavorite(agentID: string): void {
    const favorites = this.preferences.favorites.includes(agentID)
      ? this.preferences.favorites.filter((id) => id !== agentID)
      : [...this.preferences.favorites, agentID];
    this.setPreference("favorites", favorites);
  }

  /**
   * Make a new agent, the way the roster's "+" button does.
   *
   * Nothing is filled in first: the bot exists the moment you ask for it, as
   * "New bot", and the conversation opens so it can be named afterwards — by
   * telling it in chat (`rename_agent`) or in its profile. The id is asked for
   * here, rather than left to the server's slug, so the header has a real agent
   * to show while the frame is in flight; the roster then arrives from
   * `agents.update` and replaces this stand-in with the daemon's row.
   */
  startNewAgent(): void {
    const connection = this.connection;
    if (!connection) return;
    const { id, name } = nextNewAgent([...this.agents, ...this.mentionAgents]);
    const agent: AgentInfo = { id, name, role: NEW_AGENT_ROLE, tools: [] };
    this.agents = [...this.agents, agent];
    this.mentionAgents = [...this.mentionAgents, agent];
    void connection
      .send({
        type: "agent.create",
        id: agent.id,
        name,
        role: NEW_AGENT_ROLE,
        prompt: NEW_AGENT_PROMPT,
      })
      .catch(() => undefined);
    this.selectAgent(agent);
  }

  /** Scroll the transcript to a message (search results). */
  focusMessage(messageID: string): void {
    this.focusMessageID = messageID;
    this.publish();
  }

  clearFocusMessage(): void {
    if (this.focusMessageID === null) return;
    this.focusMessageID = null;
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
            this.refreshAppearance();
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
          ? {
              ...agent,
              name: frame.displayName,
              onboarded: frame.onboarded,
              role: frame.role ?? agent.role,
              visibility: frame.visibility ?? agent.visibility,
            }
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
      this.taskLists = frame.lists ?? this.taskLists;
      this.publish();
      return;
    }

    if (frame.type === "task.create.ok") {
      this.tasks = [frame.task, ...this.tasks.filter((task) => task.id !== frame.task.id)];
      this.publish();
      this.refreshTasks();
      return;
    }

    if (frame.type === "task.list.create.ok") {
      this.taskLists = frame.lists;
      this.publish();
      return;
    }

    if (frame.type === "task.activity.ok") {
      this.taskActivity = { taskID: frame.taskID, entries: frame.activity };
      this.publish();
      return;
    }

    if (frame.type === "memory.list.ok") {
      this.memories = frame.memories;
      this.publish();
      return;
    }

    if (frame.type === "task.update.ok") {
      const index = this.tasks.findIndex((task) => task.id === frame.task.id);
      if (index === -1) this.tasks = [...this.tasks, frame.task];
      else this.tasks = this.tasks.map((task) => (task.id === frame.task.id ? frame.task : task));
      this.publish();
      this.refreshTasks();
      return;
    }

    if (frame.type === "provider.auth.started") {
      if (this.chatgptStartCancelled) {
        void this.connection?.send({ type: "provider.auth.cancel", providerID: "chatgpt", loginID: frame.loginID }).catch(() => {});
        return;
      }
      try {
        const url = new URL(frame.authorizeURL);
        if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize" || url.searchParams.has("id_token_hint")) throw new Error("Unexpected sign-in URL");
        this.chatgptLogin = { loginID: frame.loginID, authorizeURL: url.href, expiresAt: frame.expiresAt };
        if (this.chatgptPopup && !this.chatgptPopup.closed) this.chatgptPopup.location.replace(url.href);
      } catch {
        // A blocked popup still leaves a visible, validated sign-in link.
        if (!this.chatgptLogin) this.chatgptError = "The ChatGPT sign-in link could not be verified. Try again.";
      }
      this.chatgptBusy = false;
      this.publish(); return;
    }

    if (frame.type === "provider.auth.state") {
      const wasConnecting = !!this.chatgptLogin || this.chatgptBusy;
      this.chatgpt = frame.connection;
      if (frame.connection.status !== "pending") {
        this.chatgptBusy = false; this.chatgptLogin = null; this.chatgptPopup = null;
        if (wasConnecting && frame.connection.status === "connected" && !frame.connection.message) this.providerAddSuccess = "ChatGPT is connected. You're ready to chat.";
        void this.refreshHealth();
      }
      this.publish(); return;
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

    if (frame.type === "appearance.list.ok" || frame.type === "appearance.updated") {
      this.appearanceProfiles = frame.profiles;
      this.appearance = frame.profiles.find((profile) => profile.id === frame.activeID)
        ?? frame.profiles[0]
        ?? defaultAppearance();
      cacheAppearance(this.appearance);
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
      if (frame.code === "provider_auth") {
        this.chatgptError = frame.message; this.chatgptBusy = false;
        this.isAddingProvider = false; this.pendingProviderID = null;
        this.providerAddError = frame.message;
        this.chatgptPopup?.close(); this.chatgptPopup = null;
        this.publish(); return;
      }
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
    this.syncAgentRoute();
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
    this.refreshMemories();
    this.refreshPlugins();
    this.refreshChatGPT();
    this.refreshAppearance();
  }

  refreshAppearance(): void {
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "appearance.list" }).catch(() => undefined);
  }

  saveAppearance(profile: AppearanceProfile, activate = true): void {
    const next = AppearanceProfileSchema.parse({ ...profile, name: profile.name.trim(), updatedAt: new Date().toISOString() });
    this.appearance = next;
    this.appearanceProfiles = [next, ...this.appearanceProfiles.filter((item) => item.id !== next.id)];
    cacheAppearance(next);
    this.publish();
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "appearance.save", profile: next, activate }).catch(() => undefined);
  }

  activateAppearance(id: string): void {
    const profile = this.appearanceProfiles.find((item) => item.id === id);
    if (!profile) return;
    this.appearance = profile;
    cacheAppearance(profile);
    this.publish();
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "appearance.activate", id }).catch(() => undefined);
  }

  deleteAppearance(id: string): void {
    if (this.appearanceProfiles.length <= 1) return;
    this.appearanceProfiles = this.appearanceProfiles.filter((item) => item.id !== id);
    if (this.appearance.id === id) this.appearance = this.appearanceProfiles[0] ?? defaultAppearance();
    cacheAppearance(this.appearance);
    this.publish();
    if (!this.connection || !isReady(this.connectionState)) return;
    void this.connection.send({ type: "appearance.delete", id }).catch(() => undefined);
  }

  // MARK: notifications

  private notifyUser(title: string, body: string, sound = false, threadID?: string): void {
    this.showToast(notice("info", title, body, threadID ?? null));
    if (!this.preferences.notifications) return;
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

function agentPath(agent: AgentInfo | null): string {
  const slug = agent?.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agni";
  return `/agent/${encodeURIComponent(slug)}`;
}
