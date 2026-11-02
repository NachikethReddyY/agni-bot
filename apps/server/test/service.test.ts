import { expect, test } from "bun:test";
import { launchdPlist, systemdUnit } from "../src/service";

const o = { bun: "/opt/b&n/bun", script: "/src/<app>/index.ts", home: "/home/a b", logPath: "/home/a b/logs/agni.log" };

test("launchd plist escapes XML and keeps the process alive", () => {
  const p = launchdPlist(o);
  expect(p).toContain("/opt/b&amp;n/bun");
  expect(p).toContain("/src/&lt;app&gt;/index.ts");
  expect(p).toContain("<key>KeepAlive</key>\n  <true/>");
  expect(p).toContain("<key>RunAtLoad</key>");
  expect(p).toContain("<string>serve</string>");
  expect(p).toContain("<key>AGNI_HOME</key>");
});

test("systemd unit quotes paths and restarts always", () => {
  const u = systemdUnit(o);
  expect(u).toContain('ExecStart="/opt/b&n/bun" "/src/<app>/index.ts" serve');
  expect(u).toContain("Restart=always");
  expect(u).toContain('Environment="AGNI_HOME=/home/a b"');
});
