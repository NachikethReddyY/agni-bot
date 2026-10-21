/**
 * The conversation a person is looking at: messages, tool activity, approvals,
 * notices, and the in-flight turn. Pure value type — every frame the socket
 * delivers folds in here, so the reducer is testable without a socket or a
 * window, and the views stay dumb.
 */
import Foundation
import AgniProtocol

public struct ToolActivity: Identifiable, Sendable, Equatable {
  public enum State: Sendable, Equatable {
    case running
    case ok
    case failed
  }

  public var id: String
  public var name: String
  public var preview: String?
  public var state: State

  public init(id: String, name: String, preview: String? = nil, state: State = .running) {
    self.id = id
    self.name = name
    self.preview = preview
    self.state = state
  }
}

public struct ChatMessage: Identifiable, Sendable, Equatable {
  public enum Role: String, Sendable, Equatable {
    case user
    case assistant
    case system
  }

  public enum State: Sendable, Equatable {
    case complete
    case streaming
    case stopped(StopReason)
    case failed(String)
  }

  public var id: String
  public var role: Role
  public var text: String
  public var createdAt: Date?
  public var turnID: String?
  public var agentID: String?
  /// The session block this message lives in — the seam key used to render
  /// session dividers. nil for messages minted before the conversation model.
  public var sessionID: String?
  public var state: State
  public var usage: Usage?
  public var tools: [ToolActivity]
  /// Shown immediately, before the server confirms the turn.
  public var isLocalEcho: Bool
  public var senderName: String?
  public var senderColor: String?
  public var uiHint: String?

  public init(
    id: String,
    role: Role,
    text: String,
    createdAt: Date? = nil,
    turnID: String? = nil,
    agentID: String? = nil,
    sessionID: String? = nil,
    state: State = .complete,
    usage: Usage? = nil,
    tools: [ToolActivity] = [],
    isLocalEcho: Bool = false,
    senderName: String? = nil,
    senderColor: String? = nil,
    uiHint: String? = nil
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.createdAt = createdAt
    self.turnID = turnID
    self.agentID = agentID
    self.sessionID = sessionID
    self.state = state
    self.usage = usage
    self.tools = tools
    self.isLocalEcho = isLocalEcho
    self.senderName = senderName
    self.senderColor = senderColor
    self.uiHint = uiHint
  }

  public var isStreaming: Bool { state == .streaming }

  /// The quiet line under a reply that did not end cleanly.
  public var stopExplanation: String? {
    switch state {
    case .complete, .streaming: nil
    case .stopped(let reason): reason.explanation
    case .failed(let reason): reason
    }
  }
}

public struct ApprovalRow: Identifiable, Sendable, Equatable {
  public var id: String
  public var action: String
  public var preview: String
  public var decisions: [Decision]
  public var decision: Decision?
  public var isLocal: Bool

  public init(id: String, action: String, preview: String, decisions: [Decision], decision: Decision? = nil, isLocal: Bool = false) {
    self.id = id
    self.action = action
    self.preview = preview
    self.decisions = decisions
    self.decision = decision
    self.isLocal = isLocal
  }
}

public struct FormRow: Identifiable, Sendable, Equatable {
  public var id: String
  public var question: String
  public var options: [String]
  public var answer: String?
}

public struct NoticeRow: Identifiable, Sendable, Equatable {
  public enum Kind: Sendable, Equatable {
    case info
    case reminder
    case failure
  }

  public var id: String
  public var kind: Kind
  public var title: String
  public var body: String
  public var createdAt: Date
  public var threadID: String?

  public init(
    id: String,
    kind: Kind,
    title: String,
    body: String,
    createdAt: Date,
    threadID: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.title = title
    self.body = body
    self.createdAt = createdAt
    self.threadID = threadID
  }
}

/// What the UI or the app model should do after a frame landed.
public enum ConversationEffect: Sendable, Equatable {
  case refreshThreadList
  case reloadDurableState
  case notify(title: String, body: String, sound: Bool, threadID: String? = nil)
  case focusComposer
  case unread(threadID: String)
  case agentsChanged([AgentInfo])
  case presence(Bool)
}

public struct Conversation: Sendable, Equatable {
  /// The open conversation surface (v2): one per agent, never moved.
  public var conversationID: String?
  /// The active session block inside that conversation — where our sends land.
  public var threadID: String?
  public var title: String?
  public var agentID: String
  public var messages: [ChatMessage] = []
  public var approvals: [ApprovalRow] = []
  public var forms: [FormRow] = []
  public var notices: [NoticeRow] = []
  /// Failure text by turn, so a turn that dies explains itself in place.
  private var failures: [String: String] = [:]
  /// The turn currently streaming into this thread, if any.
  public var inFlightTurnID: String?
  public var inFlightThreadID: String?
  /// Turns whose start bound them into this conversation by conversationID;
  /// their tokens carry only a block id, so attribution survives the seam
  /// (a background brief streams into its own block — still this surface).
  private var adoptedTurns: Set<String> = []

