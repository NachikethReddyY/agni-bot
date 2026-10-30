/**
 * AGNI_HOME (default ~/.agni) holds every file Agni keeps:
 *
 *   config.env       secrets and settings (mode 600)
 *   providers.json   chosen models + custom endpoints
 *   plugins.json     plugin auth + activation
 *   data/            agni.sqlite, backups/, share/, attachments/, chatgpt/
 *   scratch/         the agent's free-write tree
 *   skills/          ~/.agni/skills/<name>/SKILL.md
 *   logs/agni.log    run/agni.pid
 *   app/  bin/agni   only when installed by infra/install.sh
 *
 * Every path default comes from here; per-file AGNI_*_PATH overrides still win.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export function agniHome(env: Env = process.env): string {
  return resolve(env.AGNI_HOME?.trim() || join(homedir(), ".agni"));
}

export function homePath(...parts: string[]): string {
  return join(agniHome(), ...parts);
}

/** Parse a dotenv file: KEY=value, `#` comments, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match) continue;
    let value = match[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]!] = value;
  }
  return out;
}

/**
 * Load AGNI_HOME/config.env into process.env. Variables already set (the
 * shell, or a repo .env Bun loaded in dev) win, so nothing changes for dev.
 */
export function loadHomeEnv(env: Env = process.env): void {
  const path = join(agniHome(env), "config.env");
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(path, "utf8")))) {
    if (!env[key]) env[key] = value;
  }
}

/**
 * One-time move of files from the old layout (DB, log and pid at the top of
 * ~/.agni; providers.json and scratch/ in the repo checkout). Returns
 * the pid of a still-running old daemon instead of moving anything under it.
 */
export function migrateHomeLayout(env: Env = process.env, repoRoot = resolve(import.meta.dir, "../../..")): { movedFrom: string[]; blockedByPid?: number } {
  const home = agniHome(env);
  const oldPid = join(home, "agni.pid");
  if (existsSync(oldPid) && !env.AGNI_PID_PATH) {
    try {
      const pid = (JSON.parse(readFileSync(oldPid, "utf8")) as { pid?: unknown }).pid;
      if (typeof pid === "number" && pidAlive(pid)) return { movedFrom: [], blockedByPid: pid };
    } catch { /* unreadable pid file: treat as stale */ }
  }
  const moves: Array<[string, string, string | undefined]> = [
    // [old, new, override that opts this file out]
    ...["agni.sqlite", "agni.sqlite-wal", "agni.sqlite-shm", "backups", "share", "attachments", "chatgpt"]
      .map((name): [string, string, string | undefined] => [join(home, name), join(home, "data", name), env.AGNI_DB_PATH]),
    [join(home, "agni.log"), join(home, "logs", "agni.log"), env.AGNI_LOG_PATH],
    [oldPid, join(home, "run", "agni.pid"), env.AGNI_PID_PATH],
    [join(repoRoot, "data", "providers.json"), join(home, "providers.json"), env.AGNI_PROVIDER_CONFIG_PATH],
    [join(repoRoot, "scratch"), join(home, "scratch"), env.AGNI_SCRATCH_DIR],
  ];
  const movedFrom: string[] = [];
  for (const [from, to, override] of moves) {
    if (override?.trim() || !existsSync(from) || existsSync(to)) continue;
    mkdirSync(join(to, ".."), { recursive: true });
    try {
      renameSync(from, to);
      movedFrom.push(from);
    } catch {
      // Another volume: leave it in place rather than half-copy data.
    }
  }
  return { movedFrom };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
