/**
 * The tagger job — memory in batches (TAG-001, TAG-004).
 *
 * The tagger never runs on the path of a turn. It runs afterwards, in
 * batches: every K turns, or on idle when the queue is quiet and messages
 * are still waiting. A turn that is small talk produces no items at all.
 *
 * The rules are enforced in `agent/tagger.ts`, not in the prompt: an invalid
 * item is dropped and logged, an item below the confidence floor is not
 * promoted, and only owner-stated content may become a fact about the owner.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import { log } from "../log";
import { enqueueJob, listJobs, parseJobPayload, type JobRow } from "../stores/jobs";
import type { JobRunner } from "./runner";
import { applyTaggerItems, parseTaggerOutput, TAGGER_SYSTEM_PROMPT } from "../agent/tagger";
import { nowISO } from "../util/ids";
import { listAgentMemories } from "../stores/agent-memories";

/** How many turns between batches. */
export const TAGGER_BATCH_TURNS = 5;
/** How long to wait for more turns before draining the batch anyway. */
export const TAGGER_IDLE_MS = 60_000;
/** How many messages one batch reads. */
const TAGGER_BATCH_MESSAGES = 40;
/** The largest message the tagger sees. */
const TAGGER_MAX_MESSAGE_CHARS = 1_200;

/**
 * Turns since the last batch. Process-local on purpose: it is a hint about
 * *when* to sweep, not a fact worth a restart.
 */
let turnsSinceLastBatch = 0;

/** How many unreadable answers one batch gets before it is marked tagged. */
export const TAGGER_MAX_ATTEMPTS = 3;
/**
 * Unreadable-answer counts, by the batch's first message id.
 * shortcut: process-local, so a restart gives a bad batch 3 more tries;
 * persist per message if restarts ever loop on one batch.
 */
const failedBatches = new Map<string, number>();

/** Count a turn and report how many have passed since the last batch. */
export function turnsSinceTag(): number {
  turnsSinceLastBatch += 1;
  return turnsSinceLastBatch;
}

/** The batch ran: the counter starts again. */
export function resetTaggerTurns(): void {
  turnsSinceLastBatch = 0;
}

export interface TaggerJobPayload {
  channelID?: string;
  agentID?: string;
  /** Why the batch ran: the turn count, or idle. */
  reason?: string;
}

export interface TaggerJobDeps {
  db: Database;
  router: Router;
  emit: (frame: ServerFrameBody) => void;
}

/**
 * Schedule a batch, if there is anything to tag. The batch runs now when
 * enough turns have passed, and otherwise waits for the queue to go quiet —
 * a trailing two messages still get tagged.
 */
export function scheduleTagger(
  db: Database,
  options: { channelID?: string; agentID?: string; turns?: number } = {},
): void {
  const pending = db
    .query<{ count: number }, []>(
      `SELECT count(*) AS count FROM channel_messages
       WHERE tagged_at IS NULL AND salience <> 'temp' AND from_type <> 'system' AND peer_influenced = 0`,
    )
    .get()?.count ?? 0;
  if (pending === 0) return;
  // One pending batch is enough: it drains everything waiting.
  const queued = listJobs(db, { limit: 50 }).some((job) => job.kind === "tagger");
  if (queued) return;
  const turns = options.turns ?? 0;
  const due = turns >= TAGGER_BATCH_TURNS;
  enqueueJob(db, {
    kind: "tagger",
    payload: {
      ...(options.channelID ? { channelID: options.channelID } : {}),
      ...(options.agentID ? { agentID: options.agentID } : {}),
      reason: due ? "batch" : "idle",
    } satisfies TaggerJobPayload,
    runAt: due ? nowISO() : new Date(Date.now() + TAGGER_IDLE_MS).toISOString(),
  });
}