  private static let noticeCap = 40
  private static let previewCap = 180

  public init(agentID: String, threadID: String? = nil) {
    self.agentID = agentID
    self.threadID = threadID
  }

  public var isStreaming: Bool { inFlightTurnID != nil }

  /// Replies that are still waiting for an answer, newest last.
  public var openApprovals: [ApprovalRow] { approvals.filter { $0.decision == nil } }
  public var openForms: [FormRow] { forms.filter { $0.answer == nil } }
  public var needsYou: Bool { !openApprovals.isEmpty || !openForms.isEmpty }

  public var streamingMessageID: String? {
    guard let turnID = inFlightTurnID else { return nil }
    return Self.assistantID(turnID: turnID)
  }

  static func assistantID(turnID: String) -> String { "asst_\(turnID)" }

  // MARK: intent from the UI

  /// Local echo: the bubble appears before the socket answers (S6). It belongs
  /// to the conversation's active block — the block our next send lands in.
  @discardableResult
  public mutating func appendLocalUserMessage(text: String, at date: Date = Date()) -> String {
    let id = "local_\(UUID().uuidString)"
    messages.append(
      ChatMessage(id: id, role: .user, text: text, createdAt: date, sessionID: threadID, isLocalEcho: true)
    )
    return id
  }

  public mutating func markLocalFailure(id: String, reason: String) {
    guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
    messages[index].state = .failed(reason)
  }

  public mutating func resolveApproval(id: String, decision: Decision) {
    guard let index = approvals.firstIndex(where: { $0.id == id }) else { return }
    approvals[index].decision = decision
  }

  public mutating func resolveForm(id: String, answer: String) {
    guard let index = forms.firstIndex(where: { $0.id == id }) else { return }
    forms[index].answer = answer
  }

  public mutating func note(_ notice: NoticeRow) {
    notices.append(notice)
    if notices.count > Self.noticeCap { notices.removeFirst(notices.count - Self.noticeCap) }
  }

  public mutating func dismissNotices() { notices.removeAll() }

  /// Point the transcript at a thread (or at "the next new thread" when nil).
  public mutating func watch(threadID: String?, title: String? = nil, agentID: String? = nil) {
    self.threadID = threadID
    self.title = title
    if let agentID { self.agentID = agentID }
    inFlightTurnID = nil
    inFlightThreadID = nil
    messages = []
  }

  /// Bind the transcript to the one conversation surface (v2). This is where
  /// the app lives from connect to forget-device; `sessionID` "" means the
  /// conversation has no blocks yet.
  public mutating func bind(conversationID: String, agentID: String?, sessionID: String?) {
    self.conversationID = conversationID
    if let agentID { self.agentID = agentID }
    threadID = sessionID?.isEmpty == false ? sessionID : nil
    title = nil
    inFlightTurnID = nil
    inFlightThreadID = nil
    adoptedTurns.removeAll()
  }

  /// A session block boundary arrived: everything after this lands in the new
  /// block. The seam itself shows up as a divider once the new block's first
  /// message exists.
  public mutating func startSession(sessionID: String, conversationID: String? = nil) {
    self.threadID = sessionID
    if let conversationID { self.conversationID = conversationID }
  }

  // MARK: durable state

  public mutating func loadHistory(threadID: String, title: String?, agentID: String?, messages incoming: [MessageInfo]) {
    self.threadID = threadID
    if let title { self.title = title }
    if let agentID { self.agentID = agentID }
    replaceDurable(incoming)
  }

  /// The conversation transcript across session blocks (v2). The block id per
  /// message is the divider key; the red herring title is not part of a surface.
  public mutating func loadConversationHistory(conversationID: String, agentID: String?, messages incoming: [MessageInfo]) {
    self.conversationID = conversationID
    if let agentID { self.agentID = agentID }
    replaceDurable(incoming)
  }

  /// Rebuild from the server's copy. Anything still streaming or echoed lives
  /// only in this process: keep it. Keep a partial answer that has content, but
  /// discard an empty streaming placeholder when durable history arrives
  /// before the first token.
  private mutating func replaceDurable(_ incoming: [MessageInfo]) {
    var rebuilt: [ChatMessage] = incoming.map { info in
      ChatMessage(
        id: info.id,
        role: ChatMessage.Role(rawValue: info.role) ?? .system,
        text: info.text,
        createdAt: AgniFormat.parseISO(info.createdAt),
        turnID: info.turnID,
        sessionID: info.sessionID,
        senderName: info.senderName,
        senderColor: info.senderColor,
        uiHint: info.uiHint
      )
    }

    let streaming = messages.filter { $0.isStreaming && !$0.text.isEmpty }
    let echoes = messages.filter { $0.isLocalEcho && $0.state != .failed("") }
    rebuilt.append(contentsOf: streaming)
    for echo in echoes where !rebuilt.contains(where: { $0.role == .user && $0.text == echo.text }) {
      rebuilt.append(echo)
    }
    // Survivors predate the blocks they stream into; stamp them with the
    // active block so a seam renders the instant history reloads.
    for index in rebuilt.indices where rebuilt[index].sessionID == nil {
      rebuilt[index].sessionID = threadID
    }
    messages = rebuilt
  }

