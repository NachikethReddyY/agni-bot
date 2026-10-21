/**
 * The app model: pairing, the connection, the open transcript, the roster, the
 * daemon's health, and every user intent the views need. Views call methods
 * here; frames arrive here from `AgniConnection`; nothing else reaches the
 * network.
 */
import Foundation
import Observation
import SwiftUI
import AppKit
import AgniKit
import AgniProtocol

@MainActor
@Observable
final class AppModel {
  enum Screen: Equatable {
    case pairing
    case chat
  }

  /// A published thread export: the daemon rendered the conversation to an HTML
  /// file and handed back a link the owner can open, copy, or send on.
  struct ExportLink: Equatable {
    var url: String
    var token: String
    var records: Int
  }

  // pairing / connection
  private(set) var screen: Screen = .pairing
  private(set) var connectionState: AgniConnection.State = .idle
  private(set) var settings: ServerSettings = SettingsStore().load()
  private(set) var secretKind: SecretStoreKind? = SecretStore.load()?.kind
  private(set) var tokenIsStored: Bool = SecretStore.load() != nil
  private(set) var isCheckingServer = false
  private(set) var isPairing = false
  var pairingError: String?

  // conversation surface + transcript
  var conversation = Conversation(agentID: "ea")
  private(set) var threads: [ThreadInfo] = []
  private(set) var agents: [AgentInfo] = []
  private(set) var unread: Set<String> = []
  /// What each agent is doing: idle, working, waiting, blocked.
  private(set) var agentStates: [String: String] = [:]

  // daemon health
  private(set) var health: HealthReport?
  private(set) var healthError: String?
  private(set) var configuredProviders: [ProviderStatus] = []
  private(set) var plugins: [PluginInfo] = []
  private(set) var jobs: [JobInfo] = []
  private(set) var tasks: [TaskInfo] = []
  /// What the agent can remember, filtered the way retrieval filters it.
  private(set) var memories: [MemoryItem] = []
  private(set) var isAddingProvider = false
  private(set) var providerAddError: String?
  private(set) var providerAddSuccess: String?
  private(set) var providerModels: [String] = []
  private(set) var providerModelsError: String?
  private(set) var isExporting = false
  private(set) var exportedLink: ExportLink?
  private(set) var exportError: String?

  // chrome
  var isInspectorPresented = false
  var isSettingsPresented = false
  var isAgentSwitcherPresented = false
  var searchText = ""
  private(set) var focusComposerToken = 0
  private(set) var statusText: String?
  var toast: NoticeRow?

  /// The window reads this for its title; there is one app per process.
  static weak var active: AppModel?

  private var connection: AgniConnection?
  private var pendingPairing: (settings: ServerSettings, token: String)?
  private var token = ""
  private var pendingProviderID: String?
  private var healthTask: Task<Void, Never>?
  private var toastTask: Task<Void, Never>?
  private var typingTask: Task<Void, Never>?
  private let settingsStore = SettingsStore()

  // MARK: lifecycle

  init() {
    AppModel.active = self
    NotificationBridge.shared.start()
    NotificationBridge.shared.onOpenThread = { [weak self] threadID in self?.openThreadFromNotification(threadID) }
    if let stored = SecretStore.load() {
      token = stored.token
      secretKind = stored.kind
      tokenIsStored = true
    }
    agents = [AgentInfo(id: "ea", name: "Agni Bot", color: "#f0b95a", model: nil, tools: [])]
  }

  func start() {
    screen = canConnect ? .chat : .pairing
    if canConnect { connect() }
  }

  var canConnect: Bool { !token.isEmpty && settings.websocketURL != nil }

  var serverAddress: String { settings.url }
  var tokenForConnectionForm: String { token }

