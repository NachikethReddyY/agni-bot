/**
 * Presentation of machine values — dates, durations, token counts, cadences.
 * Kept in one place so the app never invents a second way to say the same
 * thing, and so tests can pin the wording.
 */

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const dayHeadingFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});

const shortDayFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const numberFormat = new Intl.NumberFormat();

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** ISO-8601 as the server writes it, with or without fractional seconds. */
export function parseISO(text: string): Date | null {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function time(date: Date): string {
  return timeFormat.format(date);
}

/** Separator text for a day boundary in the transcript. */
export function dayTitle(date: Date, now: Date = new Date()): string {
  if (isSameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return "Yesterday";
  return dayHeadingFormat.format(date);
}

/** Timestamps on rows: clock time today, short date before that. */
export function stamp(date: Date, now: Date = new Date()): string {
  return isSameDay(date, now) ? time(date) : shortDayFormat.format(date);
}

/** A moment in the thread, said so the owner knows when. */
export function numericDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

/**
 * The stamp over a run of messages: the clock today, "Yesterday" with the
 * clock, and the date with the clock for anything older.
 */
export function moment(date: Date, now: Date = new Date()): string {
  if (isSameDay(date, now)) return time(date);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, yesterday)) return `Yesterday · ${time(date)}`;
  return `${numericDate(date)} ${time(date)}`;
}

/** Sidebar freshness: "now", "12m", "3h", then a date. */
export function freshness(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(0, (now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)}d`;
  return shortDayFormat.format(date);
}

export function latency(milliseconds: number | null | undefined): string | null {
  if (milliseconds === null || milliseconds === undefined) return null;
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

export function tokens(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return null;
  if (count < 1000) return `${count}`;
  if (count < 100_000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.floor(count / 1000)}k`;
}

export function uptime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

/** A routine reads as a cadence, not as a number of milliseconds. */
export function cadence(everyMs: number | null | undefined, runAt: Date | null | undefined): string {
  if (everyMs === null || everyMs === undefined || everyMs <= 0) {
    if (!runAt) return "Once";
    return `Once, ${dayTitle(runAt).toLowerCase()} at ${time(runAt)}`;
  }
  const minutes = Math.floor(everyMs / 60_000);
  const hours = Math.floor(everyMs / 3_600_000);

  if (minutes < 1) return `Every ${Math.max(1, Math.floor(everyMs / 1000))} seconds`;
  if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (hours < 24) {
    const anchored = runAt ? ` at ${time(runAt)}` : "";
    return `Every ${hours} hour${hours === 1 ? "" : "s"}${anchored}`;
  }
  const days = Math.floor(everyMs / 86_400_000);
  if (!runAt) return `Every ${days} day${days === 1 ? "" : "s"}`;
  const weekday = weekdayFormat.format(runAt);
  return days === 1 ? `Every day at ${time(runAt)}` : `Every ${weekday} at ${time(runAt)}`;
}

/** One-line, whitespace-collapsed preview for a list row. */
export function preview(text: string, limit = 140): string {
  const collapsed = text.split(/\s+/u).filter(Boolean).join(" ");
  const characters = Array.from(collapsed);
  if (characters.length <= limit) return collapsed;
  return `${characters.slice(0, limit).join("")}…`;
}

/** "53 site visitors", "1 turn" — counts that read naturally. */
export function count(value: number, noun: string): string {
  return `${numberFormat.format(value)} ${noun}${value === 1 ? "" : "s"}`;
}

export const format = {
  parseISO,
  time,
  dayTitle,
  stamp,
  moment,
  numericDate,
  freshness,
  latency,
  tokens,
  uptime,
  cadence,
  preview,
  count,
};
