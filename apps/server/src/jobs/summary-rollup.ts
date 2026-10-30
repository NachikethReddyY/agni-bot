/**
 * The summary rollup (CMP-001).
 *
 * Block summaries roll up into a day summary, day summaries into an epoch
 * summary (a week). The rollup is deterministic — it is the union of the
 * decisions and the open loops, not a model call — so it can run in the
 * background without a provider and without a cost.
 *
 * It is idempotent: a day that already has a summary is left alone.
 */
import type { Database } from "bun:sqlite";
import { log } from "../log";
import {
  dayOf,
  listBlockSummariesForDay,
  listSummaries,
  saveSummary,
  type SummaryRow,
} from "../stores/summaries";

export interface RollupResult {
  days: number;
  epochs: number;
}

/** The decisions and open loops of a set of summaries, deduplicated. */
export function compose(texts: string[], limit = 12): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const text of texts) {
    for (const line of text.split(/[.;]\s+/)) {
      const cleaned = line.trim();
      if (!cleaned || cleaned.length < 8) continue;
      const key = cleaned.toLowerCase().replace(/[.;:,\s]+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(cleaned);
      if (parts.length >= limit) return parts.join("; ") + "…";
    }
  }
  return parts.join("; ");
}

/**
 * Roll the block summaries of yesterday into a day summary, and the day
 * summaries of the last week into an epoch summary.
 */
export function rollupSummaries(
  db: Database,
  options: { now?: Date } = {},
): RollupResult {
  const now = options.now ?? new Date();
  const result: RollupResult = { days: 0, epochs: 0 };
  // shortcut: day keys are UTC (dayOf), so "over" means UTC midnight, not the
  // owner's local midnight; add an owner timezone when one exists.
  const today = dayOf(now.toISOString());

  // The conversations that have block summaries at all.
  const conversations = db
    .query<{ conversation_id: string; agent_id: string }, []>(
      "SELECT DISTINCT conversation_id, agent_id FROM summaries WHERE level = 'block'",
    )
    .all();

  for (const conversation of conversations) {
    // A day summary per day, for the days that have block summaries and do
    // not have a day summary yet.
    const days = db
      .query<{ day: string }, [string]>(
        "SELECT DISTINCT day FROM summaries WHERE conversation_id = ? AND level = 'block' AND day IS NOT NULL",
      )
      .all(conversation.conversation_id);
    for (const { day } of days) {
      if (day >= today) continue; // a partial day is not frozen
      const existing = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM summaries WHERE conversation_id = ? AND level = 'day' AND day = ? LIMIT 1",
        )
        .get(conversation.conversation_id, day);
      if (existing) continue;
      const blocks = listBlockSummariesForDay(db, {
        conversationID: conversation.conversation_id,
        day,
      });
      if (blocks.length === 0) continue;
      const text = compose(blocks.map((summary) => summary.text));
      if (!text) continue;
      saveSummary(db, {
        conversationID: conversation.conversation_id,
        agentID: conversation.agent_id,
        level: "day",
        title: day,
        text,
        parentID: blocks[0]!.id,
        day,
        sourceFrom: blocks[0]?.source_from ?? null,
        sourceTo: blocks[blocks.length - 1]?.source_to ?? null,
      });
      result.days += 1;
    }

    // An epoch summary per week, from the day summaries.
    const daySummaries = listSummaries(db, {
      conversationID: conversation.conversation_id,
      level: "day",
      limit: 60,
    });
    const weeks = new Map<string, SummaryRow[]>();
    for (const summary of daySummaries) {
      if (!summary.day) continue;
      const week = weekOf(summary.day);
      weeks.set(week, [...(weeks.get(week) ?? []), summary]);
    }
    for (const [week, summaries] of weeks) {
      // Only a finished week (every day in it over) is rolled up.
      if (weekOf(today) === week) continue;
      const existing = db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM summaries WHERE conversation_id = ? AND level = 'epoch' AND day = ? LIMIT 1",
        )
        .get(conversation.conversation_id, week);
      if (existing) continue;
      const text = compose(summaries.map((summary) => summary.text));
      if (!text) continue;
      saveSummary(db, {
        conversationID: conversation.conversation_id,
        agentID: conversation.agent_id,
        level: "epoch",
        title: `Week of ${week}`,
        text,
        parentID: summaries[0]!.id,
        day: week,
        sourceFrom: summaries[0]?.source_from ?? null,
        sourceTo: summaries[summaries.length - 1]?.source_to ?? null,
      });
      result.epochs += 1;
    }
  }
  log.info(`summaries: rolled up ${result.days} day(s) and ${result.epochs} epoch(s)`);
  return result;
}

/** The Monday-based week a day falls in. */
export function weekOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  const date = new Date(Number.isFinite(at) ? at : Date.now());
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}
