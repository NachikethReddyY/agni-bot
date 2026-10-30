/**
 * Agni wire protocol v2 — the contract between the server and every client
 * (Mac app, Android app, CLI).
 *
 * Frames are JSON text over a single WebSocket. Client frames carry no
 * sequence number; every server frame carries a positive, monotonically
 * increasing `seq` so clients can replay missed frames via `resync`.
 *
 * v2 introduces the conversation model: the user-facing chat surface is one
 * conversation per agent; "threads" become invisible session blocks inside it
 * (context-window seams). See docs/protocol.md and the §5 blueprint change.
 *
 * The prose spec lives in docs/protocol.md. This file is the machine version:
 * if the two disagree, this file wins — then fix the doc.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 2;

/** Server-assigned monotonic sequence number. */
const seq = z.number().int().positive();

export const STOP_REASONS = ["end", "cancelled", "error", "timeout", "budget", "needs_input"] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

/** Approval button / answer tokens. */
export const DECISIONS = ["once", "always", "reject"] as const;
export const DecisionSchema = z.enum(DECISIONS);
export type Decision = z.infer<typeof DecisionSchema>;

export const UsageSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AgentInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.string().optional(),
  model: z.string().optional(),
  /** What this agent is for, in the owner's words ("inbox manager"). */
  role: z.string().optional(),
  tools: z.array(z.string()).optional(),
  /** Set once the agent has been named; the "what should I call you?" prompt is settled. */
  onboarded: z.boolean().optional(),
  /** Hidden from the sidebar, but still addressable as `@id` / `@name`. */
  hidden: z.boolean().optional(),
  /**
   * What the executive assistant may see of this agent's work:
   * `private` (a receipt only), `summary` (one line) or `shared` (full text).
   */
  visibility: z.enum(["private", "summary", "shared"]).optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/** One thread, as listed by `thread.list`. */
export const ThreadInfoSchema = z.object({
  id: z.string().min(1),
  agentID: z.string().min(1),
  title: z.string().optional(),
  updatedAt: z.string(),
  /** Last message, one line, for the thread list. */
  preview: z.string().optional(),
});
export type ThreadInfo = z.infer<typeof ThreadInfoSchema>;

/** One durable message, as returned by `thread.history`. */
/** Durable attachment metadata; file bytes travel over authenticated HTTP. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const AttachmentInfoSchema = z.object({
  id: z.string().regex(/^att_[a-zA-Z0-9_-]+$/),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "text", "pdf"]),
});
export type AttachmentInfo = z.infer<typeof AttachmentInfoSchema>;

// --- appearance -------------------------------------------------------------

/** A synced, named appearance profile. Clients resolve presets into native
 * colours, while the semantic choices remain portable across platforms. */
export const AppearanceProfileSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^theme_[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(64),
  mode: z.enum(["system", "dark", "light"]),
  preset: z.enum(["agni", "midnight", "graphite", "paper", "ocean", "forest", "warm"]),
  accent: z.enum(["ember", "amber", "ocean", "forest", "violet", "rose", "mono", "custom"]),
  customAccent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  background: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({ kind: z.literal("solid"), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
    z.object({
      kind: z.literal("gradient"),
      from: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      to: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      angle: z.number().int().min(0).max(360),
    }),
    z.object({
      kind: z.literal("image"),
      assetID: z.string().regex(/^bg_[a-zA-Z0-9_-]+$/),
      fit: z.enum(["cover", "contain"]),
      positionX: z.number().min(0).max(100),
      positionY: z.number().min(0).max(100),
      dim: z.number().min(0).max(0.95),
      blur: z.number().min(0).max(24),
    }),
  ]),
  textScale: z.enum(["small", "default", "large"]),
  density: z.enum(["compact", "comfortable"]),
  corners: z.enum(["square", "standard", "soft"]),
  motion: z.enum(["system", "full", "reduced"]),
  agentTint: z.enum(["full", "subtle", "off"]),
  updatedAt: z.string().datetime(),
});
export type AppearanceProfile = z.infer<typeof AppearanceProfileSchema>;

export const MessageInfoSchema = z.object({
  attachments: z.array(AttachmentInfoSchema).max(MAX_ATTACHMENTS).optional(),
  id: z.string().min(1),
  role: z.string().min(1),
  text: z.string(),
  createdAt: z.string(),
  turnID: z.string().optional(),
  /** Session block the message belongs to (conversation model, v2). */
  sessionID: z.string().optional(),
  senderName: z.string().optional(),
  senderColor: z.string().optional(),
  /** The agent this message is about — a handoff notice names its target. */
  toAgentId: z.string().optional(),
  uiHint: z.string().optional(),
});
export type MessageInfo = z.infer<typeof MessageInfoSchema>;

