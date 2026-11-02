import { describe, expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { parseClientFrame } from "@agni/protocol";
import { openDatabase } from "../src/db";
import { JobRunner } from "../src/jobs/runner";
import { PushService, saveSubscription } from "../src/push/web-push";
import { seedCheckAppsRoutine } from "../src/routines/templates";
import { enqueueJob, getJob } from "../src/stores/jobs";
import { allowPush, getProactivity, inQuietHours, setProactivity } from "../src/stores/proactivity";

function sub(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.from("0123456789abcdef").toString("base64url") } };
}

describe("proactivity", () => {
  test("quiet hours wrap midnight and use the given zone", () => {
    const p = { quietStart: "22:00", quietEnd: "07:00", maxPerDay: null };
    expect(inQuietHours(p, new Date("2026-10-30T23:30:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(p, new Date("2026-10-30T06:59:00Z"), "UTC")).toBe(true);
    expect(inQuietHours(p, new Date("2026-10-30T12:00:00Z"), "UTC")).toBe(false);
    // 12:00 UTC is 05:00 in Los Angeles (PDT): inside the window there.
    expect(inQuietHours(p, new Date("2026-10-30T12:00:00Z"), "America/Los_Angeles")).toBe(true);
  });

  test("daily cap counts allowed pushes and resets the next day", () => {
    const db = openDatabase(":memory:");
    setProactivity(db, "ea", { maxPerDay: 2 });
    const noon = new Date("2026-10-30T12:00:00Z");
    expect([allowPush(db, "ea", noon), allowPush(db, "ea", noon), allowPush(db, "ea", noon)]).toEqual([true, true, false]);
    expect(allowPush(db, "ea", new Date("2026-10-31T12:00:00Z"))).toBe(true);
    expect(allowPush(db, "other", noon)).toBe(true);
  });

  test("quiet hours need both ends and a valid time", () => {
    const db = openDatabase(":memory:");
    expect(() => setProactivity(db, "ea", { quietStart: "22:00" })).toThrow();
    expect(() => setProactivity(db, "ea", { quietStart: "25:00", quietEnd: "07:00" })).toThrow();
    setProactivity(db, "ea", { quietStart: "22:00", quietEnd: "07:00", maxPerDay: 3 });
    setProactivity(db, "ea", { quietStart: null, quietEnd: null });
    expect(getProactivity(db, "ea")).toEqual({ quietStart: null, quietEnd: null, maxPerDay: 3 });
  });

  test("protocol accepts the new client frames", () => {
    expect(parseClientFrame({ type: "push.subscribe", subscription: sub("https://push.example/abc") }).ok).toBe(true);
    expect(parseClientFrame({ type: "push.vapid.get" }).ok).toBe(true);
    expect(parseClientFrame({ type: "agent.proactivity", agentId: "ea", quietStart: "22:00", quietEnd: "07:00", maxPerDay: null }).ok).toBe(true);
    expect(parseClientFrame({ type: "agent.proactivity", agentId: "ea", quietStart: "late" }).ok).toBe(false);
  });
});

describe("web push", () => {
  const make = (status: number, calls: string[] = []) => {
    const db = openDatabase(":memory:");
    const service = new PushService(db, {
      vapidPath: ":memory:",
      send: async (url, init) => {
        calls.push(url);
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toStartWith("vapid ");
        expect(init.body.byteLength).toBeGreaterThan(0);
        return { status };
      },
    });
    saveSubscription(db, "dev1", sub("https://push.example/one"));
    return { db, service, calls };
  };

  test("encrypts and sends to a device with no live socket", async () => {
    const { service, calls } = make(201);
    expect(await service.notify({ title: "t", body: "b" }, new Set())).toBe(1);
    expect(calls).toEqual(["https://push.example/one"]);
  });

  test("skips a device that has an authed socket", async () => {
    const { service, calls } = make(201);
    expect(await service.notify({ title: "t", body: "b" }, new Set(["dev1"]))).toBe(0);
    expect(calls).toEqual([]);
  });

  test("drops a subscription the push service reports gone", async () => {
    const { db, service } = make(410);
    await service.notify({ title: "t", body: "b" }, new Set());
    expect(db.query("SELECT count(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
  });

  test("a bot in quiet hours holds the push", async () => {
    const { db, service, calls } = make(201);
    setProactivity(db, "ea", { quietStart: "00:00", quietEnd: "23:59" });
    expect(await service.notify({ title: "t", body: "b", agentId: "ea" }, new Set())).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("job runner pool", () => {
  async function run(kind: string, concurrency: number) {
    const db = openDatabase(":memory:");
    let active = 0;
    let peak = 0;
    const runner = new JobRunner(db, () => undefined, { concurrency });
    runner.register(kind, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(30);
      active -= 1;
    });
    enqueueJob(db, { kind });
    enqueueJob(db, { kind });
    await runner.tick();
    return peak;
  }

  test("independent kinds overlap up to the pool size", async () => {
    expect(await run("turn", 2)).toBe(2);
    expect(await run("turn", 1)).toBe(1);
  });

  test("a singleton kind never runs twice at once", async () => {
    expect(await run("memory.consolidate", 2)).toBe(1);
  });
});

describe("check my apps template", () => {
  test("is seeded once, paused", () => {
    const db = openDatabase(":memory:");
    expect(seedCheckAppsRoutine(db, "UTC")).toBe(true);
    expect(seedCheckAppsRoutine(db, "UTC")).toBe(false);
    const row = db.query<{ job_id: string }, []>("SELECT job_id FROM routines").get()!;
    expect(getJob(db, row.job_id)?.enabled).toBe(0);
  });
});
