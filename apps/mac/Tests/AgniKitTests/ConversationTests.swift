/**
 * The transcript reducer: what a person sees when frames arrive. These tests
 * are written against the frames the daemon really emits (see
 * packages/protocol/fixtures/frames.json).
 */
import Foundation
import Testing

@testable import AgniKit
@testable import AgniProtocol

/// Walk up from this file to the repo that holds the fixture set.
private func repoFixtureURL() -> URL {
  var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  for _ in 0..<8 {
    let candidate = directory.appendingPathComponent("packages/protocol/fixtures/frames.json")
    if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    directory = directory.deletingLastPathComponent()
  }
  return URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("packages/protocol/fixtures/frames.json")
}

private func frame(_ type: String) throws -> ServerFrame {
  let url = repoFixtureURL()
  let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
  let server = (root["server"] as? [[String: Any]]) ?? []
  guard let object = server.first(where: { $0["type"] as? String == type }) else {
    throw ProtocolError.decoding("no \(type) fixture")
  }
  return try ServerFrame(wire: object)
}

private func tokenFrame(turnID: String, threadID: String, delta: String, seq: Int = 100) throws -> ServerFrame {
  try ServerFrame(wire: ["type": "token", "seq": seq, "turnID": turnID, "threadID": threadID, "delta": delta])
}

private func startFrame(turnID: String, threadID: String, agentID: String = "agni") throws -> ServerFrame {
  try ServerFrame(wire: ["type": "turn.start", "seq": 90, "turnID": turnID, "threadID": threadID, "agentID": agentID])
}

private func endFrame(turnID: String, threadID: String, reason: String, usage: [String: Any]? = nil) throws -> ServerFrame {
  var object: [String: Any] = ["type": "turn.end", "seq": 120, "turnID": turnID, "threadID": threadID, "stopReason": reason]
  if let usage { object["usage"] = usage }
  return try ServerFrame(wire: object)
}

private func errorFrame(code: String, message: String) throws -> ServerFrame {
  try ServerFrame(wire: ["type": "error", "seq": 110, "code": code, "message": message])
}

private func msgNewFrame(
  id: String,
  text: String,
  uiHint: String? = nil,
  seq: Int = 95,
  createdAt: String = "2026-10-22T11:00:01.000Z"
) throws -> ServerFrame {
  var object: [String: Any] = [
    "type": "msg.new", "seq": seq, "id": id, "channelId": "main",
    "fromType": "agent", "fromId": "agni", "senderName": "Agni",
    "text": text, "internal": false, "createdAt": createdAt,
  ]
  if let uiHint { object["uiHint"] = uiHint }
  return try ServerFrame(wire: object)
}

@Suite("transcript")
struct TranscriptTests {
  @Test func aTurnStreamsIntoOneBubbleAndClosesWithItsUsage() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_1", threadID: "thr_1"))
    #expect(conversation.isStreaming)

    for delta in ["Call ", "the ", "plumber."] {
      _ = conversation.apply(try tokenFrame(turnID: "trn_1", threadID: "thr_1", delta: delta))
    }
    #expect(conversation.messages.count == 1)
    #expect(conversation.messages[0].text == "Call the plumber.")
    #expect(conversation.messages[0].isStreaming)

