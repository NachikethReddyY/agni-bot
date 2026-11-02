/**
 * Per-bot proactivity: quiet hours and a daily cap on unprompted pushes.
 * Held messages still land in the transcript; only the push is withheld.
 */
import type { Database } from "bun:sqlite";

export interface Proactivity {
  quietStart: string | null;
  quietEnd: string | null;
  maxPerDay: number | null;
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === undefined || m === undefined || h > 23 || m > 59) throw new Error(`"${hhmm}" is not a time of day`);
  return h * 60 + m;
}

export function getProactivity(db: Database, agentId: string): Proactivity {
  const row = db
    .query<{ quiet_start: string | null; quiet_end: string | null; max_per_day: number | null }, [string]>(
      "SELECT quiet_start, quiet_end, max_per_day FROM agent_proactivity WHERE agent_id = ?",
    )
    .get(agentId);
  return { quietStart: row?.quiet_start ?? null, quietEnd: row?.quiet_end ?? null, maxPerDay: row?.max_per_day ?? null };
}

/** Merge the given fields (undefined = keep). Quiet hours are both-or-neither. */
export function setProactivity(db: Database, agentId: string, patch: Partial<Proactivity>): Proactivity {
  const next = { ...getProactivity(db, agentId) };
  if (patch.quietStart !== undefined) next.quietStart = patch.quietStart;
  if (patch.quietEnd !== undefined) next.quietEnd = patch.quietEnd;
  if (patch.maxPerDay !== undefined) next.maxPerDay = patch.maxPerDay;
  if ((next.quietStart === null) !== (next.quietEnd === null)) throw new Error("quiet hours need both a start and an end");
  if (next.quietStart !== null) { minutes(next.quietStart); minutes(next.quietEnd!); }
  db.run(
    `INSERT INTO agent_proactivity (agent_id, quiet_start, quiet_end, max_per_day) VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, max_per_day = excluded.max_per_day`,
    [agentId, next.quietStart, next.quietEnd, next.maxPerDay],
  );
  return next;
}

function local(now: Date, timeZone: string): { day: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** True when `now` falls inside the window (which may wrap midnight). */
export function inQuietHours(p: Proactivity, now: Date, timeZone: string): boolean {
  if (p.quietStart === null || p.quietEnd === null) return false;
  const start = minutes(p.quietStart);
  const end = minutes(p.quietEnd);
  const at = local(now, timeZone).minute;
  if (start === end) return false;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/**
 * May this bot push right now? Checks quiet hours and the daily cap; when it
 * says yes it has already counted the push. A bot with no settings is free.
 */
export function allowPush(db: Database, agentId: string, now = new Date(), timeZone = "UTC"): boolean {
  const p = getProactivity(db, agentId);
  if (inQuietHours(p, now, timeZone)) return false;
  if (p.maxPerDay === null) return true;
  const { day } = local(now, timeZone);
  return db.transaction(() => {
    const sent = db.query<{ count: number }, [string, string]>("SELECT count FROM proactive_sent WHERE agent_id = ? AND day = ?").get(agentId, day)?.count ?? 0;
    if (sent >= p.maxPerDay!) return false;
    db.run(
      "INSERT INTO proactive_sent (agent_id, day, count) VALUES (?, ?, 1) ON CONFLICT(agent_id, day) DO UPDATE SET count = count + 1",
      [agentId, day],
    );
    return true;
  })();
}