  // MARK: frames

  public mutating func apply(_ frame: ServerFrame) -> [ConversationEffect] {
    switch frame {
    case .helloOK, .conversationOK, .conversationHistoryOK, .threadExportOK, .threadListOK, .threadHistoryOK,
      .jobListOK, .taskListOK, .taskUpdateOK, .memoryListOK, .providerAddOK, .providerModelsOK,
      .pluginListOK, .pluginConnectOK, .pluginState, .unknown:
      return []

    case .presence(let presence):
      return [.presence(presence.isOnline)]

    case .agentPresence:
      // The agent's own state is the app's business, not the conversation's.
      return []

    case .agentsUpdate(let update):
      return [.agentsChanged(update.agents)]

    case .statusUpdate:
      return []

    case .msgNew(let incoming):
      let role: ChatMessage.Role = incoming.fromType == "user" ? .user : (incoming.fromType == "system" ? .system : .assistant)
      if messages.contains(where: { $0.id == incoming.id }) { return [] }
      if role == .user, let index = messages.firstIndex(where: { $0.isLocalEcho && $0.text == incoming.text }) {
        messages[index].id = incoming.id
        messages[index].isLocalEcho = false
        messages[index].senderName = incoming.senderName
        return []
      }
      if role == .assistant, let index = messages.firstIndex(where: { $0.id == Self.assistantID(turnID: inFlightTurnID ?? "") && $0.isStreaming }) {
        messages[index].senderName = incoming.senderName
        messages[index].senderColor = incoming.senderColor
        messages[index].uiHint = incoming.uiHint
        return []
      }
      messages.append(ChatMessage(
        id: incoming.id, role: role, text: incoming.text, createdAt: ISO8601DateFormatter().date(from: incoming.createdAt),
        agentID: role == .assistant ? incoming.fromId : nil, state: .complete,
        senderName: incoming.senderName, senderColor: incoming.senderColor, uiHint: incoming.uiHint
      ))
      return []

    case .agentUpdated(let updated):
      for index in messages.indices where messages[index].uiHint == "onboarding_name_prompt" {
        messages[index].uiHint = "onboarding_completed"
        messages[index].senderName = updated.displayName
      }
      return []

    case .sessionStart(let seam):
      startSession(sessionID: seam.sessionID, conversationID: seam.conversationID)
      return []

    case .turnStart(let start):
      let isOurs = belongsTo(threadID: start.threadID, conversationID: start.conversationID)
      guard isOurs else { return [.unread(threadID: start.threadID), .refreshThreadList] }
      if start.conversationID != nil || threadID == start.threadID {
        adoptedTurns.insert(start.turnID)
      }
      adopt(threadID: start.threadID)
      inFlightTurnID = start.turnID
      inFlightThreadID = start.threadID
      let id = Self.assistantID(turnID: start.turnID)
      if let index = messages.firstIndex(where: { $0.id == id }) {
        messages[index].state = .streaming
        if messages[index].sessionID == nil { messages[index].sessionID = start.threadID }
      } else {
        messages.append(
          ChatMessage(
            id: id, role: .assistant, text: "", createdAt: Date(), turnID: start.turnID,
            agentID: start.agentID, sessionID: start.threadID, state: .streaming
          )
        )
      }
      return []

    case .token(let token):
      let adopted = adoptedTurns.contains(token.turnID)
      guard belongsTo(threadID: token.threadID, conversationID: nil) || adopted else { return [] }
      let id = Self.assistantID(turnID: token.turnID)
      if let index = messages.firstIndex(where: { $0.id == id }) {
        messages[index].text += token.delta
      } else {
        // Replayed deltas without their turn.start: rebuild the bubble.
        inFlightTurnID = token.turnID
        inFlightThreadID = token.threadID
        messages.append(
          ChatMessage(
            id: id, role: .assistant, text: token.delta, createdAt: Date(), turnID: token.turnID,
            agentID: agentID, sessionID: token.threadID, state: .streaming
          )
        )
      }
      return []

    case .turnEnd(let end):
      let adopted = adoptedTurns.remove(end.turnID) != nil
      let isOurs = adopted || belongsTo(threadID: end.threadID, conversationID: end.conversationID)
        || inFlightTurnID == end.turnID
      let id = Self.assistantID(turnID: end.turnID)
      if let index = messages.firstIndex(where: { $0.id == id }) {
        // A turn that ended badly keeps the daemon's own explanation when one
        // arrived while it was running. "Failed" is not an answer to "why did
        // nothing come back"; the provider's message is.
        if end.reason == .end {
          messages[index].state = .complete
        } else if let reason = failures.removeValue(forKey: end.turnID) {
          messages[index].state = .failed(reason)
        } else {
          messages[index].state = .stopped(end.reason)
        }
        messages[index].usage = end.usage
      }
      failures[end.turnID] = nil
      guard isOurs else { return [.unread(threadID: end.threadID), .refreshThreadList] }
      if inFlightTurnID == end.turnID {
        inFlightTurnID = nil
        inFlightThreadID = nil
      }
      return [.refreshThreadList]

    case .toolStart(let tool):
      attach(tool: ToolActivity(id: tool.callID, name: tool.name, preview: tool.preview, state: .running))
      return []

    case .toolUpdate(let tool):
      updateTool(callID: tool.callID) { activity in activity.preview = tool.preview }
      return []

    case .toolEnd(let tool):
      updateTool(callID: tool.callID) { activity in
        activity.state = tool.ok ? .ok : .failed
        if let preview = tool.preview { activity.preview = preview }
      }
      return []

    case .approvalRequest(let approval):
      approvals.removeAll { $0.id == approval.requestID }
      approvals.append(
        ApprovalRow(
          id: approval.requestID,
          action: approval.action,
          preview: approval.preview,
          decisions: approval.decisions
        )
      )
      return [
        .notify(title: "Agni needs you", body: approval.action, sound: true),
        .refreshThreadList,
      ]

    case .formRequest(let form):
      forms.removeAll { $0.id == form.requestID }
      forms.append(FormRow(id: form.requestID, question: form.question, options: form.options ?? [], answer: nil))
      return [.notify(title: "Agni asked a question", body: form.question, sound: false), .focusComposer]

    case .notify(let reminder):
      note(
        NoticeRow(
          id: "note_\(reminder.seq)",
          kind: .reminder,
          title: reminder.title,
          body: reminder.body,
          createdAt: Date()
        )
      )
      return [.notify(title: reminder.title, body: reminder.body, sound: reminder.sound ?? false, threadID: reminder.threadID)]

    case .error(let error):
      // A failure that happens mid-turn is the reason that turn will produce
      // nothing. Hold onto the daemon's own words so the empty row can explain
      // itself instead of just saying the turn failed.
      if let turnID = inFlightTurnID { failures[turnID] = error.message }
      note(
        NoticeRow(
          id: "err_\(error.seq)",
          kind: .failure,
          title: error.code,
          body: error.message,
          createdAt: Date(),
          threadID: threadID
        )
      )
      if error.code == "resync_gap" {
        return [.reloadDurableState]
      }
      if inFlightTurnID != nil, error.code == "no_provider" || error.code == "provider_failed" {
        // The turn runner will end the turn too; keep the partial text honest.
        return []
      }
      return []
    }
  }