    let effects = conversation.apply(
      try endFrame(
        turnID: "trn_1",
        threadID: "thr_1",
        reason: "end",
        usage: ["provider": "groq", "model": "llama-3.1-8b-instant", "latencyMs": 412, "outputTokens": 24]
      )
    )
    #expect(conversation.messages[0].state == .complete)
    #expect(conversation.messages[0].usage?.latencyMs == 412)
    #expect(conversation.isStreaming == false)
    #expect(effects.contains(.refreshThreadList))
  }

  @Test func eachStepIsSealedAsItsOwnBubble() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_steps", threadID: "thr_1"))
    _ = conversation.apply(try tokenFrame(turnID: "trn_steps", threadID: "thr_1", delta: "Checking."))
    _ = conversation.apply(try msgNewFrame(id: "msg_step1", text: "Checking."))
    _ = conversation.apply(try tokenFrame(turnID: "trn_steps", threadID: "thr_1", delta: "All set.", seq: 96))
    _ = conversation.apply(try msgNewFrame(
      id: "msg_step2", text: "All set.", seq: 97, createdAt: "2026-10-22T11:00:02.000Z"
    ))
    _ = conversation.apply(try endFrame(turnID: "trn_steps", threadID: "thr_1", reason: "end"))

    #expect(conversation.messages.map(\.id) == ["msg_step1", "msg_step2"])
    #expect(conversation.messages.map(\.text) == ["Checking.", "All set."])
    #expect(conversation.messages.allSatisfy { $0.state == .complete })
    #expect(conversation.isStreaming == false)
  }

  @Test func aCancelledTurnMarksItsSealedAnswerStopped() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_half", threadID: "thr_1"))
    _ = conversation.apply(try tokenFrame(turnID: "trn_half", threadID: "thr_1", delta: "half a thought"))
    _ = conversation.apply(try msgNewFrame(id: "msg_half", text: "half a thought"))
    _ = conversation.apply(try endFrame(turnID: "trn_half", threadID: "thr_1", reason: "cancelled"))

    #expect(conversation.messages.count == 1)
    #expect(conversation.messages[0].state == .stopped(.cancelled))
  }

  @Test func aCancelledTurnSaysSoAndKeepsThePartialText() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_2", threadID: "thr_1"))
    _ = conversation.apply(try tokenFrame(turnID: "trn_2", threadID: "thr_1", delta: "half a thought"))
    _ = conversation.apply(try endFrame(turnID: "trn_2", threadID: "thr_1", reason: "cancelled"))

    #expect(conversation.messages[0].text == "half a thought")
    #expect(conversation.messages[0].state == .stopped(.cancelled))
    #expect(conversation.messages[0].stopExplanation == "Stopped")
  }

  @Test func aTurnThatDiesMidProviderKeepsTheReasonTheDaemonGave() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_4", threadID: "thr_1"))
    _ = conversation.apply(try errorFrame(code: "provider_failed", message: "no provider in tier instant"))

    // Nothing streamed, but the bubble exists so the gap can account for itself.
    #expect(conversation.messages.count == 1)
    #expect(conversation.messages[0].text.isEmpty)

    _ = conversation.apply(try endFrame(turnID: "trn_4", threadID: "thr_1", reason: "error"))
    #expect(conversation.messages[0].state == .failed("no provider in tier instant"))
  }

  @Test func aFailedTurnShortOnReasonsDoesNotInventOne() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_5", threadID: "thr_1"))
    _ = conversation.apply(try endFrame(turnID: "trn_5", threadID: "thr_1", reason: "error"))

    #expect(conversation.messages[0].state == .stopped(.error))
    #expect(conversation.messages[0].stopExplanation == "Failed")
  }

  @Test func oneTurnsFailureDoesNotStainTheNext() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_6", threadID: "thr_1"))
    _ = conversation.apply(try errorFrame(code: "provider_failed", message: "upstream 500"))
    _ = conversation.apply(try endFrame(turnID: "trn_6", threadID: "thr_1", reason: "error"))

    _ = conversation.apply(try startFrame(turnID: "trn_7", threadID: "thr_1"))
    _ = conversation.apply(try tokenFrame(turnID: "trn_7", threadID: "thr_1", delta: "second time lucky"))
    _ = conversation.apply(try endFrame(turnID: "trn_7", threadID: "thr_1", reason: "end"))

    let last = conversation.messages[conversation.messages.count - 1]
    #expect(last.text == "second time lucky")
    #expect(last.state == .complete)
  }

  @Test func localEchoAppearsImmediatelyAndSurvivesHistoryReload() throws {
    var conversation = Conversation(agentID: "agni")
    let localID = conversation.appendLocalUserMessage(text: "remind me at 5")
    #expect(conversation.messages.count == 1)
    #expect(conversation.messages[0].isLocalEcho)

    // A new thread: turn.start is what tells us the server's thread id.
    _ = conversation.apply(try startFrame(turnID: "trn_3", threadID: "thr_9"))
    #expect(conversation.threadID == "thr_9")

    conversation.loadHistory(
      threadID: "thr_9",
      title: "reminder",
      agentID: "agni",
      messages: [
        MessageInfo(id: "msg_1", role: "user", text: "remind me at 5", createdAt: "2026-10-16T11:59:58.000Z", turnID: nil),
        MessageInfo(id: "msg_2", role: "assistant", text: "Set for 17:00.", createdAt: "2026-10-16T12:00:00.000Z", turnID: "trn_3"),
      ]
    )
    #expect(conversation.messages.count == 2, "the durable copy replaces the echo, it does not duplicate it")
    #expect(conversation.messages.map(\.text) == ["remind me at 5", "Set for 17:00."])
    #expect(conversation.messages.allSatisfy { !$0.isLocalEcho })
    _ = localID
  }

  @Test func toolActivityAttachesToTheReplyItBelongsTo() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_4", threadID: "thr_1"))
    _ = conversation.apply(try frame("tool.start"))
    _ = conversation.apply(try frame("tool.update"))
    _ = conversation.apply(try frame("tool.end"))

    let tools = conversation.messages[0].tools
    #expect(tools.count == 1)
    #expect(tools[0].name == "memory.search")
    #expect(tools[0].state == .ok)
    #expect(tools[0].preview == "3 matches")
  }

  @Test func approvalsAndFormsAreTrackedUntilAnswered() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    let approvalEffects = conversation.apply(try frame("approval.request"))
    #expect(conversation.openApprovals.count == 1)
    #expect(conversation.openApprovals[0].decisions == [.once, .always, .reject])
    #expect(approvalEffects.contains(.notify(title: "Agni needs you", body: "shell: git push origin main", sound: true)))

    _ = conversation.apply(try frame("form.request"))
    #expect(conversation.openForms.count == 1)
    #expect(conversation.needsYou)

    conversation.resolveApproval(id: "apr_01hq", decision: .once)
    conversation.resolveForm(id: "frm_01hq", answer: "both")
    #expect(conversation.openApprovals.isEmpty)
    #expect(conversation.openForms.isEmpty)
    #expect(conversation.needsYou == false)
  }

  @Test func messagesForAnotherThreadBecomeAnUnreadMarkNotABubble() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    let effects = conversation.apply(try startFrame(turnID: "trn_5", threadID: "thr_other"))
    #expect(effects.contains(.unread(threadID: "thr_other")))
    #expect(conversation.messages.isEmpty)
    #expect(conversation.isStreaming == false)

    _ = conversation.apply(try tokenFrame(turnID: "trn_5", threadID: "thr_other", delta: "background noise"))
    #expect(conversation.messages.isEmpty)
  }

  @Test func replayedDeltasWithoutTheirStartStillRender() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try tokenFrame(turnID: "trn_6", threadID: "thr_1", delta: "resumed "))
    #expect(conversation.messages.count == 1)
    #expect(conversation.messages[0].isStreaming)
  }

  @Test func errorsAndNoticesLandInTheNoticeList() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    let effects = conversation.apply(try frame("notify"))
    #expect(conversation.notices.count == 1)
    #expect(effects.contains(.notify(title: "Agni · standup in 10", body: "You asked to be nudged before the 09:30 standup.", sound: true, threadID: "thr_01hq")))

    let gap = try ServerFrame(wire: ["type": "error", "seq": 200, "code": "resync_gap", "message": "cannot replay from 1"])
    let gapEffects = conversation.apply(gap)
    #expect(gapEffects.contains(.reloadDurableState))
    #expect(conversation.notices.last?.kind == .failure)
  }

  @Test func historyReloadKeepsAStreamThatIsStillRunning() throws {
    var conversation = Conversation(agentID: "agni", threadID: "thr_1")
    _ = conversation.apply(try startFrame(turnID: "trn_7", threadID: "thr_1"))
    _ = conversation.apply(try tokenFrame(turnID: "trn_7", threadID: "thr_1", delta: "still writing"))

    conversation.loadHistory(
      threadID: "thr_1",
      title: nil,
      agentID: "agni",
      messages: [MessageInfo(id: "msg_9", role: "user", text: "an older question", createdAt: "2026-10-16T11:00:00.000Z", turnID: nil)]
    )
    #expect(conversation.messages.count == 2)
    #expect(conversation.messages[1].text == "still writing")
    #expect(conversation.messages[1].isStreaming)
  }
}

