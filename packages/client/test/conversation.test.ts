/**
 * The transcript reducer: what a person sees when frames arrive. These tests
 * are written against the frames the daemon really emits (see
 * packages/protocol/fixtures/frames.json).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { MessageInfo } from "@agni/protocol";
import {
  Conversation,
  isComplete,
  isFailed,
  isStreaming,
  isStopped,
  stopExplanation,
  type IncomingFrame,
} from "../src";

const fixtureURL = new URL("../../../packages/protocol/fixtures/frames.json", import.meta.url);

function fixtureFrame(type: string): IncomingFrame {
  const root = JSON.parse(readFileSync(fixtureURL, "utf8")) as { server: Array<Record<string, unknown>> };
  const object = root.server.find((frame) => frame.type === type);
  if (!object) throw new Error(`no ${type} fixture`);
  return object as unknown as IncomingFrame;
}

function wire(object: Record<string, unknown>): IncomingFrame {
  return object as unknown as IncomingFrame;
}

function tokenFrame(turnID: string, threadID: string, delta: string, seq = 100): IncomingFrame {
  return wire({ type: "token", seq, turnID, threadID, delta });
}

function startFrame(turnID: string, threadID: string, agentID = "agni", conversationID?: string): IncomingFrame {
  const object: Record<string, unknown> = {
    type: "turn.start",
    seq: 90,
    turnID,
    threadID,
    agentID,
  };
  if (conversationID) object.conversationID = conversationID;
  return wire(object);
}

function endFrame(
  turnID: string,
  threadID: string,
  reason: string,
  options: { usage?: Record<string, unknown>; conversationID?: string } = {},
): IncomingFrame {
  const object: Record<string, unknown> = {
    type: "turn.end",
    seq: 120,
    turnID,
    threadID,
    stopReason: reason,
  };
  if (options.usage) object.usage = options.usage;
  if (options.conversationID) object.conversationID = options.conversationID;
  return wire(object);
}

function errorFrame(code: string, message: string): IncomingFrame {
  return wire({ type: "error", seq: 110, code, message });
}

function sessionStart(sessionID: string, conversationID = "cnv_1", reason = "manual"): IncomingFrame {
  return wire({ type: "session.start", seq: 70, conversationID, sessionID, reason });
}

function info(partial: Partial<MessageInfo> & Pick<MessageInfo, "id" | "role" | "text">): MessageInfo {
  return {
    createdAt: "2026-10-16T12:00:00.000Z",
    ...partial,
  };
}

describe("transcript", () => {
  test("a turn streams into one bubble and closes with its usage", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_1", "thr_1"));
    expect(conversation.isStreaming).toBe(true);

    for (const delta of ["Call ", "the ", "plumber."]) {
      conversation.apply(tokenFrame("trn_1", "thr_1", delta));
    }
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.text).toBe("Call the plumber.");
    expect(isStreaming(conversation.messages[0]!)).toBe(true);

    const effects = conversation.apply(
      endFrame("trn_1", "thr_1", "end", {
        usage: {
          provider: "groq",
          model: "llama-3.1-8b-instant",
          latencyMs: 412,
          outputTokens: 24,
        },
      }),
    );
    expect(isComplete(conversation.messages[0]!)).toBe(true);
    expect(conversation.messages[0]?.usage?.latencyMs).toBe(412);
    expect(conversation.isStreaming).toBe(false);
    expect(effects).toContainEqual({ kind: "refreshThreadList" });
  });

  test("a progress update is its own bubble during a streamed turn", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_1", "thr_1"));
    conversation.apply(tokenFrame("trn_1", "thr_1", "Working on it."));
    conversation.apply(wire({
      type: "msg.new",
      seq: 95,
      id: "msg_progress",
      channelId: "main",
      fromType: "agent",
      fromId: "agni",
      senderName: "Agni",
      text: "Checking the installer first.",
      internal: false,
      uiHint: "progress",
      createdAt: "2026-10-21T03:00:00.000Z",
    }));

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      id: "msg_progress",
      text: "Checking the installer first.",
      uiHint: "progress",
    });
    expect(conversation.messages[1]?.text).toBe("Working on it.");
  });

  test("a cancelled turn says so and keeps the partial text", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_2", "thr_1"));
    conversation.apply(tokenFrame("trn_2", "thr_1", "half a thought"));
    conversation.apply(endFrame("trn_2", "thr_1", "cancelled"));

    expect(conversation.messages[0]?.text).toBe("half a thought");
    expect(isStopped(conversation.messages[0]!, "cancelled")).toBe(true);
    expect(stopExplanation(conversation.messages[0]!)).toBe("Stopped");
  });

  test("a turn that dies mid-provider keeps the reason the daemon gave", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_4", "thr_1"));
    conversation.apply(errorFrame("provider_failed", "no provider in tier instant"));

    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.text).toBe("");

    conversation.apply(endFrame("trn_4", "thr_1", "error"));
    expect(isFailed(conversation.messages[0]!, "no provider in tier instant")).toBe(true);
  });

  test("a failed turn short on reasons does not invent one", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_5", "thr_1"));
    conversation.apply(endFrame("trn_5", "thr_1", "error"));

    expect(isStopped(conversation.messages[0]!, "error")).toBe(true);
    expect(stopExplanation(conversation.messages[0]!)).toBe("Failed");
  });

  test("one turn's failure does not stain the next", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_6", "thr_1"));
    conversation.apply(errorFrame("provider_failed", "upstream 500"));
    conversation.apply(endFrame("trn_6", "thr_1", "error"));

    conversation.apply(startFrame("trn_7", "thr_1"));
    conversation.apply(tokenFrame("trn_7", "thr_1", "second time lucky"));
    conversation.apply(endFrame("trn_7", "thr_1", "end"));

    const last = conversation.messages[conversation.messages.length - 1]!;
    expect(last.text).toBe("second time lucky");
    expect(isComplete(last)).toBe(true);
  });

  test("local echo appears immediately and survives history reload", () => {
    const conversation = new Conversation("agni");
    const localID = conversation.appendLocalUserMessage("remind me at 5");
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.isLocalEcho).toBe(true);

    conversation.apply(startFrame("trn_3", "thr_9"));
    expect(conversation.threadID).toBe("thr_9");

    conversation.loadHistory("thr_9", "reminder", "agni", [
      info({
        id: "msg_1",
        role: "user",
        text: "remind me at 5",
        createdAt: "2026-10-16T11:59:58.000Z",
      }),
      info({
        id: "msg_2",
        role: "assistant",
        text: "Set for 17:00.",
        turnID: "trn_3",
      }),
    ]);
    expect(conversation.messages.length, "the durable copy replaces the echo, it does not duplicate it").toBe(2);
    expect(conversation.messages.map((message) => message.text)).toEqual(["remind me at 5", "Set for 17:00."]);
    expect(conversation.messages.every((message) => !message.isLocalEcho)).toBe(true);
    expect(localID.startsWith("local_")).toBe(true);
  });

  test("tool activity attaches to the reply it belongs to", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_4", "thr_1"));
    conversation.apply(fixtureFrame("tool.start"));
    conversation.apply(fixtureFrame("tool.update"));
    conversation.apply(fixtureFrame("tool.end"));

    const tools = conversation.messages[0]?.tools ?? [];
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("memory.search");
    expect(tools[0]?.state).toBe("ok");
    expect(tools[0]?.preview).toBe("3 matches");
  });

  test("approvals and forms are tracked until answered", () => {
    const conversation = new Conversation("agni", "thr_1");
    const approvalEffects = conversation.apply(fixtureFrame("approval.request"));
    expect(conversation.openApprovals.length).toBe(1);
    expect(conversation.openApprovals[0]?.decisions).toEqual(["once", "always", "reject"]);
    expect(approvalEffects).toContainEqual({
      kind: "notify",
      title: "Agni needs you",
      body: "shell: git push origin main",
      sound: true,
    });

    conversation.apply(fixtureFrame("form.request"));
    expect(conversation.openForms.length).toBe(1);
    expect(conversation.needsYou).toBe(true);

    conversation.resolveApproval("apr_01hq", "once");
    conversation.resolveForm("frm_01hq", "both");
    expect(conversation.openApprovals.length).toBe(0);
    expect(conversation.openForms.length).toBe(0);
    expect(conversation.needsYou).toBe(false);
  });

  test("messages for another thread become an unread mark, not a bubble", () => {
    const conversation = new Conversation("agni", "thr_1");
    const effects = conversation.apply(startFrame("trn_5", "thr_other"));
    expect(effects).toContainEqual({ kind: "unread", threadID: "thr_other" });
    expect(conversation.messages.length).toBe(0);
    expect(conversation.isStreaming).toBe(false);

    conversation.apply(tokenFrame("trn_5", "thr_other", "background noise"));
    expect(conversation.messages.length).toBe(0);
  });

  test("replayed deltas without their start still render", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(tokenFrame("trn_6", "thr_1", "resumed "));
    expect(conversation.messages.length).toBe(1);
    expect(isStreaming(conversation.messages[0]!)).toBe(true);
  });

  test("errors and notices land in the notice list", () => {
    const conversation = new Conversation("agni", "thr_1");
    const effects = conversation.apply(fixtureFrame("notify"));
    expect(conversation.notices.length).toBe(1);
    expect(effects).toContainEqual({
      kind: "notify",
      title: "Agni · standup in 10",
      body: "You asked to be nudged before the 09:30 standup.",
      sound: true,
      threadID: "thr_01hq",
    });

    const gap = wire({ type: "error", seq: 200, code: "resync_gap", message: "cannot replay from 1" });
    const gapEffects = conversation.apply(gap);
    expect(gapEffects).toContainEqual({ kind: "reloadDurableState" });
    expect(conversation.notices[conversation.notices.length - 1]?.kind).toBe("failure");
  });

  test("history reload keeps a stream that is still running", () => {
    const conversation = new Conversation("agni", "thr_1");
    conversation.apply(startFrame("trn_7", "thr_1"));
    conversation.apply(tokenFrame("trn_7", "thr_1", "still writing"));

    conversation.loadHistory("thr_1", null, "agni", [
      info({ id: "msg_9", role: "user", text: "an older question", createdAt: "2026-10-16T11:00:00.000Z" }),
    ]);
    expect(conversation.messages.length).toBe(2);
    expect(conversation.messages[1]?.text).toBe("still writing");
    expect(isStreaming(conversation.messages[1]!)).toBe(true);
  });
});

describe("session seams", () => {
  test("history across blocks keeps each message's block", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_block1");
    conversation.loadConversationHistory("cnv_1", "agni", [
      info({
        id: "msg_a",
        role: "user",
        text: "older block message",
        createdAt: "2026-10-16T11:00:00.000Z",
        sessionID: "thr_block1",
      }),
      info({
        id: "msg_b",
        role: "assistant",
        text: "newer block message",
        createdAt: "2026-10-16T12:00:00.000Z",
        turnID: "trn_a",
        sessionID: "thr_block2",
      }),
    ]);
    expect(conversation.messages.map((message) => message.sessionID)).toEqual(["thr_block1", "thr_block2"]);
  });

  test("a seam reroutes the next turn into the new block", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_block1");
    conversation.apply(sessionStart("thr_block2"));

    conversation.apply(startFrame("trn_x", "thr_block2", "agni", "cnv_1"));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.sessionID).toBe("thr_block2");
  });

  test("a local echo after the seam stamps the new block", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_block1");
    conversation.apply(sessionStart("thr_block2"));

    conversation.appendLocalUserMessage("after the fold");
    expect(conversation.messages[0]?.sessionID).toBe("thr_block2");
  });

  test("a background turn shared by conversation streams into the surface", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_active");

    const effects = conversation.apply(startFrame("trn_job", "thr_brief", "agni", "cnv_1"));
    expect(effects.length).toBe(0);

    conversation.apply(tokenFrame("trn_job", "thr_brief", "7:55: rain around noon."));
    expect(conversation.messages.length).toBe(1);
    expect(conversation.messages[0]?.sessionID).toBe("thr_brief");
    expect(conversation.isStreaming).toBe(true);

    conversation.apply(endFrame("trn_job", "thr_brief", "end", { conversationID: "cnv_1" }));
    expect(isComplete(conversation.messages[0]!)).toBe(true);
    expect(conversation.isStreaming).toBe(false);
  });

  test("turns of another conversation stay out", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", "thr_active");
    const effects = conversation.apply(startFrame("trn_other", "thr_other", "agni", "cnv_other"));
    expect(effects).toContainEqual({ kind: "unread", threadID: "thr_other" });
    expect(conversation.messages.length).toBe(0);
  });

  test("a seam pins the surface even when history carries no blocks", () => {
    const conversation = new Conversation("agni");
    conversation.bind("cnv_1", "agni", null);
    expect(conversation.threadID).toBeNull();
    conversation.apply(sessionStart("thr_first"));
    expect(conversation.threadID).toBe("thr_first");
  });
});