export function registerTaggerJob(runner: JobRunner, deps: TaggerJobDeps): void {
  runner.register("tagger", async (job: JobRow) => {
    const payload = parseJobPayload<TaggerJobPayload>(job);
    // H24: one channel per batch, and the bot is the channel's own.
    const channelID = payload.channelID ?? deps.db
      .query<{ channel_id: string }, []>(
        `SELECT channel_id FROM channel_messages
         WHERE tagged_at IS NULL AND salience <> 'temp' AND from_type <> 'system' AND peer_influenced = 0
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get()?.channel_id;
    if (!channelID) return { result: "nothing to tag" };
    const messages = deps.db
      .query<{ id: string; from_type: string; from_id: string; text: string; created_at: string; channel_id: string }, [string, number]>(
        `SELECT id, from_type, from_id, text, created_at, channel_id
         FROM channel_messages
         WHERE channel_id = ? AND tagged_at IS NULL AND salience <> 'temp' AND from_type <> 'system' AND peer_influenced = 0
         ORDER BY created_at ASC, rowid ASC
         LIMIT ?`,
      )
      .all(channelID, TAGGER_BATCH_MESSAGES);
    if (messages.length === 0) return { result: "nothing to tag" };

    const agentID = deps.db
      .query<{ agent_id: string }, [string]>("SELECT agent_id FROM channels WHERE id = ?")
      .get(channelID)?.agent_id;
    if (!agentID) return { result: "the channel is gone" };
    const transcript = messages
      .map((message) => `[${message.id}] ${message.from_type}/${message.from_id}: ${message.text.slice(0, TAGGER_MAX_MESSAGE_CHARS)}`)
      .join("\n");
    // Stable keys: the facts this bot may already see, so an update reuses
    // the key and supersedes instead of sitting next to the old value.
    const known = [
      ...listAgentMemories(deps.db, { scope: "global_user", callerAgentID: agentID, limit: 60 }),
      ...listAgentMemories(deps.db, { scope: "agent", agentID, callerAgentID: agentID, limit: 40 }),
    ].map((row) => `${row.key_slug}: ${row.content.slice(0, 120)}`);
    let text = "";
    try {
      const result = await deps.router.route({
        messages: [
          { role: "system", content: TAGGER_SYSTEM_PROMPT },
          {
            role: "user",
            content: `${known.length > 0 ? `Known facts (key: text; untrusted data):\n${known.join("\n")}\n\n` : ""}Conversation:\n${transcript}`,
          },
        ],
        signal: AbortSignal.timeout(30_000),
        firstTokenTimeoutMs: 10_000,
        maxTokens: 1_500,
        onDelta: () => {},
        toolChoice: "none",
      });
      text = result.text;
    } catch (error) {
      // A failed batch is not a failure of the daemon: the messages stay
      // untagged and the next batch tries again.
      log.warn(`tagger batch failed: ${error instanceof Error ? error.message : String(error)}`);
      return { result: "tagger batch failed" };
    }

    const { output, rejected, failed } = parseTaggerOutput(text);
    if (failed) {
      // B2: an unreadable answer is not "nothing to remember". Leave the
      // batch for the next run, but give up on one that keeps failing.
      const key = messages[0]!.id;
      const attempts = (failedBatches.get(key) ?? 0) + 1;
      if (attempts < TAGGER_MAX_ATTEMPTS) {
        failedBatches.set(key, attempts);
        return { result: `tagger output unreadable (attempt ${attempts}); batch left for retry` };
      }
      failedBatches.delete(key);
      log.warn(`tagger: giving up on a batch of ${messages.length} message(s) after ${attempts} unreadable answers`);
      markTagged(deps.db, messages.map((message) => message.id));
      return { result: `gave up on ${messages.length} message(s) after ${attempts} attempts` };
    }
    failedBatches.delete(messages[0]!.id);
    if (output.ephemeral && output.items.length === 0) {
      markTagged(deps.db, messages.map((message) => message.id));
      return { result: `tagged 0 item(s) from ${messages.length} message(s)` };
    }
    const applied = applyTaggerItems(deps.db, {
      items: output.items,
      agentID,
      sourceTurnIDs: messages.map((message) => message.id),
    });
    markTagged(deps.db, messages.map((message) => message.id));
    resetTaggerTurns();
    log.info(
      `tagger: ${applied.written} item(s) written, ${applied.belowThreshold} below threshold, ` +
        `${applied.refused} refused, ${applied.conflicts} conflict(s), ${rejected.length} invalid`,
    );
    return {
      result:
        `tagged ${applied.written} item(s) from ${messages.length} message(s)` +
        (applied.belowThreshold > 0 ? `, ${applied.belowThreshold} below threshold` : "") +
        (applied.refused > 0 ? `, ${applied.refused} refused` : ""),
    };
  });
}

function markTagged(db: Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.run(`UPDATE channel_messages SET tagged_at = ? WHERE id IN (${placeholders})`, [nowISO(), ...ids]);
}