@Suite("session seams")
struct SessionSeamTests {
  private func sessionStart(sessionID: String, conversationID: String = "cnv_1", reason: String = "manual") throws -> ServerFrame {
    try ServerFrame(wire: [
      "type": "session.start", "seq": 70, "conversationID": conversationID, "sessionID": sessionID, "reason": reason,
    ])
  }

  private func startFrameFor(turnID: String, threadID: String, conversationID: String?, seq: Int = 90) throws -> ServerFrame {
    var object: [String: Any] = [
      "type": "turn.start", "seq": seq, "turnID": turnID, "threadID": threadID, "agentID": "agni",
    ]
    if let conversationID { object["conversationID"] = conversationID }
    return try ServerFrame(wire: object)
  }

  private func endFrameFor(turnID: String, threadID: String, conversationID: String? = "cnv_1") throws -> ServerFrame {
    var object: [String: Any] = [
      "type": "turn.end", "seq": 120, "turnID": turnID, "threadID": threadID, "stopReason": "end",
    ]
    if let conversationID { object["conversationID"] = conversationID }
    return try ServerFrame(wire: object)
  }

  @Test func historyAcrossBlocksKeepsEachMessagesBlock() throws {
    var conversation = Conversation(agentID: "agni")
    conversation.bind(conversationID: "cnv_1", agentID: "agni", sessionID: "thr_block1")
    conversation.loadConversationHistory(
      conversationID: "cnv_1",
      agentID: "agni",
      messages: [
        MessageInfo(
          id: "msg_a", role: "user", text: "older block message", createdAt: "2026-10-16T11:00:00.000Z",
          turnID: nil, sessionID: "thr_block1"
        ),
        MessageInfo(
          id: "msg_b", role: "assistant", text: "newer block message", createdAt: "2026-10-16T12:00:00.000Z",
          turnID: "trn_a", sessionID: "thr_block2"
        ),
      ]
    )
    #expect(conversation.messages.map(\.sessionID) == ["thr_block1", "thr_block2"], "the view derives the seam from differing block ids")
  }

