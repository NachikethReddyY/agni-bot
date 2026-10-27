#!/usr/bin/env bun
/**
 * agni — protocol client for the daemon.
 *
 *   agni chat [--thread thr_x]     interactive chat (streaming, approvals, resync)
 *   agni threads [--n 20]          recent threads
 *   agni history --thread thr_x    durable message history
 *   agni ping                      check the server + provider health
 *   agni ask "question"            one turn, streamed
 *   agni bench [--n 10]            P0 gate: p50 ≤ 1.5 s
 *
 * Connection: --url or AGNI_URL (default ws://127.0.0.1:8787/ws);
 * token: --token or AGNI_TOKEN (from `bun run pair`).
 */
import { historyCommand, listThreadsCommand, startChat } from "./chat";
import { AgniSocket, healthURL, type AskStats } from "./client";

const args = Bun.argv.slice(2);
const [command = "help", ...rest] = args;

if (command === "chat") await chat();
else if (command === "threads") await threadsCommand();
else if (command === "history") await history();
else if (command === "ping") await ping();
else if (command === "ask") await askCommand();
else if (command === "bench") await bench();
else usage(0);

// --- tiny argument helpers -------------------------------------------------

function option(argv: string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function numberOption(argv: string[], name: string, fallback: number): number {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Non-flag words; skips values that belong to a `--flag value` pair. */
function positional(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (!arg.includes("=")) index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function serverURL(argv: string[]): string {
  return option(argv, "--url") ?? Bun.env.AGNI_URL ?? "ws://127.0.0.1:8787/ws";
}

function token(argv: string[]): string {
  const value = option(argv, "--token") ?? Bun.env.AGNI_TOKEN;
  if (!value) {
    console.error("no token — run `bun run pair` and set AGNI_TOKEN (or pass --token)");
    process.exit(1);
  }
  return value;
}

async function connect(argv: string[]): Promise<AgniSocket> {
  try {
    return await AgniSocket.connect(serverURL(argv), token(argv), "cli");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// --- commands --------------------------------------------------------------

async function ping(): Promise<void> {
  const target = healthURL(serverURL(rest));
  try {
    const response = await fetch(target);
    const body: unknown = await response.json();
    console.log(JSON.stringify(body, null, 2));
    if (!response.ok) process.exit(1);
  } catch {
    console.error(`cannot reach ${target} — is the server running? (bun run daemon start)`);
    process.exit(1);
  }
}

async function chat(): Promise<void> {
  await startChat({
    url: serverURL(rest),
    token: token(rest),
    device: "cli-chat",
    ...(option(rest, "--thread") ? { threadID: option(rest, "--thread") as string } : {}),
    ...(option(rest, "--agent") ? { agentID: option(rest, "--agent") as string } : {}),
  });
}

async function threadsCommand(): Promise<void> {
  await listThreadsCommand(
    { url: serverURL(rest), token: token(rest), device: "cli" },
    numberOption(rest, "--n", 20),
  );
}

async function history(): Promise<void> {
  const threadID = option(rest, "--thread") ?? positional(rest)[0];
  if (!threadID) {
    console.error('usage: agni history --thread thr_x [--n 50]');
    process.exit(1);
  }
  await historyCommand({ url: serverURL(rest), token: token(rest), device: "cli" }, threadID, numberOption(rest, "--n", 50));
}

async function askCommand(): Promise<void> {
  const text = positional(rest).join(" ") || option(rest, "--text");
  if (!text) {
    console.error('usage: agni ask "question"');
    process.exit(1);
  }
  const socket = await connect(rest);
  const stats = await socket.ask({
    text,
    threadID: option(rest, "--thread") ?? "",
    timeoutMs: numberOption(rest, "--timeout-ms", 45_000),
    onDelta: (delta) => process.stdout.write(delta),
  });
  socket.close();
  if (stats.text && !stats.text.endsWith("\n")) process.stdout.write("\n");
  console.error(formatStats(stats));
  if (stats.stopReason !== "end" || stats.error) process.exit(1);
}

interface BenchRow {
  index: number;
  stats: AskStats;
}

async function bench(): Promise<void> {
  const n = numberOption(rest, "--n", 10);
  const question = option(rest, "--q") ?? (positional(rest).join(" ") || "In one sentence: what is two plus two?");
  const fresh = hasFlag(rest, "--fresh");
  const targetMs = numberOption(rest, "--target-ms", 1500);
  const timeoutMs = numberOption(rest, "--timeout-ms", 45_000);

  const socket = await connect(rest);
  const rows: BenchRow[] = [];
  let threadID = "";
  for (let index = 1; index <= n; index += 1) {
    const stats = await socket.ask({ text: question, threadID: fresh ? "" : threadID, timeoutMs });
    if (!fresh && stats.threadID) threadID = stats.threadID;
    rows.push({ index, stats });
    const server = stats.usage?.latencyMs !== undefined ? `${pad(stats.usage.latencyMs)}ms` : "   —  ";
    const model = stats.usage?.model ?? "—";
    console.log(
      ` ${pad(index, 2)}  first ${pad(stats.firstTokenMs)}ms  total ${pad(stats.totalMs)}ms  server ${server}  ${model}${
        stats.stopReason === "end" ? "" : `  [${stats.stopReason}]`
      }`,
    );
    if (stats.error) console.error(`      error ${stats.error.code}: ${stats.error.message}`);
  }
  socket.close();

  const serverLatencies = rows
    .map((row) => row.stats.usage?.latencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const totals = rows.map((row) => row.stats.totalMs).sort((a, b) => a - b);
  const firsts = rows
    .map((row) => row.stats.firstTokenMs)
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);

  const completed = rows.filter((row) => row.stats.stopReason === "end").length;
  const complete = serverLatencies.length === rows.length;
  const gateValues = complete ? serverLatencies : totals;
  const gate = percentile(gateValues, 50);
  const gateLabel = complete ? "server" : "client total";

  console.log("");
  console.log(`bench n=${rows.length} completed=${completed} (${gateLabel} latency gated, target ${targetMs}ms)`);
  if (serverLatencies.length > 0) {
    console.log(
      `  server  p50 ${pad(percentile(serverLatencies, 50))}ms  p95 ${pad(percentile(serverLatencies, 95))}ms  min ${pad(serverLatencies[0] ?? 0)}ms  max ${pad(serverLatencies[serverLatencies.length - 1] ?? 0)}ms`,
    );
  }
  console.log(`  client  total p50 ${pad(percentile(totals, 50))}ms  first-token p50 ${pad(percentile(firsts, 50))}ms`);
  const fail = gate > targetMs || completed !== rows.length;
  console.log(
    fail
      ? `FAIL — ${gateLabel} p50 ${gate}ms > ${targetMs}ms (or incomplete turns)`
      : `PASS — ${gateLabel} p50 ${gate}ms ≤ ${targetMs}ms`,
  );
  process.exit(fail ? 1 : 0);
}

// --- formatting ------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function pad(value: number, width = 5): string {
  return String(value).padStart(width, " ");
}

function formatStats(stats: AskStats): string {
  const parts = [
    stats.usage?.provider && stats.usage.model ? `${stats.usage.provider}/${stats.usage.model}` : undefined,
    `first ${stats.firstTokenMs}ms`,
    `total ${stats.totalMs}ms`,
    stats.usage?.latencyMs !== undefined ? `server ${stats.usage.latencyMs}ms` : undefined,
    stats.stopReason,
    stats.error ? `${stats.error.code}: ${stats.error.message}` : undefined,
  ].filter(Boolean);
  return `— ${parts.join(" · ")}`;
}

function usage(code: number): void {
  console.log(`agni — protocol client for the daemon

  chat [--thread thr_x] [--agent agni]   interactive chat (streams, approvals, resync)
  threads [--n 20]                       list recent threads
  history --thread thr_x [--n 50]        durable message history
  ping                                   check the server and provider health
  ask "question" [--thread thr_x]        one turn, streamed
  bench [options]                        N turns; gates on p50 latency

options: chat/history --thread, chat --agent; bench --n 10 --q "…" --fresh --target-ms 1500; --url ws://… --token agni_…`);
  process.exit(code);
}