  /// Pairing: keep the token in the Keychain, then open the socket.
  func pair(url: String, token entered: String, device: String) {
    let candidate = ServerSettings(
      url: url.trimmingCharacters(in: .whitespacesAndNewlines),
      deviceName: device.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Mac" : device,
      lastSeq: 0
    )
    guard candidate.websocketURL != nil else {
      pairingError = "That is not a server address. Try 127.0.0.1:8787, or ws://100.x.x.x:8787/ws for Tailscale."
      return
    }
    let candidateToken = entered.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !candidateToken.isEmpty else {
      pairingError = "A device token is required — mint one with bun run pair."
      return
    }
    pairingError = nil
    isCheckingServer = true
    Task {
      defer { isCheckingServer = false }
      do {
        guard let healthURL = candidate.healthURL else {
          throw TransportError.failed("The server address could not be converted to a health URL.")
        }
        let report = try await HealthClient.fetch(url: healthURL)
        guard report.ok else { throw TransportError.failed("The server health check did not return OK.") }
        pendingPairing = (candidate, candidateToken)
        isPairing = true
        health = report
        connect(settings: candidate, token: candidateToken)
      } catch {
        pairingError = "Could not reach Agni at \(candidate.url). Check that the daemon is running and the address is correct. \(error.localizedDescription)"
      }
    }
  }

  func editConnection() {
    pairingError = nil
    screen = .pairing
  }

  func cancelConnectionEdit() {
    guard tokenIsStored else { return }
    pendingPairing = nil
    isPairing = false
    connection?.stop()
    connection = nil
    screen = .chat
    connect()
  }

  func forgetDevice() {
    disconnect()
    SecretStore.clear()
    token = ""
    tokenIsStored = false
    secretKind = nil
    threads = []
    agents = [AgentInfo(id: "ea", name: "Agni Bot", color: "#f0b95a", model: nil, tools: [])]
    conversation = Conversation(agentID: "ea")
    health = nil
    configuredProviders = []
    jobs = []
    settings.lastSeq = 0
    settingsStore.save(settings)
    screen = .pairing
  }

  private func connect(settings targetSettings: ServerSettings? = nil, token targetToken: String? = nil) {
    let targetSettings = targetSettings ?? settings
    let targetToken = targetToken ?? token
    guard !targetToken.isEmpty, targetSettings.websocketURL != nil else { return }
    connection?.stop()
    let nextConnection = AgniConnection(settings: targetSettings, token: targetToken)
    nextConnection.onEvent = { [weak self] event in self?.handle(event) }
    connection = nextConnection
    nextConnection.start()
  }

  private func disconnect() {
    connection?.stop()
    connection = nil
    healthTask?.cancel()
    healthTask = nil
  }

  func retryNow() {
    if connection == nil {
      connect()
      return
    }
    connection?.retryNow()
  }

  // MARK: intents

  /// Open (or resolve) the bound conversation surface for an agent. Empty
  /// conversationID + agentID is the server's "this agent's conversation".
  func openConversation(agentID: String) {
    guard let connection, connectionState.isReady else { return }
    Task {
      try? await connection.send(.agentSelect(agentID: agentID))
      try? await connection.send(.conversationOpen(conversationID: "", agentID: agentID))
    }
  }

  /// Re-request the surface's transcript — after a reconnect, a resync gap,
  /// or when the user asks.
  func reloadConversation() {
    guard let conversationID = conversation.conversationID, let connection, connectionState.isReady else { return }
    Task {
      try? await connection.send(.conversationOpen(conversationID: conversationID, agentID: conversation.agentID))
      try? await connection.send(.conversationHistory(conversationID: conversationID, limit: 400))
    }
  }

