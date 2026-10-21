#!/usr/bin/env bun
/**
 * Agni server entry point.
 *
 *   bun run serve            start the server in the foreground (Bun loads .env)
 *   bun run daemon start     run it detached in the background, health-gated
 *   bun run daemon status    pid + health snapshot
 *   bun run daemon stop      SIGTERM (SIGKILL only if it refuses)
 *   bun run daemon logs      tail the daemon log (--follow to stream)
 *   bun run migrate          apply pending migrations
 *   bun run pair --name X    mint a device token (shown once)
 *   bun run devices          list paired devices
 *   bun run revoke <id>      revoke a device
 *   bun run job add "text"   schedule a background turn (--in 10m, --every 1h, --at ISO)
 *   bun run job list         queued and running jobs (--all includes finished)
 *   bun run job rm|run <id>  cancel a job / make it due now
 */
import { hostname } from "node:os";
import { PROTOCOL_VERSION } from "@agni/protocol";
import { listDevices, mintToken, revokeDevice } from "./auth/tokens";
import { loadConfig, type Config } from "./config";
import { pluginMailResolver } from "./plugins/credentials";
import {
  daemonStatus,
  followLog,
  healthURL,
  startDaemon,
  stopDaemon,
  tailLog,
} from "./daemon";
import { openDatabase } from "./db";
import { seedAgentPromptTemplates, setOwnerName, loadRuntimeAgents } from "./agent/personas";
import { setSlotBudgets } from "./context/compiler";
import { JobRunner } from "./jobs/runner";
import { registerTurnJob, type TurnJobPayload } from "./jobs/turn";
import { registerBriefJob } from "./jobs/brief";
import { registerTaggerJob, scheduleTagger } from "./jobs/tagger";
import { registerMemoryJobs } from "./jobs/memory";
import { log } from "./log";
import { HealthTracker } from "./models/health";
import { Router } from "./models/router";
import { deleteJob, enqueueJob, getJobByPrefix, listJobs, requeueStuckJobs, setJobEnabled, wakeJob } from "./stores/jobs";
import { formatDuration, parseDurationMs, parseWhen } from "./util/time";
import { startServer, type HealthReport, type RunningServer } from "./ws/server";

const [command = "serve", ...args] = Bun.argv.slice(2);

if (command === "serve") await serve();
else if (command === "daemon") await daemonCommand(args);
else if (command === "job") await jobCommand(args);
else if (command === "pair") await pair(args);
else if (command === "migrate") migrate();
else if (command === "devices") devices();
else if (command === "revoke") revoke(args);
else usage();

// --- server ------------------------------------------------------------------

