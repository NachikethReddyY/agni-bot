/**
 * The rollover summary job (ROL-002, ROL-004, ROL-005).
 *
 * The block is closed and reopened immediately; the summary of the closed
 * block is written here, afterwards. A turn arriving in between is served
 * from the previous carry plus the tail of the old block — it never waits.
 *
 * The job is idempotent: the version is the closed block's creation time,
 * and the summary is only stored if it is newer than what the conversation
 * already has. Two rotations in quick succession therefore settle on the
 * newer summary, in whatever order the jobs finish.
 */
import type { Database } from "bun:sqlite";
import type { ServerFrameBody } from "@agni/protocol";
import type { Router } from "../models/router";
import { log } from "../log";
import { getThread } from "../stores/threads";
import { getConversation, updateSummaryIfNewer } from "../stores/conversations";
import { parseJobPayload, type JobRow } from "../stores/jobs";
import { summarizeBlock, type RolloverDeps } from "../agent/rollover";
import type { JobRunner } from "./runner";

export interface RolloverJobPayload {
  /** The block that was closed. */
  threadID: string;
  conversationID: string;
  /** The version this summary belongs to (the block's creation time). */
  version: number;
}

export interface RolloverJobDeps extends Omit<RolloverDeps, "db"> {
  db: Database;
  router: Router;
  emit: (frame: ServerFrameBody) => void;
}

export function registerRolloverJob(runner: JobRunner, deps: RolloverJobDeps): void {
  runner.register("rollover.summarize", async (job: JobRow) => {
    const payload = parseJobPayload<RolloverJobPayload>(job);
    const block = getThread(deps.db, payload.threadID);
    if (!block) return { result: "the block is gone" };
    const conversation = getConversation(deps.db, payload.conversationID);
    if (!conversation) return { result: "the conversation is gone" };
    // A newer summary already landed: this one is stale.
    if (conversation.summary_version >= payload.version) return { result: "a newer summary is already in" };

    const summary = await summarizeBlock(deps, conversation, block);
    if (!summary) return { result: "the summary failed; the previous one rides forward" };
    const stored = updateSummaryIfNewer(deps.db, conversation.id, {
      summary: summary.text,
      structured: summary.structured,
      version: payload.version,
    });
    log.info(
      `rollover: summarized block ${block.id} (${stored ? "stored" : "superseded by a newer summary"})`,
    );
    return { result: stored ? "summary stored" : "a newer summary was already in" };
  });
}