  func refreshThreadList() {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.threadList(limit: 100)) }
  }

  func refreshJobs() {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.jobList(limit: 50)) }
  }

  func refreshTasks() {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.taskList(status: "all", limit: 200)) }
  }

  /// Ask what the agent can remember.
  func refreshMemories() {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.memoryList(scope: "global_user", limit: 100)) }
  }

  func refreshPlugins() {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.pluginList) }
  }

  /// Render the open conversation to a shareable HTML document on the daemon.
  /// The daemon does the rendering, so the file is identical no matter which
  /// client asked, and the link works for someone who has never run the app.
  func exportConversation() {
    exportedLink = nil
    exportError = nil
    guard let conversationID = conversation.conversationID, let connection, connectionState.isReady else {
      exportError = "Open a conversation first — there is nothing to export yet."
      return
    }
    isExporting = true
    Task {
      do {
        try await connection.send(.threadExport(conversationID: conversationID, title: nil))
      } catch {
        isExporting = false
        exportError = "Could not reach the daemon: \(error.localizedDescription)"
      }
    }
  }

  func connectPlugin(pluginID: String, account: String) {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.pluginConnect(pluginID: pluginID, account: account)) }
  }

  func disconnectPlugin(connectionID: String) {
    guard let connection, connectionState.isReady else { return }
    Task { try? await connection.send(.pluginDisconnect(connectionID: connectionID)) }
  }

  func updateTask(_ task: TaskInfo, action: String, until: Date? = nil) {
    guard let connection else { return }
    let timestamp = until.map { ISO8601DateFormatter().string(from: $0) }
    Task { try? await connection.send(.taskUpdate(taskID: task.id, action: action, until: timestamp)) }
  }

  func send(text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let localID = conversation.appendLocalUserMessage(text: trimmed)
    guard let connection, connectionState.isReady else {
      conversation.markLocalFailure(id: localID, reason: "Not connected — this message was not sent.")
      showToast(NoticeRow(id: "offline", kind: .failure, title: "Not connected", body: "Reconnecting. Your message was kept in the list but was not sent.", createdAt: Date()))
      return
    }
    Task {
      do {
        let specialistID = conversation.agentID == "ea" ? nil : conversation.agentID
        let channelID = specialistID.map { "dm:\($0)" } ?? "main"
        try await connection.send(.msgSend(threadID: nil, text: trimmed, files: nil, conversationID: nil, channelId: channelID, toAgentId: specialistID, texts: nil))
      } catch {
        conversation.markLocalFailure(id: localID, reason: "Send failed: \(error)")
      }
    }
  }

  func renameAgent(_ name: String, agentID: String = "ea") {
    guard let connection else { return }
    Task { try? await connection.send(.agentRename(agentId: agentID, name: name)) }
  }

  func updateTypingState(isTyping: Bool) {
    typingTask?.cancel()
    guard let connection, connectionState.isReady else { return }
    let channelID = conversation.agentID == "ea" ? "main" : "dm:\(conversation.agentID)"
    Task { try? await connection.send(.userTyping(channelId: channelID, isTyping: isTyping)) }
    guard isTyping else { return }
    typingTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled else { return }
      self?.updateTypingState(isTyping: false)
    }
  }

  func stopTurn() {
    guard let turnID = conversation.inFlightTurnID, let connection else { return }
    Task { try? await connection.send(.msgCancel(turnID: turnID)) }
  }

  func answer(approval: ApprovalRow, decision: Decision) {
    conversation.resolveApproval(id: approval.id, decision: decision)
    guard let connection else { return }
    Task { try? await connection.send(.approveReply(requestID: approval.id, decision: decision)) }
  }

  func answer(form: FormRow, option: String) {
    conversation.resolveForm(id: form.id, answer: option)
    send(text: option)
  }

  func selectAgent(_ agent: AgentInfo) {
    guard agent.id != conversation.agentID || conversation.conversationID == nil else {
      reloadConversation()
      return
    }
    // A fresh surface per agent; conversation.ok binds it to the enduring
    // conversation and history fills it.
    conversation = Conversation(agentID: agent.id)
    if let agentThread = threads.first(where: { $0.agentID == agent.id }) {
      unread.remove(agentThread.id)
    }
    openConversation(agentID: agent.id)
    focusComposer()
  }

  /// A notification names a session block; the surface is the agent's
  /// conversation. Map block → agent when the roster cache knows it.
  func openThreadFromNotification(_ threadID: String) {
    if let thread = threads.first(where: { $0.id == threadID }),
      let agent = agents.first(where: { $0.id == thread.agentID }) {
      selectAgent(agent)
    } else {
      reloadConversation()
    }
  }

  func setRoutine(_ job: JobInfo, enabled: Bool) {
    guard let connection else { return }
    Task { try? await connection.send(.jobSet(jobID: job.id, action: enabled ? "resume" : "pause")) }
  }

  func runRoutine(_ job: JobInfo) {
    guard let connection else { return }
    Task { try? await connection.send(.jobSet(jobID: job.id, action: "run")) }
  }

  func openTask(_ job: JobInfo) {
    // The task's results land as session blocks inside the agent's one
    // conversation — there is no separate chat window to open.
    reloadConversation()
    focusComposer()
  }

  func deleteTask(_ job: JobInfo) {
    guard let connection, job.state != "running" else { return }
    Task { try? await connection.send(.jobDelete(jobID: job.id)) }
  }

  func addProvider(providerID: String, apiKey: String, model: String? = nil, baseUrl: String? = nil, label: String? = nil) {
    let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else {
      providerAddError = "Enter an API key."
      return
    }
    guard let connection, connectionState.isReady else {
      providerAddError = "Connect to the daemon before adding a provider."
      return
    }
    isAddingProvider = true
    providerAddError = nil
    providerAddSuccess = nil
    pendingProviderID = providerID
    Task {
      do {
        try await connection.send(
          .providerAdd(providerID: providerID, apiKey: key, model: model, baseUrl: baseUrl, label: label)
        )
      } catch {
        isAddingProvider = false
        pendingProviderID = nil
        providerAddError = "Could not send the provider key: \(error.localizedDescription)"
      }
    }
  }

  func setProviderModel(providerID: String, model: String) {
    guard let connection, connectionState.isReady else {
      providerAddError = "Connect to the daemon before changing a model."
      return
    }
    isAddingProvider = true
    pendingProviderID = providerID
    providerAddError = nil
    providerAddSuccess = nil
    Task {
      do { try await connection.send(.providerModelSet(providerID: providerID, model: model)) }
      catch {
        isAddingProvider = false
        pendingProviderID = nil
        providerAddError = "Could not update the model: \(error.localizedDescription)"
      }
    }
  }

  func loadProviderModels(providerID: String) {
    guard let connection, connectionState.isReady else {
      providerModelsError = "Connect to the daemon to load available models."
      return
    }
    providerModels = []
    providerModelsError = nil
    Task {
      do { try await connection.send(.providerModelsList(providerID: providerID)) }
      catch { providerModelsError = "Could not request models: \\(error.localizedDescription)" }
    }
  }

  func prepareToAddProvider() {
    providerAddError = nil
    providerAddSuccess = nil
    pendingProviderID = nil
  }

  func focusComposer() { focusComposerToken += 1 }

  func dismissToast() { toast = nil }

  var agent: AgentInfo? {
    agents.first { $0.id == conversation.agentID } ?? agents.first
  }

  var activeThreadTitle: String? { conversation.title }

  /// A session block landed unread for an agent if any unread block belongs to
  /// their conversation (message turns arrive keyed by block id).
  func unreadBlocks(for agentID: String) -> Bool {
    unread.contains { id in threads.first { $0.id == id }?.agentID == agentID }
  }

  var filteredAgents: [AgentInfo] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return agents }
    return agents.filter { $0.name.lowercased().contains(query) || ($0.model ?? "").lowercased().contains(query) }
  }

  var filteredJobs: [JobInfo] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return jobs }
    return jobs.filter {
      ($0.title ?? "").lowercased().contains(query) || $0.kind.lowercased().contains(query)
        || $0.state.lowercased().contains(query)
    }
  }

  // MARK: connection events

  private func handle(_ event: AgniConnection.Event) {
    switch event {
    case .state(let state):
      let wasReady = connectionState.isReady
      connectionState = state
      switch state {
      case .ready:
        if var acceptedPairing = pendingPairing {
          acceptedPairing.settings.lastSeq = connection?.lastSeq ?? acceptedPairing.settings.lastSeq
          settings = acceptedPairing.settings
          token = acceptedPairing.token
          secretKind = SecretStore.save(token: acceptedPairing.token)
          tokenIsStored = true
          settingsStore.save(settings)
          pendingPairing = nil
          isPairing = false
          screen = .chat
        }
        refreshThreadList()
        refreshJobs()
        refreshTasks()
        startHealthPolling()
        if !wasReady { openConversation(agentID: conversation.agentID) }
      case .refused:
        if pendingPairing != nil {
          pairingError = refusalBody(state)
          pendingPairing = nil
          isPairing = false
        } else {
          notifyUser(title: "Agni cannot connect", body: refusalBody(state))
        }
      case .waiting:
        healthTask?.cancel()
        healthTask = nil
      default:
        break
      }

    case .frame(let frame):
      handleFrame(frame)

    case .malformed(let detail):
      conversation.note(
        NoticeRow(id: "malformed_\(UUID().uuidString)", kind: .failure, title: "Unreadable frame", body: detail, createdAt: Date())
      )

    case .durableReloadRequired:
      // The replay log cannot reach us: reload what SQLite holds.
      conversation.note(
        NoticeRow(
          id: "gap_\(UUID().uuidString)",
          kind: .info,
          title: "Reloaded history",
          body: "The daemon could not replay that far back, so this conversation was reloaded from the database.",
          createdAt: Date()
        )
      )
      refreshThreadList()
      reloadConversation()

    case .lastSeq(let seq):
      settings.lastSeq = seq
      settingsStore.save(settings)
    }
  }

  private func handleFrame(_ frame: ServerFrame) {
    switch frame {
    case .agentPresence(let presence):
      // What the agent is doing: the owner can tell "working" from
      // "waiting for you" without asking.
      agentStates[presence.agentId] = presence.state
      return
    case .statusUpdate(let status):
      let activeChannel = conversation.agentID == "ea" ? "main" : "dm:\(conversation.agentID)"
      guard status.channelId == activeChannel else { return }
      statusText = status.transient ? status.text : nil
      return
    case .msgNew(let message):
      let activeChannel = conversation.agentID == "ea" ? "main" : "dm:\(conversation.agentID)"
      guard message.channelId == activeChannel, !message.internal else { return }
      statusText = nil
      run(conversation.apply(frame))
      return
    case .agentUpdated(let updated):
      if let index = agents.firstIndex(where: { $0.id == updated.agentId }) {
        agents[index].name = updated.displayName
      }
      _ = conversation.apply(frame)
      return
    case .threadListOK(let list):
      threads = list.threads.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }

    case .conversationOK(let ok):
      let freshSurface = conversation.conversationID != ok.conversationID
      if freshSurface {
        conversation.bind(
          conversationID: ok.conversationID,
          agentID: ok.agentID,
          sessionID: ok.sessionID.isEmpty ? nil : ok.sessionID
        )
      } else if !ok.sessionID.isEmpty {
        // Same conversation after a reconnect: adopt the active block only.
        conversation.startSession(sessionID: ok.sessionID, conversationID: ok.conversationID)
      }
      guard let connection, connectionState.isReady else { return }
      Task {
        try? await connection.send(.conversationHistory(conversationID: ok.conversationID, limit: 400))
      }

    case .threadExportOK(let ok):
      isExporting = false
      exportError = nil
      exportedLink = ExportLink(url: ok.url, token: ok.token, records: ok.records)

    case .conversationHistoryOK(let history):
      conversation.loadConversationHistory(
        conversationID: history.conversationID,
        agentID: conversation.agentID,
        messages: history.messages
      )
      if conversation.threadID == nil, let connection, connectionState.isReady {
        // A surfaced block but no seam seen yet: resolve the active block.
        Task { try? await connection.send(.conversationOpen(conversationID: history.conversationID, agentID: conversation.agentID)) }
      }

    case .jobListOK(let list):
      jobs = list.jobs

    case .taskListOK(let list):
      tasks = list.tasks

    case .memoryListOK(let list):
      memories = list.memories

    case .taskUpdateOK(let result):
      if let index = tasks.firstIndex(where: { $0.id == result.task.id }) { tasks[index] = result.task }
      else { tasks.append(result.task) }

    case .providerAddOK(let result):
      configuredProviders = result.providers.map { provider in
        ProviderStatus(
          id: provider.id,
          label: provider.label,
          model: provider.model,
          tiers: provider.tiers,
          available: provider.available,
          cooldownRemainingMs: Int(provider.cooldownRemainingMs),
          lastError: provider.lastError,
          lastSuccessAt: provider.lastSuccessAt
        )
      }
      if health != nil { health?.providers = configuredProviders }
      let added = result.providers.first { $0.id == pendingProviderID }
      providerAddSuccess = "\(added?.label ?? "Provider") is configured with \(added?.model ?? "the selected model")."
      providerAddError = nil
      isAddingProvider = false
      pendingProviderID = nil

    case .providerModelsOK(let result):
      providerModels = result.models
      providerModelsError = nil

    case .pluginListOK(let result):
      plugins = result.plugins

    case .pluginState(let result):
      plugins = result.plugins

    case .pluginConnectOK(let result):
      if let raw = result.authorizeURL, let url = URL(string: raw) {
        NSWorkspace.shared.open(url)
      }

    case .helloOK:
      break

    case .error(let error) where isAddingProvider && ["unknown_provider", "invalid_key", "provider_exists", "provider_storage"].contains(error.code):
      providerAddError = error.message
      isAddingProvider = false
      pendingProviderID = nil
      return

    case .error(let error) where error.code == "provider_models":
      providerModelsError = error.message
      return

    case .error(let error) where ["unknown_plugin", "unknown_connection", "plugin_not_configured", "plugin_unavailable", "plugin_connect_failed"].contains(error.code):
      showToast(NoticeRow(id: UUID().uuidString, kind: .info, title: "Plugin", body: error.message, createdAt: Date()))
      return

    case .error(let error) where error.code == "unknown_conversation":
      // The conversation is gone (or wrong id): resolve it anew.
      conversation.conversationID = nil
      openConversation(agentID: conversation.agentID)
      return

    case .error(let error) where error.code == "export_failed":
      isExporting = false
      exportError = error.message
      return

    default:
      let effects = conversation.apply(frame)
      if case .turnEnd = frame { refreshThreadList() }
      if case .turnStart = frame { refreshThreadList() }
      run(effects)
    }
  }

  private func run(_ effects: [ConversationEffect]) {
    for effect in effects {
      switch effect {
      case .refreshThreadList:
        refreshThreadList()
      case .reloadDurableState:
        refreshThreadList()
        reloadConversation()
      case .notify(let title, let body, let sound, let threadID):
        notifyUser(title: title, body: body, sound: sound, threadID: threadID)
      case .focusComposer:
        focusComposer()
      case .unread(let threadID):
        if threadID != conversation.threadID { unread.insert(threadID) }
      case .agentsChanged(let roster):
        if roster != agents { agents = roster }
      case .presence:
        break
      }
    }
  }

  private func refusalBody(_ state: AgniConnection.State) -> String {
    if case .refused(let reason) = state { return reason }
    return "The connection was refused."
  }

  // MARK: health

  private func startHealthPolling() {
    healthTask?.cancel()
    healthTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshHealth()
        try? await Task.sleep(for: .seconds(20))
      }
    }
  }

  private func refreshHealth() async {
    guard let url = settings.healthURL else { return }
    do {
      let report = try await HealthClient.fetch(url: url)
      health = report
      configuredProviders = report.providers
      healthError = nil
    } catch {
      healthError = "\(error)"
    }
  }

  func refreshSettingsData() async {
    await refreshHealth()
    refreshJobs()
    refreshTasks()
    refreshPlugins()
  }

  // MARK: notifications

  private func notifyUser(title: String, body: String, sound: Bool = false, threadID: String? = nil) {
    showToast(NoticeRow(id: UUID().uuidString, kind: .info, title: title, body: body, createdAt: Date()))
    NotificationBridge.shared.post(title: title, body: body, sound: sound, threadID: threadID)
  }

  private func showToast(_ notice: NoticeRow) {
    toast = notice
    toastTask?.cancel()
    toastTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(6))
      guard !Task.isCancelled else { return }
      await MainActor.run { self?.toast = nil }
    }
  }
}

// Bindings for SwiftUI, built by hand: `@Bindable` is a macro and macros for
// SwiftUI property wrappers need Xcode's plugin (see AgniApp.swift).
extension AppModel {
  var settingsBinding: Binding<Bool> {
    Binding(get: { self.isSettingsPresented }, set: { self.isSettingsPresented = $0 })
  }

  var inspectorBinding: Binding<Bool> {
    Binding(get: { self.isInspectorPresented }, set: { self.isInspectorPresented = $0 })
  }

  var agentSwitcherBinding: Binding<Bool> {
    Binding(get: { self.isAgentSwitcherPresented }, set: { self.isAgentSwitcherPresented = $0 })
  }

  var searchBinding: Binding<String> {
    Binding(get: { self.searchText }, set: { self.searchText = $0 })
  }
}