  @Test func aSeamReroutesTheNextTurnIntoTheNewBlock() throws {
    var conversation = Conversation(agentID: "agni")
    conversation.bind(conversationID: "cnv_1", agentID: "agni", sessionID: "thr_block1")
    _ = conversation.apply(try sessionStart(sessionID: "thr_block2"))

    _ = conversation.apply(try startFrameFor(turnID: "trn_x", threadID: "thr_block2", conversationID: "cnv_1"))
    #expect(conversation.messages.count == 1)
    #expect(conversation.messages[0].sessionID == "thr_block2", "the seam shows once the new block's first message lands")
  }

  @Test func aLocalEchoAfterTheSeamStampsTheNewBlock() throws {
    var conversation = Conversation(agentID: "agni")
    conversation.bind(conversationID: "cnv_1", agentID: "agni", sessionID: "thr_block1")
    _ = conversation.apply(try sessionStart(sessionID: "thr_block2"))

    _ = conversation.appendLocalUserMessage(text: "after the fold")
    #expect(conversation.messages[0].sessionID == "thr_block2")
  }

  @Test func aBackgroundTurnSharedByConversationStreamsIntoTheSurface() throws {
    var conversation = Conversation(agentID: "agni")
    conversation.bind(conversationID: "cnv_1", agentID: "agni", sessionID: "thr_active")

    // The brief runs in its own born-closed block, but turn.start binds it by
    // conversationID — its tokens carry only the block id.
    let effects = conversation.apply(try startFrameFor(turnID: "trn_job", threadID: "thr_brief", conversationID: "cnv_1"))
    #expect(effects.isEmpty)

    _ = conversation.apply(try tokenFrame(turnID: "trn_job", threadID: "thr_brief", delta: "7:55: rain around noon."))
    #expect(conversation.messages.count == 1, "the brief lands in the one surface")
    #expect(conversation.messages[0].sessionID == "thr_brief", "its own block, so a divider renders")
    #expect(conversation.isStreaming)

    _ = conversation.apply(try endFrameFor(turnID: "trn_job", threadID: "thr_brief"))
    #expect(conversation.messages[0].state == .complete)
    #expect(conversation.isStreaming == false)
  }