/** Why a session block boundary exists. */
export const SESSION_REASONS = ["manual", "context", "background"] as const;
export const SessionReasonSchema = z.enum(SESSION_REASONS);
export type SessionReason = z.infer<typeof SessionReasonSchema>;

/** Job lifecycle states; `done` and `failed` are terminal unless recurring. */
export const JOB_STATES = ["queued", "running", "done", "failed"] as const;
export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;

/** Actions `job.set` accepts on one job. */
export const JOB_ACTIONS = ["pause", "resume", "run"] as const;
export const JobActionSchema = z.enum(JOB_ACTIONS);
export type JobAction = z.infer<typeof JobActionSchema>;

/** What happened on one routine run (docs/routines-plan.md §2). */
export const RUN_OUTCOMES = ["ran", "skipped_no_delta", "failed", "timed_out", "budget_exceeded"] as const;
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/** One remembered routine run, as the Routines panel lists it. */
export const RoutineRunInfoSchema = z.object({
  at: z.string(),
  outcome: RunOutcomeSchema,
  tokens: z.number().int().nonnegative(),
  summary: z.string().optional(),
});
export type RoutineRunInfo = z.infer<typeof RoutineRunInfoSchema>;

/**
 * Routines metadata, on `routine`-kind jobs only. Optional like the
 * `lists` field on `task.list.ok` (additive v2): non-routine jobs omit it
 * and clients that do not know it ignore it.
 */
export const RoutineInfoSchema = z.object({
  name: z.string(),
  cron: z.string(),
  timezone: z.string(),
  misfire: z.enum(["skip", "run_once"]),
  preflight: z.enum(["http", "sql", "none"]),
  maxTokens: z.number().int().positive(),
  maxExecutionMs: z.number().int().positive(),
  allowedDomains: z.array(z.string()),
  successStreak: z.number().int().nonnegative(),
  failureStreak: z.number().int().nonnegative(),
  /** At most the last five runs, newest first. */
  recentRuns: z.array(RoutineRunInfoSchema).max(5),
});
export type RoutineInfo = z.infer<typeof RoutineInfoSchema>;

/** One job, as listed by `job.list` (the Routines panel reads these). */
export const JobInfoSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  state: JobStateSchema,
  runAt: z.string(),
  enabled: z.boolean(),
  attempts: z.number().int().nonnegative(),
  /** Recurrence in milliseconds; absent for one-shot work. */
  everyMs: z.number().int().positive().optional(),
  /** The prompt this job runs, trimmed for display. */
  title: z.string().optional(),
  threadID: z.string().optional(),
  lastResult: z.string().optional(),
  /** Routine details; set only on `routine`-kind jobs (additive v2). */
  routine: RoutineInfoSchema.optional(),
});
export type JobInfo = z.infer<typeof JobInfoSchema>;

export const TaskStatusSchema = z.enum(["open", "done", "snoozed"]);
export const TaskWorkflowStatusSchema = z.enum(["not_started", "in_progress", "ai_review"]);
export const DelegateStateSchema = z.enum(["none", "queued", "running", "needs_input", "done", "failed"]);
/**
 * What an agent-to-agent message is for: a request for work, a result coming
 * back, a question, a status note, or an FYI. Phase 1 carries the value on the
 * frame; routing on it comes later.
 */