  // MARK: helpers

  /// A frame belongs to this surface when its conversation is the bound one,
  /// or — legacy lane — when it is for the open block, or for the block being
  /// created by our own send (`threadID == nil`).
  private func belongsTo(threadID other: String, conversationID otherConversation: String?) -> Bool {
    if let otherConversation { return otherConversation == self.conversationID }
    if let mine = threadID { return mine == other }
    return true
  }

  private mutating func adopt(threadID: String) {
    guard self.threadID == nil else { return }
    self.threadID = threadID
  }

  private mutating func attach(tool: ToolActivity) {
    if let index = streamingIndex() {
      if let existing = messages[index].tools.firstIndex(where: { $0.id == tool.id }) {
        messages[index].tools[existing] = tool
      } else {
        messages[index].tools.append(tool)
      }
      return
    }
    // Tool activity with no turn in flight (a background job, a replayed
    // strip): keep it as its own quiet row.
    messages.append(
      ChatMessage(
        id: "tool_\(tool.id)",
        role: .system,
        text: "",
        createdAt: Date(),
        state: .complete,
        tools: [tool]
      )
    )
  }

  private mutating func updateTool(callID: String, _ change: (inout ToolActivity) -> Void) {
    for messageIndex in messages.indices.reversed() {
      if let toolIndex = messages[messageIndex].tools.firstIndex(where: { $0.id == callID }) {
        change(&messages[messageIndex].tools[toolIndex])
        return
      }
    }
  }

  private func streamingIndex() -> Int? {
    if let id = streamingMessageID, let index = messages.firstIndex(where: { $0.id == id }) { return index }
    return messages.lastIndex(where: { $0.isStreaming })
  }
}