  @Test func turnsOfAnotherConversationStayOut() throws {
    var conversation = Conversation(agentID: "agni")
    conversation.bind(conversationID: "cnv_1", agentID: "agni", sessionID: "thr_active")
    let effects = conversation.apply(try startFrameFor(turnID: "trn_other", threadID: "thr_other", conversationID: "cnv_other"))
    #expect(effects.contains(.unread(threadID: "thr_other")))
    #expect(conversation.messages.isEmpty)
  }

  @Test func aSeamPinsTheSurfaceEvenWhenHistoryCarriesNoBlocks() throws {
    var conversation = Conversation(agentID: "agni")
    conversation.bind(conversationID: "cnv_1", agentID: "agni", sessionID: nil)

    // Server answers conversation.open before the first block exists.
    #expect(conversation.threadID == nil)
    _ = conversation.apply(try sessionStart(sessionID: "thr_first", reason: "manual"))
    #expect(conversation.threadID == "thr_first")
  }
}


@Suite("formatting")
struct FormatTests {
  @Test func cadenceReadsLikeAPersonWroteIt() {
    let noon = AgniFormat.parseISO("2026-10-16T12:00:00.000Z")
    #expect(AgniFormat.cadence(everyMs: 60_000, runAt: noon) == "Every 1 minute")
    #expect(AgniFormat.cadence(everyMs: 300_000, runAt: noon) == "Every 5 minutes")
    #expect(AgniFormat.cadence(everyMs: 3_600_000, runAt: noon).hasPrefix("Every 1 hour"))
    #expect(AgniFormat.cadence(everyMs: nil, runAt: nil) == "Once")
  }

  @Test func machineValuesStayCompact() {
    #expect(AgniFormat.latency(412) == "412 ms")
    #expect(AgniFormat.latency(2400) == "2.4 s")
    #expect(AgniFormat.tokens(940) == "940")
    #expect(AgniFormat.tokens(12_400) == "12.4k")
    #expect(AgniFormat.uptime(3_600_000 + 720_000) == "1h 12m")
    #expect(AgniFormat.count(1, "turn") == "1 turn")
    #expect(AgniFormat.count(3, "turn") == "3 turns")
  }

  @Test func previewCollapsesWhitespace() {
    #expect(AgniFormat.preview("line one\n\n  line two") == "line one line two")
    #expect(AgniFormat.preview(String(repeating: "x", count: 200), limit: 10).hasSuffix("…"))
  }

  @Test func serverAddressesAreAcceptedInTheFormsPeopleType() {
    #expect(ServerSettings(url: "127.0.0.1:8787", deviceName: "Mac").websocketURL?.absoluteString == "ws://127.0.0.1:8787/ws")
    #expect(ServerSettings(url: "http://100.64.1.7:8787", deviceName: "Mac").websocketURL?.absoluteString == "ws://100.64.1.7:8787/ws")
    #expect(ServerSettings(url: "wss://agni.example/ws", deviceName: "Mac").websocketURL?.absoluteString == "wss://agni.example/ws")
    #expect(ServerSettings(url: "100.64.1.7", deviceName: "Mac").websocketURL?.absoluteString == "ws://100.64.1.7:8787/ws")
    #expect(ServerSettings(url: "", deviceName: "Mac").websocketURL == nil)
  }
}
