/** `agni service install|uninstall|status`: run `serve` under launchd (macOS) or systemd --user (Linux). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Config } from "./config";
import { daemonStatus, fetchHealth } from "./daemon";
import { agniHome } from "./home";

export const LAUNCHD_LABEL = "dev.agni.server";
export const SYSTEMD_UNIT = "agni.service";

export interface ServiceOptions {
  bun: string;
  script: string;
  home: string;
  logPath: string;
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function launchdPlist(o: ServiceOptions): string {
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(o.bun)}</string>
    <string>${e(o.script)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${e(o.home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGNI_HOME</key>
    <string>${e(o.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${e(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${e(o.logPath)}</string>
</dict>
</plist>
`;
}

/** systemd splits ExecStart on whitespace; quote each word and escape backslash, quote and %. */
const sdQuote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(o: ServiceOptions): string {
  return `[Unit]
Description=Agni Bot server
After=network-online.target

[Service]
ExecStart=${sdQuote(o.bun)} ${sdQuote(o.script)} serve
WorkingDirectory=${o.home.replace(/%/g, "%%")}
Environment=${sdQuote(`AGNI_HOME=${o.home}`)}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
}

function options(config: Config): ServiceOptions {
  return {
    bun: process.execPath,
    script: resolve(import.meta.dir, "index.ts"),
    home: agniHome(),
    logPath: resolve(config.logPath),
  };
}

function run(cmd: string[], allowFail = false): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim();
  if (r.exitCode !== 0 && !allowFail) throw new Error(`${cmd.join(" ")} failed: ${out}`);
  return { ok: r.exitCode === 0, out };
}

const plistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const unitPath = (): string => join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);

export async function serviceCommand(sub: string | undefined, config: Config): Promise<void> {
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") throw new Error(`service is not supported on ${process.platform}`);
  const target = `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`;

  if (sub === "install") {
    // Only the detached daemon has a pid file; a server answering without one
    // is usually this service already, and reinstalling it is the upgrade path.
    const status = await daemonStatus(config);
    if (status.pid !== undefined && (status.running || status.unhealthy)) {
      throw new Error("the detached daemon is running; run `agni daemon stop` first, then install the service");
    }
    const o = options(config);
    mkdirSync(dirname(o.logPath), { recursive: true, mode: 0o700 });
    if (mac) {
      const path = plistPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, launchdPlist(o));
      run(["launchctl", "bootout", target], true);
      run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 501}`, path]);
      console.log(`installed ${path}`);
    } else {
      const path = unitPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, systemdUnit(o));
      run(["systemctl", "--user", "daemon-reload"]);
      run(["systemctl", "--user", "enable", "--now", "agni"]);
      console.log(`installed ${path}`);
      console.log("headless box? run `loginctl enable-linger $USER` so it starts without a login session");
    }
    console.log(`logs: ${o.logPath}`);
  } else if (sub === "uninstall") {
    if (mac) {
      run(["launchctl", "bootout", target], true);
      rmSync(plistPath(), { force: true });
    } else {
      run(["systemctl", "--user", "disable", "--now", "agni"], true);
      rmSync(unitPath(), { force: true });
      run(["systemctl", "--user", "daemon-reload"], true);
    }
    console.log("service removed (data in AGNI_HOME is untouched)");
  } else if (sub === "status") {
    const installed = existsSync(mac ? plistPath() : unitPath());
    console.log(`installed: ${installed ? "yes" : "no"}`);
    const r = mac ? run(["launchctl", "print", target], true) : run(["systemctl", "--user", "status", "agni", "--no-pager"], true);
    const lines = r.out.split("\n").filter((l) => /state|pid|Active:|Main PID|last exit/i.test(l));
    console.log(r.ok ? lines.map((l) => `  ${l.trim()}`).join("\n") : "  not loaded");
    const health = await fetchHealth(config);
    console.log(health ? `health: ok (up ${Math.round(health.uptimeMs / 1000)}s)` : "health: no response");
  } else {
    throw new Error("usage: service install|uninstall|status");
  }
}