export const PEER_INTENTS = ["request", "result", "question", "status", "fyi"] as const;
export const PeerIntentSchema = z.enum(PEER_INTENTS);
export type PeerIntent = z.infer<typeof PeerIntentSchema>;
/** One remembered thing, as the memory view shows it. */
export const MemoryItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: z.string(),
  visibility: z.string(),
  source: z.string(),
  confidence: z.number(),
  salience: z.number(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  useCount: z.number(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const TaskInfoSchema = z.object({
  id: z.string().min(1), title: z.string(), dueAt: z.string().nullable(),
  priority: z.enum(["low", "normal", "high", "urgent"]), status: TaskStatusSchema,
  workflowStatus: TaskWorkflowStatusSchema.optional(),
  progressNote: z.string().max(1000).optional(),
  snoozedUntil: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
  // Delegation fields (DEL-001/DEL-005). Optional so older clients still parse.
  ownerAgentId: z.string().nullable().optional(),
  origin: z.enum(["user_direct", "ea_delegated"]).optional(),
  /** What the delegation asks of the owner; absent on older tasks ("request"). */
  intent: PeerIntentSchema.optional(),
  delegateState: DelegateStateSchema.optional(),
  jobId: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
  /**
   * True when the result exists but the viewer may not see it (the owning
   * agent is private to the caller). The owner always sees the full result.
   */
  resultRedacted: z.boolean().optional(),
  listID: z.string().optional(),
  parentTaskID: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  reminderAt: z.string().nullable().optional(),
  deadlineAt: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  repeatRule: z.enum(["none", "daily", "weekly", "monthly"]).optional(),
  attachmentIDs: z.array(z.string()).optional(),
  attachments: z.array(AttachmentInfoSchema).optional(),
});
export type TaskInfo = z.infer<typeof TaskInfoSchema>;

export const TaskListInfoSchema = z.object({
  id: z.string(), name: z.string(), position: z.number().int(), taskCount: z.number().int().nonnegative(),
});
export type TaskListInfo = z.infer<typeof TaskListInfoSchema>;
export const TaskActivityInfoSchema = z.object({
  id: z.string(), actor: z.string(), action: z.string(), detail: z.string().nullable(), createdAt: z.string(),
});
export type TaskActivityInfo = z.infer<typeof TaskActivityInfoSchema>;

// --- plugins -----------------------------------------------------------------

/** Whose account a plugin connection binds to. */
export const PLUGIN_ACCOUNTS = ["agent", "owner"] as const;
export const PluginAccountSchema = z.enum(PLUGIN_ACCOUNTS);
export type PluginAccount = z.infer<typeof PluginAccountSchema>;

/** Connection lifecycle, as the settings pane renders it. */
export const PLUGIN_STATUSES = ["disconnected", "pending", "connected", "error"] as const;
export const PluginStatusSchema = z.enum(PLUGIN_STATUSES);
export type PluginStatus = z.infer<typeof PluginStatusSchema>;

/**
 * One capability class of one plugin connection, with the owner's policy:
 * `free` runs without asking, `approval` asks before acting, `off` refuses.
 * Scopes are what Google granted; capabilities are what WE allow — the two
 * are separate on purpose (see docs/protocol.md §plugins).
 */
export const PluginCapabilitySchema = z.object({
  capability: z.enum(["read", "draft", "send", "create", "share", "modify"]),
  mode: z.enum(["free", "approval", "off"]),
});
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

/** One settings-pane row: a catalog plugin bound to one account. */
export const PluginInfoSchema = z.object({
  /** Catalog id, e.g. "gmail"; unique together with `account`. */
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.enum(["google", "mcp"]),
  description: z.string(),
  authKind: z.enum(["oauth", "mcp", "app-password", "api-key"]),
  account: PluginAccountSchema,
  /** What the catalog will ask Google for, at connect time. */
  scopes: z.array(z.string()),
  /** The full default policy grid; always present, even while disconnected. */
  capabilities: z.array(PluginCapabilitySchema),
  /** True when the server can complete this kind of connect flow today. */
  available: z.boolean(),
  connectionID: z.string().optional(),
  status: PluginStatusSchema.optional(),
  /** The signed-in email for the connection, once known. */
  accountLabel: z.string().optional(),
  error: z.string().optional(),
  connectedAt: z.string().optional(),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

// ---------------------------------------------------------------------------
// client → server
// ---------------------------------------------------------------------------

/** Public account metadata only. OAuth credentials never cross the socket. */
export const ChatGPTConnectionSchema = z.object({
  status: z.enum(["disconnected", "pending", "connected", "reauth_required", "error"]),
  accounts: z.array(z.object({ id: z.string(), label: z.string(), connected: z.boolean() })),
  activeAccountID: z.string().nullable(),
  model: z.string(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  message: z.string().optional(),
  showWelcome: z.boolean().optional(),
});
export type ChatGPTConnection = z.infer<typeof ChatGPTConnectionSchema>;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("provider.auth.status"), providerID: z.literal("chatgpt") }),
  z.object({ type: z.literal("provider.auth.start"), providerID: z.literal("chatgpt"), accountID: z.string().max(64).optional() }),
  z.object({ type: z.literal("provider.auth.cancel"), providerID: z.literal("chatgpt"), loginID: z.string().max(64) }),
  z.object({ type: z.literal("provider.auth.disconnect"), providerID: z.literal("chatgpt"), accountID: z.string().max(64) }),
  z.object({ type: z.literal("provider.auth.select"), providerID: z.literal("chatgpt"), accountID: z.string().max(64) }),
  z.object({ type: z.literal("provider.auth.acknowledge"), providerID: z.literal("chatgpt"), accountID: z.string().max(64) }),
  z.object({
    type: z.literal("hello"),
    v: z.number().int(),
    // Optional: a browser paired by cookie authenticates at the socket upgrade.
    token: z.string().min(1).optional(),
    device: z.string().min(1),
  }),
  z.object({ type: z.literal("resync"), lastSeq: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("msg.send"),
    /**
     * Legacy path: target session block id; "" asks the server to rotate a
     * fresh block. Conversation clients omit it and use conversationID.
     */
    threadID: z.string().optional(),
    text: z.string().min(1),
    /** Uploaded attachment IDs. Older clients may omit this field. */
    files: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
    /**
     * v2 conversation model: send into the conversation's active session
     * block. Takes precedence over threadID.
     */
    conversationID: z.string().min(1).optional(),
    /** Channel this message targets; absent for thread/conversation sends. */
    channelId: z.string().optional(),
    /** Agent to address this message to. */
    toAgentId: z.string().optional(),
    /** Multiple message bodies for batched content; `text` is the primary body. */
    texts: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("msg.cancel"), turnID: z.string().min(1) }),
  z.object({
    type: z.literal("approve.reply"),
    requestID: z.string().min(1),
    decision: DecisionSchema,
  }),
  /**
   * The owner typed a secret for a `secret.request`. The value is never
   * persisted, replayed, or sent to the model; the server uses it once for
   * the command named in the request.
   */
  z.object({
    type: z.literal("secret.reply"),
    requestID: z.string().min(1),
    value: z.string().min(1),
  }),
  z.object({ type: z.literal("secret.cancel"), requestID: z.string().min(1) }),
  z.object({ type: z.literal("agent.select"), agentID: z.string().min(1) }),
  /**
   * Resolve (and create when missing) the agent's one conversation — the
   * enduring chat surface with that agent. An empty conversationID plus
   * agentID means "that agent's conversation"; the answer carries the active
   * session block id.
   */
  z.object({
    type: z.literal("conversation.open"),
    /** Empty selects by agentID; non-empty must resolve. */
    conversationID: z.string().max(64),
    agentID: z.string().min(1).optional(),
  }),
  /** Close the active session block and continue in a fresh one (/new). */
  z.object({ type: z.literal("session.new"), conversationID: z.string().min(1) }),
  /** The conversation transcript across session blocks, with sessionID per message. */
  z.object({
    type: z.literal("conversation.history"),
    conversationID: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  z.object({ type: z.literal("thread.open"), threadID: z.string().min(1) }),
  /**
   * Render this conversation — messages, tool calls, model reasoning, and
   * approval decisions — into one self-contained HTML file and return a link
   * to it. The daemon does the rendering so the artifact is identical no
   * matter which client asked for it.
   */
  z.object({
    type: z.literal("thread.export"),
    conversationID: z.string().min(1),
    /** Optional label for the document's title. */
    title: z.string().max(200).optional(),
  }),
  /**
   * Durable-state reads. Replies are addressed to the requesting connection
   * and stay out of the replay log (they are answers, not stream state).
   */
  z.object({ type: z.literal("thread.list"), limit: z.number().int().positive().max(200).optional() }),
  z.object({
    type: z.literal("thread.history"),
    threadID: z.string().min(1),
    limit: z.number().int().positive().max(500).optional(),
  }),
  /** Read the routine list, or act on one routine (pause, resume, run now). */
  z.object({ type: z.literal("job.list"), limit: z.number().int().positive().max(200).optional() }),
  z.object({ type: z.literal("job.set"), jobID: z.string().min(1), action: JobActionSchema }),
  /** Owner-only: replace a routine's web domain allowlist (additive v2). Bots cannot send this. */
  z.object({ type: z.literal("routine.domains.set"), jobID: z.string().min(1), domains: z.array(z.string().max(253)).max(20) }),
  /** Delete a task unless it is currently running. */
  z.object({ type: z.literal("job.delete"), jobID: z.string().min(1) }),
  z.object({ type: z.literal("task.list"), status: z.enum(["open", "done", "snoozed", "all"]).optional(), limit: z.number().int().positive().max(200).optional() }),
  z.object({ type: z.literal("task.create"), title: z.string().min(1).max(500), description: z.string().max(10000).optional(), dueAt: z.string().datetime().optional(), reminderAt: z.string().datetime().optional(), deadlineAt: z.string().datetime().optional(), labels: z.array(z.string().max(64)).max(20).optional(), repeatRule: z.enum(["none", "daily", "weekly", "monthly"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), listID: z.string().optional(), parentTaskID: z.string().optional(), attachmentIDs: z.array(z.string()).max(5).optional() }),
  z.object({ type: z.literal("task.list.create"), name: z.string().trim().min(1).max(80) }),
  z.object({ type: z.literal("task.activity"), taskID: z.string().min(1) }),
  /**
   * What the agent can remember. The list is filtered by the same
   * caller-filter the retrieval uses, so the view shows exactly what
   * retrieval could use — and nothing more.
   */
  z.object({ type: z.literal("memory.list"), scope: z.enum(["global_user", "agent"]).optional(), limit: z.number().int().positive().max(200).optional() }),
  z.object({ type: z.literal("task.update"), taskID: z.string().min(1), action: z.enum(["done", "reopen", "snooze", "cancel", "edit"]), until: z.string().datetime().optional(), title: z.string().min(1).max(500).optional(), description: z.string().max(10000).nullable().optional(), dueAt: z.string().datetime().nullable().optional(), reminderAt: z.string().datetime().nullable().optional(), deadlineAt: z.string().datetime().nullable().optional(), labels: z.array(z.string().max(64)).max(20).optional(), workflowStatus: TaskWorkflowStatusSchema.optional(), progressNote: z.string().max(1000).nullable().optional(), repeatRule: z.enum(["none", "daily", "weekly", "monthly"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), listID: z.string().optional() }),
  /**
   * Answer a question a delegated task asked. Its own frame, not a `msg.send`:
   * a task only accepts an answer while it is in `needs_input`, the answer
   * belongs to one question, and it is accepted exactly once.
   */
  z.object({
    type: z.literal("task.answer"),
    taskID: z.string().min(1),
    questionID: z.string().min(1),
    text: z.string().min(1).max(8_000),
  }),
  /**
   * Pin this client to an agent: the server resolves that agent's
   * conversation, session block and DM channel, and answers with them. A
   * client that is bound sends its next message there.
   */
  z.object({ type: z.literal("bind.direct"), agentID: z.string().min(1) }),
  /** Configure a built-in API provider. The key is accepted only by the daemon. */
  z.object({
    type: z.literal("provider.add"),
    providerID: z.enum(["groq", "cerebras", "nim", "gemini", "openrouter", "custom"]),
    apiKey: z.string().min(1).max(4096),
    model: z.string().trim().min(1).max(200).optional(),
    /** OpenAI-compatible base URL; required when providerID is "custom". */
    baseUrl: z.string().trim().min(1).max(500).optional(),
    /** Name to show for a custom endpoint; the host is used when absent. */
    label: z.string().trim().min(1).max(64).optional(),
  }),
  z.object({
    type: z.literal("provider.model.set"),
    providerID: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("provider.models.list"),
    providerID: z.string().trim().min(1).max(64),
  }),
  /** Read the catalog bound to accounts; the settings Plugins pane renders it. */
  z.object({ type: z.literal("plugin.list") }),
  z.object({ type: z.literal("appearance.list") }),
  z.object({ type: z.literal("appearance.save"), profile: AppearanceProfileSchema, activate: z.boolean().optional() }),
  z.object({ type: z.literal("appearance.activate"), id: z.string().regex(/^theme_[a-zA-Z0-9_-]+$/) }),
  z.object({ type: z.literal("appearance.delete"), id: z.string().regex(/^theme_[a-zA-Z0-9_-]+$/) }),
  /**
   * Begin connecting a plugin to an account. OAuth kinds answer with
   * `plugin.connect.ok` carrying an authorize URL to open in the browser;
   * the flow completes server-side, then every client gets `plugin.state`.
   */
  z.object({
    type: z.literal("plugin.connect"),
    pluginID: z.string().min(1),
    account: PluginAccountSchema,
  }),
  /** Disconnect one connection (revokes tokens server-side, then Google). */
  z.object({ type: z.literal("plugin.disconnect"), connectionID: z.string().min(1) }),
  /**
   * Give a plugin its credentials and connect it. The secrets arrive over the
   * authenticated socket and are written to plugins.json on the daemon host —
   * never kept by the app, never echoed back.
   */
  z.object({
    type: z.literal("plugin.configure"),
    pluginID: z.string().min(1),
    account: PluginAccountSchema,
    /** app-password: the account and its app password. */
    user: z.string().trim().min(1).max(320).optional(),
    pass: z.string().min(1).max(512).optional(),
    /** api-key: the cloud key, or a self-hosted URL. */
    key: z.string().min(1).max(512).optional(),
    url: z.string().trim().max(500).optional(),
    /** oauth: the Google client credentials the daemon signs with. */
    clientID: z.string().trim().min(1).max(200).optional(),
    clientSecret: z.string().min(1).max(200).optional(),
  }),
  /** Typing indicator from this client, aimed at a channel (or conversation when channelId is absent). */
  z.object({
    type: z.literal("user.typing"),
    channelId: z.string().optional(),
    isTyping: z.boolean(),
  }),
  /** Rename an agent/persona; answered with a fresh `agents.update`. */
  z.object({
    type: z.literal("agent.rename"),
    agentId: z.string().min(1),
    name: z.string().min(1).max(64),
  }),
  /**
   * Edit an agent's profile: what it is for (the tag shown under its name) and
   * how much of its work other agents may see. The same change the
   * `update_agent` chat tool makes, so a rename from the app and a rename from
   * chat cannot drift apart.
   */
  z.object({
    type: z.literal("agent.profile"),
    agentId: z.string().min(1),
    role: z.string().max(160).optional(),
    visibility: z.enum(["private", "summary", "shared"]).optional(),
  }),
  /**
   * Create an agent from the app — the "+" in the roster. The same creation
   * the `create_agent` chat tool performs, so a bot made here and a bot made
   * in chat are the same kind of thing. The roster frame comes back with the
   * new agent in it.
   */
  z.object({
    type: z.literal("agent.create"),
    name: z.string().min(1).max(64),
    prompt: z.string().min(1).max(8_000),
    role: z.string().max(160).optional(),
    id: z.string().max(64).optional(),
    color: z.string().max(16).optional(),
  }),
  /**
   * The owner answered a question the agent asked. The answer is the option
   * they chose, or their own words if they typed instead of choosing.
   */
  z.object({
    type: z.literal("form.answer"),
    requestID: z.string().min(1),
    answer: z.string().min(1).max(4_000),
  }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ClientFrameType = ClientFrame["type"];

// ---------------------------------------------------------------------------
// server → client
// ---------------------------------------------------------------------------

export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello.ok"),
    seq,
    /** Server protocol version; always PROTOCOL_VERSION. */
    v: z.number().int(),
    serverTime: z.string(),
    /** Highest seq the server has assigned so far. */
    lastSeq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("token"), seq, turnID: z.string(), threadID: z.string(), delta: z.string() }),
  z.object({
    type: z.literal("turn.start"),
    seq,
    turnID: z.string(),
    threadID: z.string(),
    agentID: z.string(),
    /** v2: the conversation this turn belongs to (present in both lanes). */
    conversationID: z.string().optional(),
  }),
  z.object({
    type: z.literal("turn.end"),
    seq,
    turnID: z.string(),
    threadID: z.string(),
    stopReason: StopReasonSchema,
    usage: UsageSchema.optional(),
    conversationID: z.string().optional(),
  }),
  z.object({ type: z.literal("tool.start"), seq, callID: z.string(), name: z.string(), preview: z.string().optional() }),
  z.object({ type: z.literal("tool.update"), seq, callID: z.string(), preview: z.string().optional() }),
  z.object({ type: z.literal("tool.end"), seq, callID: z.string(), ok: z.boolean(), preview: z.string().optional() }),
  z.object({
    type: z.literal("approval.request"),
    seq,
    requestID: z.string(),
    action: z.string(),
    preview: z.string(),
    buttons: z.array(DecisionSchema).min(1),
  }),
  /**
   * A command needs the owner's password. The request carries no secret —
   * only what the owner is authorizing. The answer travels on `secret.reply`
   * and is consumed once, server-side.
   */
  z.object({
    type: z.literal("secret.request"),
    seq,
    requestID: z.string(),
    purpose: z.string(),
    command: z.string(),
    kind: z.enum(["password", "text"]),
    expiresAt: z.string(),
    threadID: z.string().optional(),
    conversationID: z.string().optional(),
  }),
  z.object({
    type: z.literal("secret.cancel"),
    seq,
    requestID: z.string(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("form.request"),
    seq,
    requestID: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    /** More than one option may be chosen; the answer is then a list. */
    multiple: z.boolean().optional(),
    /** Which card the client draws: a list of choices, or an email draft. */
    kind: z.enum(["choice", "email"]).optional(),
    /** The draft, when `kind` is "email". */
    email: z
      .object({
        from: z.string().optional(),
        to: z.string(),
        subject: z.string(),
        body: z.string(),
      })
      .optional(),
  }),
  z.object({ type: z.literal("notify"), seq, title: z.string(), body: z.string(), sound: z.boolean().optional(), threadID: z.string().optional() }),
  z.object({
    type: z.literal("agents.update"),
    seq,
    agents: z.array(AgentInfoSchema),
    /** The full roster, including hidden specialists, for `@mention` resolution. */
    mentions: z.array(AgentInfoSchema).optional(),
  }),
  z.object({ type: z.literal("thread.list.ok"), seq, threads: z.array(ThreadInfoSchema) }),
  z.object({
    type: z.literal("thread.history.ok"),
    seq,
    threadID: z.string().min(1),
    title: z.string().optional(),
    messages: z.array(MessageInfoSchema),
  }),
  /**
   * Answer to `conversation.open`; addressed to the requester, outside the
   * replay log. sessionID is "" while the conversation has no blocks yet.
   */
  z.object({
    type: z.literal("conversation.ok"),
    seq,
    conversationID: z.string(),
    agentID: z.string(),
    sessionID: z.string(),
  }),
  /** A session block boundary inside the conversation (replayable stream state). */
  z.object({
    type: z.literal("session.start"),
    seq,
    conversationID: z.string(),
    sessionID: z.string(),
    reason: SessionReasonSchema,
  }),
  /** Answer to `conversation.history`; addressed to the requester. */
  z.object({
    type: z.literal("conversation.history.ok"),
    seq,
    conversationID: z.string(),
    messages: z.array(MessageInfoSchema),
  }),
  /** Answer to `thread.export`; addressed to the requester, not replayed. */
  z.object({
    type: z.literal("thread.export.ok"),
    seq,
    conversationID: z.string(),
    /** Absolute URL of the rendered document, served by this daemon. */
    url: z.string(),
    token: z.string(),
    records: z.number().int().nonnegative(),
    createdAt: z.string(),
  }),
  z.object({ type: z.literal("job.list.ok"), seq, jobs: z.array(JobInfoSchema) }),
  z.object({ type: z.literal("task.list.ok"), seq, tasks: z.array(TaskInfoSchema), lists: z.array(TaskListInfoSchema).optional() }),
  z.object({ type: z.literal("task.create.ok"), seq, task: TaskInfoSchema }),
  z.object({ type: z.literal("task.list.create.ok"), seq, lists: z.array(TaskListInfoSchema) }),
  z.object({ type: z.literal("task.activity.ok"), seq, taskID: z.string(), activity: z.array(TaskActivityInfoSchema) }),
  z.object({ type: z.literal("memory.list.ok"), seq, memories: z.array(MemoryItemSchema) }),
  z.object({ type: z.literal("task.update.ok"), seq, task: TaskInfoSchema }),
  /** A delegated task changed state; clients refresh their task list. */
  z.object({ type: z.literal("task.updated"), seq, task: TaskInfoSchema }),
  /** The answer was accepted; the task is running again. */
  z.object({ type: z.literal("task.answer.ok"), seq, task: TaskInfoSchema }),
  /** The client is now bound to this agent's conversation. */
  z.object({
    type: z.literal("bind.direct.ok"),
    seq,
    agentID: z.string(),
    conversationID: z.string(),
    sessionID: z.string(),
    channelID: z.string(),
  }),
  z.object({ type: z.literal("provider.add.ok"), seq, providers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    model: z.string(),
    available: z.boolean(),
    cooldownRemainingMs: z.number(),
    lastError: z.string().optional(),
    lastSuccessAt: z.number().optional(),
  })) }),
  z.object({ type: z.literal("provider.models.ok"), seq, providerID: z.string(), models: z.array(z.string()) }),
  /** Login URLs are requester-only and never replayed; they contain no tokens. */
  z.object({ type: z.literal("provider.auth.started"), seq, providerID: z.literal("chatgpt"), loginID: z.string(), authorizeURL: z.string().url(), expiresAt: z.string() }),
  z.object({ type: z.literal("provider.auth.state"), seq, providerID: z.literal("chatgpt"), connection: ChatGPTConnectionSchema }),
  /** Answer to `plugin.list`; addressed to the requester, not replayed. */
  z.object({ type: z.literal("plugin.list.ok"), seq, plugins: z.array(PluginInfoSchema) }),
  z.object({ type: z.literal("appearance.list.ok"), seq, profiles: z.array(AppearanceProfileSchema), activeID: z.string().nullable() }),
  z.object({ type: z.literal("appearance.updated"), seq, profiles: z.array(AppearanceProfileSchema), activeID: z.string().nullable() }),
  z.object({
    type: z.literal("plugin.connect.ok"),
    seq,
    pluginID: z.string(),
    account: PluginAccountSchema,
    /** Open this in the system browser; null when the flow awaits nothing. */
    authorizeURL: z.string().nullable(),
  }),
  /** Replayable stream state: a plugin connection changed (connect, error, disconnect). */
  z.object({ type: z.literal("plugin.state"), seq, plugins: z.array(PluginInfoSchema) }),
  z.object({ type: z.literal("presence"), seq, state: z.enum(["online", "offline"]) }),
  /**
   * What an agent is doing: idle, working, waiting for the owner, or
   * blocked. The client shows it on the agent, so the owner can tell
   * "working" from "waiting for you" without asking.
   */
  z.object({
    type: z.literal("agent.presence"),
    seq,
    agentId: z.string(),
    state: z.enum(["idle", "working", "waiting", "blocked"]),
    /** The delegated task, when the state is about one. */
    taskId: z.string().optional(),
  }),
  /** A channel's status changed (e.g. typing/activity broadcast). */
  z.object({
    type: z.literal("status.update"),
    seq,
    channelId: z.string(),
    agentId: z.string().optional(),
    text: z.string(),
    transient: z.boolean(),
  }),
  /** A new message arrived; clients render it as a message row. */
  z.object({
    type: z.literal("msg.new"),
    attachments: z.array(AttachmentInfoSchema).max(MAX_ATTACHMENTS).optional(),
    seq,
    id: z.string(),
    channelId: z.string(),
    fromType: z.enum(["user", "agent", "system"]),
    fromId: z.string(),
    senderName: z.string(),
    senderColor: z.string().optional(),
    text: z.string(),
    internal: z.boolean(),
    uiHint: z.enum(["onboarding_name_prompt", "handoff_notice", "progress", "needs_input", "normal"]).optional(),
    /** What the agent-to-agent message is for; absent means "request". */
    intent: PeerIntentSchema.optional(),
    /** The agent this message is about — a handoff notice names its target. */
    toAgentId: z.string().optional(),
    /** Set when the message is a question from a delegated task. */
    taskId: z.string().optional(),
    /** The question this message asks; the answer carries it back. */
    questionId: z.string().optional(),
    createdAt: z.string(),
  }),
  /** An agent was renamed/updated; clients refresh the roster. */
  z.object({
    type: z.literal("agent.updated"),
    seq,
    agentId: z.string(),
    displayName: z.string(),
    onboarded: z.boolean(),
    /** What the agent is for, when the change touched it. */
    role: z.string().optional(),
    /** What other agents may see of its work, when the change touched it. */
    visibility: z.enum(["private", "summary", "shared"]).optional(),
  }),
  z.object({ type: z.literal("error"), seq, code: z.string(), message: z.string(), retryAfter: z.number().optional() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type ServerFrameType = ServerFrame["type"];

/** A server frame before the frame log assigns its seq. */
export type ServerFrameBody = ServerFrame extends infer T
  ? T extends { seq: number }
    ? Omit<T, "seq">
    : never
  : never;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; error: string };

type ZodLikeIssue = { path: readonly PropertyKey[]; message: string };

function issuesToText(error: { issues: readonly ZodLikeIssue[] }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length ? issue.path.map((segment) => String(segment)).join(".") : "frame";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseClientFrame(input: unknown): ParseResult<ClientFrame> {
  const result = ClientFrameSchema.safeParse(input);
  return result.success ? { ok: true, frame: result.data } : { ok: false, error: issuesToText(result.error) };
}

export function parseServerFrame(input: unknown): ParseResult<ServerFrame> {
  const result = ServerFrameSchema.safeParse(input);
  return result.success ? { ok: true, frame: result.data } : { ok: false, error: issuesToText(result.error) };
}

/** Parse a raw WebSocket text message into an unknown value. */
export function decodeText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
}

export function encodeFrame(frame: ClientFrame | ServerFrame | ServerFrameBody): string {
  return JSON.stringify(frame);
}

export function isSupportedVersion(v: number): boolean {
  return v === PROTOCOL_VERSION;
}