async function serve(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  setOwnerName(config.userFirstName);
  // ASM-007: the slot budgets are configuration, applied once at boot.
  setSlotBudgets(config.slotBudgets ?? {});
  const seeded = seedAgentPromptTemplates(db);
  if (seeded > 0) log.info(`agents: seeded ${seeded} prompt template(s)`);
  // Agents the assistant created at runtime live in the database; the roster
  // is rebuilt from those rows so they survive a restart.
  const restored = loadRuntimeAgents(db);
  if (restored > 0) log.info(`agents: restored ${restored} agent(s) created at runtime`);
  const router = new Router(config.providers, new HealthTracker(), fetch, config.maxConcurrentTurns);

  const requeued = requeueStuckJobs(db);
  if (requeued > 0) log.warn(`job queue: requeued ${requeued} job(s) a previous process left running`);

  let running: RunningServer;
  try {
    running = startServer(config, db, router);
  } catch (error) {
    if (isAddressInUse(error)) {
      log.error(`port ${config.port} is already in use — another Agni server? run \`bun run daemon status\``);
      process.exit(1);
    }
    throw error;
  }

  const settings = {
    firstTokenTimeoutMs: config.firstTokenTimeoutMs,
    turnTimeoutMs: config.turnTimeoutMs,
    // Mailboxes the owner connected in Settings → Plugins.
    mailAccounts: pluginMailResolver(config.pluginsPath),
  };
  const runner = new JobRunner(db, running.emit, { pollMs: config.jobPollMs });
  registerTurnJob(runner, { db, router, settings, emit: running.emit });
  registerBriefJob(runner, { db, emit: running.emit });
  // TAG-001: memory is extracted in batches, never on the path of a turn.
  registerTaggerJob(runner, { db, router, emit: running.emit });
  // MEM-003/MEM-006: vectors and the nightly sweep.
  registerMemoryJobs(runner, { db, router });
  // The sweep keeps itself alive; the embedding runs whenever there is
  // something left to embed.
  if (!listJobs(db, { limit: 50 }).some((job) => job.kind === "memory.consolidate")) {
    enqueueJob(db, { kind: "memory.consolidate", payload: {} });
  }
  if (!listJobs(db, { limit: 50 }).some((job) => job.kind === "memory.embed")) {
    enqueueJob(db, { kind: "memory.embed", payload: {}, runAt: new Date(Date.now() + 30_000).toISOString() });
  }
  runner.start();

  log.info(`agni server v${PROTOCOL_VERSION} listening on ${running.url} (pid ${process.pid})`);
  log.info(`db: ${config.dbPath}`);
  if (config.providers.length === 0) {
    log.warn("no providers configured — set GROQ_API_KEY / CEREBRAS_API_KEY / NVIDIA_API_KEY in .env (see .env.example)");
  } else {
    for (const provider of router.status()) {
      log.info(`provider ${provider.id.padEnd(11)} ${provider.model}`);
    }
  }

  const shutdown = (signal: string): void => {
    log.info(`${signal} — shutting down`);
    runner.stop(); // jobs land via the durable queue; a mid-flight job is requeued at next boot
    running.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function isAddressInUse(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}` : String(error);
  return text.includes("EADDRINUSE") || text.includes("address already in use");
}

// --- daemon ------------------------------------------------------------------

async function daemonCommand(args: string[]): Promise<void> {
  const [sub = "status", ...rest] = args;
  const config = loadConfig();

  if (sub === "start") {
    const outcome = await startDaemon(config);
    if (!outcome.ok) {
      console.error(`daemon did not start: ${outcome.error}`);
      for (const line of outcome.logTail ?? []) console.error(`  | ${line}`);
      process.exit(1);
    }
    if (outcome.alreadyRunning) {
      console.log(`already running${outcome.pid ? ` (pid ${outcome.pid})` : ""} — health is up`);
    } else {
      console.log(`started (pid ${outcome.pid})`);
    }
    printHealth(outcome.health, config);
    console.log(`log: ${config.logPath}`);
    return;
  }

  if (sub === "stop") {
    const outcome = await stopDaemon(config);
    console.log(outcome.message);
    if (!outcome.ok) process.exit(1);
    return;
  }

  if (sub === "restart") {
    const stopped = await stopDaemon(config);
    console.log(stopped.message);
    if (!stopped.ok) process.exit(1);
    const started = await startDaemon(config);
    if (!started.ok) {
      console.error(`daemon did not start: ${started.error}`);
      for (const line of started.logTail ?? []) console.error(`  | ${line}`);
      process.exit(1);
    }
    console.log(`started (pid ${started.pid})`);
    printHealth(started.health, config);
    return;
  }

  if (sub === "status") return await daemonStatusCommand(config);

  if (sub === "logs") {
    const lines = numberFlag(rest, "--n", 40);
    for (const line of tailLog(config.logPath, lines)) console.log(line);
    if (hasFlag(rest, "--follow")) await followLog(config.logPath);
    return;
  }

  console.error(`unknown daemon command "${sub}"`);
  usage(1);
}

async function daemonStatusCommand(config: Config): Promise<void> {
  const status = await daemonStatus(config);
  if (!status.running) {
    if (status.unhealthy) {
      console.log(`daemon: process alive (pid ${status.pid}) but /health did not answer`);
      console.log(`  log: ${status.logPath}`);
      console.log("  try: bun run daemon logs --n 40");
    } else {
      console.log(`daemon: not running${status.stalePidFile ? " (removed a stale pid file)" : ""}`);
    }
    process.exit(status.unhealthy ? 1 : 0);
  }
  console.log(`daemon: running${status.pid ? ` (pid ${status.pid})` : ""}`);
  console.log(`  health:  ${healthURL(config)}`);
  console.log(`  ws:      ws://${config.host}:${config.port}/ws`);
  console.log(`  db:      ${config.dbPath}`);
  console.log(`  pid:     ${status.pidPath}`);
  console.log(`  log:     ${status.logPath}`);
  printHealth(status.health, config);
}

function printHealth(health: HealthReport | undefined, config: Config): void {
  if (!health) return;
  const uptime = formatDuration(health.uptimeMs);
  const usage = health.usageToday;
  console.log(`  up ${uptime} · protocol v${health.v} · seq ${health.seq} · today ${usage.turns} turns (${usage.inputTokens} in / ${usage.outputTokens} out tokens)`);
  console.log(`  model streams ${health.modelCapacity?.active ?? 0}/${health.modelCapacity?.capacity ?? 0}`);
  for (const provider of health.providers) {
    const state = provider.available
      ? "ok"
      : `cooling ${Math.ceil(provider.cooldownRemainingMs / 1000)}s${provider.lastError ? `: ${provider.lastError}` : ""}`;
    console.log(`    ${provider.id.padEnd(11)} ${provider.model} ${state}`);
  }
  if (health.providers.length === 0) {
    console.log(`    (no providers configured — set a key in .env; server ${config.host}:${config.port} is up)`);
  }
}

// --- jobs --------------------------------------------------------------------

async function jobCommand(args: string[]): Promise<void> {
  const [sub = "list", ...rest] = args;
  const config = loadConfig();
  const db = openDatabase(config.dbPath);

  try {
    if (sub === "add") return jobAdd(db, rest);
    if (sub === "list") return jobList(db, rest);
    if (sub === "rm") return jobRemove(db, rest);
    if (sub === "run") return jobRun(db, rest);
    if (sub === "pause") return jobToggle(db, rest, false);
    if (sub === "resume") return jobToggle(db, rest, true);
    console.error(`unknown job command "${sub}"`);
    usage(1);
  } finally {
    db.close();
  }
}

function jobAdd(db: ReturnType<typeof openDatabase>, args: string[]): void {
  const text = positional(args).join(" ").trim();
  if (!text) {
    console.error('usage: bun run job add "text" [--in 10m] [--at 2026-10-16T21:00] [--every 1h] [--thread thr_x] [--agent agni] [--quiet]');
    process.exit(1);
  }

  const every = flag(args, "--every");
  const everyMs = every ? parseDurationMs(every) : null;
  if (every && !everyMs) {
    console.error(`--every needs a duration like 30m, 1h, 1d — got "${every}"`);
    process.exit(1);
  }

  const at = flag(args, "--at");
  const inDuration = flag(args, "--in");
  let runAt = new Date().toISOString();
  if (at) {
    const when = parseWhen(at);
    if (!when) {
      console.error(`--at needs an ISO timestamp or unix ms — got "${at}"`);
      process.exit(1);
    }
    runAt = when;
  } else if (inDuration) {
    const delayMs = parseDurationMs(inDuration);
    if (!delayMs) {
      console.error(`--in needs a duration like 10m, 2h, 1d — got "${inDuration}"`);
      process.exit(1);
    }
    runAt = new Date(Date.now() + delayMs).toISOString();
  }

  const threadID = flag(args, "--thread");
  const agentID = flag(args, "--agent");
  const payload: TurnJobPayload = {
    text,
    ...(threadID ? { threadID } : {}),
    ...(agentID ? { agentID } : {}),
    notify: !hasFlag(args, "--quiet"),
    ...(everyMs ? { everyMs } : {}),
  };

  const job = enqueueJob(db, { kind: flag(args, "--kind") ?? "turn", payload, runAt });
  console.log(`${job.id}  ${job.kind}  first run ${job.run_at}${everyMs ? ` then every ${formatDuration(everyMs)}` : ""}`);
  console.log(`  "${truncate(text, 100)}"`);
  console.log("  the daemon runs it; start it with `bun run daemon start` if it is not running");
}

function jobList(db: ReturnType<typeof openDatabase>, args: string[]): void {
  const includeFinished = hasFlag(args, "--all");
  const jobs = listJobs(db, { limit: numberFlag(args, "--n", 25), includeFinished });
  if (jobs.length === 0) {
    console.log(includeFinished ? "no jobs" : "no queued or running jobs (--all shows finished)");
    return;
  }
  for (const job of jobs) {
    const payload = safePayload(job.payload);
    const when = job.state === "queued" ? `at ${job.run_at}` : job.state;
    const note = job.result ? `  → ${truncate(job.result, 60)}` : "";
    const paused = job.enabled === 1 ? "" : "  (paused)";
    console.log(
      `${job.state.padEnd(7)} ${job.id}  ${job.kind.padEnd(5)}  ${when}  runs ${job.attempts}  "${truncate(payload, 60)}"${note}${paused}`,
    );
  }
}

/** Pause or resume without deleting: the routine stays visible in the client. */
function jobToggle(db: ReturnType<typeof openDatabase>, args: string[], enabled: boolean): void {
  const word = enabled ? "resume" : "pause";
  const target = positional(args)[0];
  if (!target) {
    console.error(`usage: bun run job ${word} <job-id-or-prefix>`);
    process.exit(1);
  }
  const job = getJobByPrefix(db, target);
  if (!job) {
    console.error(`no unique job matching "${target}"`);
    process.exit(1);
  }
  if (!setJobEnabled(db, job.id, enabled)) {
    console.error(`no job ${job.id}`);
    process.exit(1);
  }
  console.log(`${job.id} ${enabled ? "resumed — it runs at its next due time" : "paused — it stays queued but never runs"}`);
}

function jobRemove(db: ReturnType<typeof openDatabase>, args: string[]): void {
  const target = positional(args)[0];
  if (!target) {
    console.error("usage: bun run job rm <job-id-or-prefix>");
    process.exit(1);
  }
  const job = getJobByPrefix(db, target);
  if (!job) {
    console.error(`no unique job matching "${target}"`);
    process.exit(1);
  }
  if (!deleteJob(db, job.id)) {
    console.error(`job ${job.id} is running right now — it will be requeued if the daemon exits; try again after it finishes`);
    process.exit(1);
  }
  console.log(`removed ${job.id}`);
}

function jobRun(db: ReturnType<typeof openDatabase>, args: string[]): void {
  const target = positional(args)[0];
  if (!target) {
    console.error("usage: bun run job run <job-id-or-prefix>");
    process.exit(1);
  }
  const job = getJobByPrefix(db, target);
  if (!job) {
    console.error(`no unique job matching "${target}"`);
    process.exit(1);
  }
  wakeJob(db, job.id);
  console.log(`${job.id} is due now — the daemon picks it up on its next poll`);
}

function safePayload(payload: string | null): string {
  if (!payload) return "";
  try {
    const parsed = JSON.parse(payload) as { text?: string };
    return parsed.text ?? payload;
  } catch {
    return payload;
  }
}

// --- devices -----------------------------------------------------------------

async function pair(args: string[]): Promise<void> {
  const name = flag(args, "--name") ?? args.find((arg) => !arg.startsWith("--")) ?? hostname();
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const { device, token } = await mintToken(db, name);
  console.log(`device: ${device.name} (${device.id})`);
  console.log(`token:  ${token}`);
  console.log("");
  console.log("Shown once — the server stores only a hash. Point clients at:");
  console.log(`  AGNI_URL=${config.host === "127.0.0.1" ? `ws://127.0.0.1:${config.port}/ws` : `ws://${config.host}:${config.port}/ws`}`);
  console.log(`  AGNI_TOKEN=${token}`);
  db.close();
}

function migrate(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  console.log(`migrations up to date (${config.dbPath})`);
  db.close();
}

function devices(): void {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const rows = listDevices(db);
  if (rows.length === 0) console.log("no devices paired — run `bun run pair`");
  for (const device of rows) {
    const status = device.revoked_at ? "revoked" : "active";
    const seen = device.last_seen_at ? `last seen ${device.last_seen_at}` : "never connected";
    console.log(`${status.padEnd(8)} ${device.id}  "${device.name}"  (${seen})`);
  }
  db.close();
}

function revoke(args: string[]): void {
  const target = args[0];
  if (!target) {
    console.error("usage: bun run revoke <device-id-or-prefix>");
    process.exit(1);
  }
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const device = revokeDevice(db, target);
  if (!device) {
    console.error(`no device matching "${target}"`);
    db.close();
    process.exit(1);
  }
  console.log(`revoked ${device.id} ("${device.name}")`);
  db.close();
}

// --- argument helpers --------------------------------------------------------

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function numberFlag(args: string[], name: string, fallback: number): number {
  const raw = flag(args, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Non-flag words; skips values that belong to a `--flag value` pair. */
function positional(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function usage(code = 0): void {
  console.log(`agni server

  serve              start the HTTP/WebSocket server in the foreground (default)
  daemon start       start it detached; waits for /health
  daemon stop        stop the detached server
  daemon restart     stop then start
  daemon status      pid + health + provider snapshot
  daemon logs        tail the daemon log (--n 40 --follow)
  migrate            apply pending database migrations
  pair [--name X]    mint a device token for a client (shown once)
  devices            list paired devices
  revoke <id>        revoke a device token
  job add "text"     schedule a background turn (--in 10m --at ISO --every 1h --thread thr_x --quiet)
  job list [--all]   show queued and running jobs
  job rm <id>        cancel a job
  job run <id>       make a job due now`);
  process.exit(code);
}
