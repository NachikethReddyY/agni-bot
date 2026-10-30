import { homePath } from "./home";
import { loadProviders, type ProviderConfig } from "./models/providers";
import { DEFAULT_SLOT_BUDGETS, type SlotBudgets } from "./context/compiler";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  /** PID file written by `daemon start` (empty in tests). */
  pidPath: string;
  /** Log file the detached daemon appends to. */
  logPath: string;
  providers: ProviderConfig[];
  /** Abort a provider attempt that produces no first token within this window. */
  firstTokenTimeoutMs: number;
  /** Hard ceiling for a single turn, cancellation included. */
  turnTimeoutMs: number;
  /** Grace period before a client must complete the hello handshake. */
  helloTimeoutMs: number;
  /** How many outbound frames the server keeps for `resync` replay. */
  frameLogCapacity: number;
  /** How often the job runner looks for due work. */
  jobPollMs: number;
  /** Maximum simultaneous model streams across chat and background turns. */
  maxConcurrentTurns: number;
  /** IANA zone schedules ("09:05") are read in. AGNI_TZ, else the server's zone. */
  timeZone?: string;
  /** Where `db.backup` writes daily copies, and how many it keeps. */
  backupDir?: string;
  backupKeep?: number;
  /** The https origin a proxy serves the daemon on (AGNI_PUBLIC_ORIGIN), allowed like loopback. */
  publicOrigin?: string;
  /** Path to plugins.json (plugin auth + activation state). */
  pluginsPath: string;
  /** Optional first name for first-run onboarding; never inferred from secrets. */
  userFirstName?: string;
  /**
   * ASM-007: the context assembler's slot budgets, in tokens. Configuration,
   * not constants, so an eval can move a number without a code change.
   */
  slotBudgets?: Partial<SlotBudgets>;
  /**
   * ASM-004: the confidence floor for automatic retrieval. Below it, nothing
   * is injected — a plausible match that is not good enough is still nothing.
   */
  minRecallScore?: number;
}

function int(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function float(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The slot budgets, each overridable by environment (ASM-007). */
function slotBudgets(env: Record<string, string | undefined>): SlotBudgets {
  return {
    pinned_core: int(env, "AGNI_SLOT_PINNED_CORE", DEFAULT_SLOT_BUDGETS.pinned_core),
    anchor: int(env, "AGNI_SLOT_ANCHOR", DEFAULT_SLOT_BUDGETS.anchor),
    ledger: int(env, "AGNI_SLOT_LEDGER", DEFAULT_SLOT_BUDGETS.ledger),
    summaries: int(env, "AGNI_SLOT_SUMMARIES", DEFAULT_SLOT_BUDGETS.summaries),
    recall: int(env, "AGNI_SLOT_RECALL", DEFAULT_SLOT_BUDGETS.recall),
    previous_tail: int(env, "AGNI_SLOT_PREVIOUS_TAIL", DEFAULT_SLOT_BUDGETS.previous_tail),
  };
}

/** AGNI_TZ if it is a valid IANA name, else the server's local zone. */
export function resolveTimeZone(env: Record<string, string | undefined> = Bun.env): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const raw = env.AGNI_TZ?.trim();
  if (!raw) return local;
  try { new Intl.DateTimeFormat("en", { timeZone: raw }); return raw; } catch { return local; }
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  return {
    host: env.AGNI_HOST?.trim() || "127.0.0.1",
    port: int(env, "AGNI_PORT", 8787),
    dbPath: env.AGNI_DB_PATH?.trim() || homePath("data", "agni.sqlite"),
    pidPath: env.AGNI_PID_PATH?.trim() || homePath("run", "agni.pid"),
    logPath: env.AGNI_LOG_PATH?.trim() || homePath("logs", "agni.log"),
    providers: loadProviders(env),
    firstTokenTimeoutMs: int(env, "AGNI_FIRST_TOKEN_TIMEOUT_MS", 30000),
    turnTimeoutMs: int(env, "AGNI_TURN_TIMEOUT_MS", 120000),
    helloTimeoutMs: int(env, "AGNI_HELLO_TIMEOUT_MS", 5000),
    frameLogCapacity: int(env, "AGNI_FRAME_LOG_CAPACITY", 1000),
    jobPollMs: int(env, "AGNI_JOB_POLL_MS", 3000),
    maxConcurrentTurns: int(env, "AGNI_MAX_CONCURRENT_TURNS", 4),
    timeZone: resolveTimeZone(env),
    backupDir: env.AGNI_BACKUP_DIR?.trim() || undefined,
    backupKeep: int(env, "AGNI_BACKUP_KEEP", 7),
    publicOrigin: env.AGNI_PUBLIC_ORIGIN?.trim() || undefined,
    pluginsPath: env.AGNI_PLUGINS_PATH?.trim() || homePath("plugins.json"),
    userFirstName: env.AGNI_USER_FIRST_NAME?.trim() || undefined,
    slotBudgets: slotBudgets(env),
    minRecallScore: float(env, "AGNI_MIN_RECALL_SCORE", 0.15),
  };
}
