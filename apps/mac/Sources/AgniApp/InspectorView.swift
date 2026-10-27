/**
 * Inspector: the agent, the routines it runs without being asked, the
 * connections it depends on, and today's numbers. Everything here is either
 * reported by the daemon or absent — nothing is estimated.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct InspectorView: View {
  var model: AppModel
  var showingAddProvider = State(wrappedValue: false)

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        agentCard
        tasksSection
        memorySection
        routines
        connections
        today
        device
      }
      .padding(16)
    }
    .background(Palette.canvas)
    .sheet(isPresented: showingAddProvider.projectedValue) {
      AddProviderView(model: model) { showingAddProvider.wrappedValue = false }
        .frame(minWidth: 360, minHeight: 340)
    }
  }

  // MARK: agent

  private var agentCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        AgentAvatar(agent: model.agent, isAlive: model.conversation.isStreaming, size: .large)
        VStack(alignment: .leading, spacing: 3) {
          Text(model.agent?.name ?? "Agni")
            .font(.system(size: 18, weight: .semibold))
          HStack(spacing: 5) {
            PresenceDot(isOnline: model.connectionState.isReady)
            Text(model.connectionState.isReady ? "Available" : "Offline")
              .font(Typography.meta)
              .foregroundStyle(Palette.inkSecondary)
          }
        }
        Spacer(minLength: 0)
      }
      row("Model", model.agent?.model ?? "routed by the daemon")
      row("Lane", "task — tools, up to 16 steps")
      row("Tools", (model.agent?.tools?.isEmpty == false) ? model.agent!.tools!.joined(separator: ", ") : "none in this lane")
      if let threadID = model.conversation.threadID {
        row("Thread", threadID)
      }
    }
  }

  // MARK: memory

  /// What the agent holds, and where it came from. The list is filtered the
  /// way retrieval filters it, so nothing shows here that the agent could
  /// not have recalled.
  private var memorySection: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        sectionTitle("Memory")
        Spacer()
        Button("Refresh") { model.refreshMemories() }
          .buttonStyle(.link)
          .font(Typography.caption)
      }
      if model.memories.isEmpty {
        empty("Nothing remembered yet", "Facts the agent keeps show up here.")
      }
      ForEach(model.memories) { memory in
        VStack(alignment: .leading, spacing: 3) {
          Text(memory.text).font(Typography.rowTitle).lineLimit(3)
          Text(
            [memory.scope, memory.source, "\(Int(memory.confidence * 100))%"]
              .joined(separator: " · ")
          )
          .font(Typography.caption).foregroundStyle(Palette.inkSecondary)
        }
        .padding(.vertical, 4)
      }
    }
  }

  // MARK: routines

  private var tasksSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        sectionTitle("Tasks")
        Spacer()
        Button("Refresh") { model.refreshTasks() }
          .buttonStyle(.link)
          .font(Typography.caption)
      }
      if model.tasks.allSatisfy({ $0.status == "done" }) {
        empty("No open tasks", "Capture one in chat with “add task: …”.")
      }
      ForEach(model.tasks.filter { $0.status != "done" }) { task in
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 3) {
            Text(task.title).font(Typography.rowTitle).lineLimit(2)
            Text([task.dueAt.map { "Due \(AgniFormat.stamp(AgniFormat.parseISO($0) ?? Date()))" }, task.priority.capitalized, task.status.capitalized].compactMap { $0 }.joined(separator: " · "))
              .font(Typography.caption).foregroundStyle(Palette.inkSecondary)
          }
          Spacer(minLength: 4)
          Menu("Snooze") {
            Button("1 hour") { model.updateTask(task, action: "snooze", until: Calendar.current.date(byAdding: .hour, value: 1, to: Date())) }
            Button("Tomorrow") { model.updateTask(task, action: "snooze", until: Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())) }
          }.menuStyle(.borderlessButton)
          Button("Done") { model.updateTask(task, action: "done") }.buttonStyle(.borderedProminent)
        }
        .padding(.vertical, 5)
      }
      let completed = Array(model.tasks.filter { $0.status == "done" }.prefix(5))
      if !completed.isEmpty {
        sectionTitle("Completed recently").padding(.top, 4)
        ForEach(completed) { task in
          HStack {
            Text(task.title).font(Typography.caption).foregroundStyle(Palette.inkSecondary).lineLimit(1)
            Spacer()
            Button("Reopen") { model.updateTask(task, action: "reopen") }.buttonStyle(.link).font(Typography.caption)
          }
        }
      }
    }
  }

  // MARK: routines

  private var recurring: [JobInfo] { model.jobs.filter { $0.everyMs != nil } }
  private var scheduled: [JobInfo] { model.jobs.filter { $0.everyMs == nil } }

  private var routines: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionTitle("Routines")

      if model.jobs.isEmpty {
        empty("Nothing scheduled", "Routines are background turns the daemon runs while you are away. Add one with bun run job add \"…\" --every 1h.")
      }

      ForEach(recurring) { job in
        routineRow(job)
      }

      if !scheduled.isEmpty {
        sectionTitle("Scheduled once")
          .padding(.top, 4)
        ForEach(scheduled) { job in
          routineRow(job)
        }
      }

      if !model.jobs.isEmpty {
        Button("Refresh") { model.refreshJobs() }
          .buttonStyle(.link)
          .font(Typography.caption)
      }
    }
  }

  private func routineRow(_ job: JobInfo) -> some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(job.title?.isEmpty == false ? job.title! : job.kind)
          .font(Typography.rowTitle)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
        Text(cadence(job))
          .font(Typography.caption)
          .foregroundStyle(Palette.inkSecondary)
        if let result = job.lastResult, !result.isEmpty {
          Text(AgniFormat.preview(result, limit: 90))
            .font(Typography.caption)
            .foregroundStyle(Palette.inkTertiary)
            .lineLimit(2)
        }
        if job.state == "failed" {
          Text("Failed after \(job.attempts) attempts")
            .font(Typography.caption)
            .foregroundStyle(.orange)
        }
        if !job.enabled {
          Text("Paused")
            .font(Typography.caption)
            .foregroundStyle(Palette.inkTertiary)
        }
      }
      Spacer(minLength: 0)
      Toggle(
        "",
        isOn: Binding(
          get: { job.enabled },
          set: { model.setRoutine(job, enabled: $0) }
        )
      )
      .labelsHidden()
      .toggleStyle(.switch)
      .controlSize(.small)
      .help(job.enabled ? "Pause this routine" : "Resume this routine")
      .accessibilityLabel("\(job.title ?? job.kind) routine")
    }
    .padding(.vertical, 6)
    .contextMenu {
      Button("Run now") { model.runRoutine(job) }
      Text(job.id)
    }
  }

  private func cadence(_ job: JobInfo) -> String {
    let every = AgniFormat.cadence(everyMs: job.everyMs, runAt: AgniFormat.parseISO(job.runAt))
    if job.state == "running" { return "Running now" }
    if job.enabled, let runAt = AgniFormat.parseISO(job.runAt), job.everyMs != nil {
      return "\(every) · next \(AgniFormat.stamp(runAt))"
    }
    return every
  }

  // MARK: connections

  private var connections: some View {
    VStack(alignment: .leading, spacing: 10) {
      sectionTitle("Connections")
      Button {
        model.prepareToAddProvider()
        showingAddProvider.wrappedValue = true
      } label: {
        Label("Add provider", systemImage: "plus")
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      .disabled(!model.connectionState.isReady)
      if let health = model.health {
        ForEach(health.providers) { provider in
          HStack(alignment: .top, spacing: 8) {
            Circle()
              .fill(provider.available ? Color.green : Color.orange)
              .frame(width: 6, height: 6)
              .padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
              Text(provider.label).font(Typography.rowTitle)
              Text(provider.model)
                .font(Typography.machine)
                .foregroundStyle(Palette.inkSecondary)
              if !provider.available {
                Text(
                  provider.cooldownRemainingMs > 0
                    ? "Cooling \(Int(provider.cooldownRemainingMs / 1000))s\(provider.lastError.map { " — \($0)" } ?? "")"
                    : (provider.lastError ?? "Unavailable")
                )
                .font(Typography.caption)
                .foregroundStyle(.orange)
                .lineLimit(3)
              }
              Text(provider.tiers.joined(separator: " · "))
                .font(Typography.caption)
                .foregroundStyle(Palette.inkTertiary)
            }
            Spacer(minLength: 0)
          }
        }
        if health.providers.isEmpty {
          empty("No providers configured", "Add a provider key here. Agni stores it on the daemon host.")
        }
      } else {
        empty("Daemon status unavailable", model.healthError ?? "Waiting for /health…")
      }
    }
  }

  // MARK: today

  private var today: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionTitle("Today")
      if let health = model.health {
        row("Turns", "\(health.usageToday.turns.formatted())")
        row("Tokens", "\(health.usageToday.inputTokens.formatted()) in · \(health.usageToday.outputTokens.formatted()) out")
        row("Daemon", "up \(AgniFormat.uptime(health.uptimeMs)) · protocol v\(health.v)")
      } else {
        row("Usage", "unknown")
      }
      Text("Free-tier providers are the default; if a NIM pay-as-you-go key is set, spend is capped by the daemon's daily limits.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: device

  private var device: some View {
    VStack(alignment: .leading, spacing: 8) {
      sectionTitle("This Mac")
      row("Server", model.serverAddress)
      row("Token", model.secretKind == .file ? "stored in a 600 file" : "stored in Keychain")
      row("Device", model.settings.deviceName)
      Button("Forget this device") { model.forgetDevice() }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .padding(.top, 2)
      Text("Forgetting removes the token from this Mac. The server still knows the device until you revoke it with bun run devices.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: pieces

  private func sectionTitle(_ text: String) -> some View {
    Text(text)
      .font(Typography.rowTitle)
      .foregroundStyle(Palette.inkSecondary)
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(label)
        .font(Typography.meta)
        .foregroundStyle(Palette.inkTertiary)
        .frame(width: 62, alignment: .leading)
      Text(value)
        .font(Typography.meta)
        .foregroundStyle(Palette.ink)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
  }

  private func empty(_ title: String, _ body: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(Typography.meta)
        .foregroundStyle(Palette.inkSecondary)
      Text(body)
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
    )
  }
}

struct AddProviderView: View {
  private struct ProviderOption: Identifiable {
    var id: String
    var title: String
    var note: String
  }

  var model: AppModel
  var onDismiss: () -> Void
  var providerID = State(wrappedValue: "groq")
  var apiKey = State(wrappedValue: "")
  var modelID = State(wrappedValue: "llama-3.1-8b-instant")
  var baseUrl = State(wrappedValue: "")
  var label = State(wrappedValue: "")

  private let options = [
    ProviderOption(id: "groq", title: "Groq", note: "Fast"),
    ProviderOption(id: "cerebras", title: "Cerebras", note: "Fast"),
    ProviderOption(id: "nim", title: "NVIDIA NIM", note: "Free credits · all lanes"),
    ProviderOption(id: "gemini", title: "Gemini", note: "Free tier · task and deep lanes"),
    ProviderOption(id: "openrouter", title: "OpenRouter", note: "Free models · deep lane"),
    ProviderOption(id: "custom", title: "Custom endpoint", note: "Any OpenAI-compatible URL · token router, proxy"),
  ]

  private var isCustom: Bool { providerID.wrappedValue == "custom" }

  private var availableOptions: [ProviderOption] {
    let configured = Set(model.health?.providers.map(\.id) ?? [])
    // A custom endpoint gets its own id when it is added, so the option is
    // hidden once one exists rather than when the literal id is configured.
    let hasCustom = configured.contains { $0.hasPrefix("custom") }
    return options.filter { $0.id == "custom" ? !hasCustom : !configured.contains($0.id) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Add a provider")
          .font(.system(size: 18, weight: .semibold))
        Text("Choose an API provider and add its key.")
          .font(Typography.meta)
          .foregroundStyle(Palette.inkSecondary)
      }

      if availableOptions.isEmpty {
        Text("All supported providers are already configured.")
          .font(Typography.meta)
          .foregroundStyle(Palette.inkSecondary)
      } else {
        Picker("Provider", selection: providerID.projectedValue) {
          ForEach(availableOptions) { option in
            Text(option.title).tag(option.id)
          }
        }
        .pickerStyle(.menu)
        .accessibilityLabel("Provider")

        if let option = availableOptions.first(where: { $0.id == providerID.wrappedValue }) {
          Text(option.note)
            .font(Typography.caption)
            .foregroundStyle(Palette.inkTertiary)
        }

        if isCustom {
          TextField("Endpoint URL", text: baseUrl.projectedValue)
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel("Endpoint URL")
          Text("The base URL of an OpenAI-compatible endpoint — your token router, a proxy, or a self-hosted gateway. The daemon calls /chat/completions on it.")
            .font(Typography.caption)
            .foregroundStyle(Palette.inkTertiary)
            .fixedSize(horizontal: false, vertical: true)

          TextField("Name", text: label.projectedValue)
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel("Endpoint name")
          Text("How this endpoint is named in the list. The host is used when left empty.")
            .font(Typography.caption)
            .foregroundStyle(Palette.inkTertiary)
            .fixedSize(horizontal: false, vertical: true)
        }

        SecureField("API key", text: apiKey.projectedValue)
          .textFieldStyle(.roundedBorder)
          .textContentType(.password)
          .accessibilityLabel("Provider API key")

        TextField("Model ID", text: modelID.projectedValue)
          .textFieldStyle(.roundedBorder)
          .accessibilityLabel("Model ID")
        Text("Use the model ID shown by your provider. Leave the suggested ID unless you want a different supported model.")
          .font(Typography.caption)
          .foregroundStyle(Palette.inkTertiary)
          .fixedSize(horizontal: false, vertical: true)

        Text("The key is sent to your connected daemon and saved in the daemon host's mode-600 .env file. The app does not keep a copy.")
          .font(Typography.caption)
          .foregroundStyle(Palette.inkTertiary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let error = model.providerAddError {
        Text(error)
          .font(Typography.caption)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }

      Spacer(minLength: 0)
      HStack {
        Button("Cancel") { onDismiss() }
          .keyboardShortcut(.cancelAction)
        Spacer()
        Button {
          let enteredKey = apiKey.wrappedValue
          apiKey.wrappedValue = ""
          model.addProvider(
            providerID: providerID.wrappedValue,
            apiKey: enteredKey,
            model: modelID.wrappedValue,
            baseUrl: isCustom ? baseUrl.wrappedValue : nil,
            label: isCustom ? label.wrappedValue : nil
          )
        } label: {
          if model.isAddingProvider {
            ProgressView().controlSize(.small)
          } else {
            Text("Save provider")
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(
          availableOptions.isEmpty
            || apiKey.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || (isCustom && baseUrl.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            || model.isAddingProvider
        )
      }
    }
    .padding(20)
    .background(Palette.canvas)
    .onAppear {
      if !availableOptions.contains(where: { $0.id == providerID.wrappedValue }), let first = availableOptions.first {
        providerID.wrappedValue = first.id
      }
      modelID.wrappedValue = suggestedModel(providerID.wrappedValue)
    }
    .onChange(of: model.providerAddSuccess) { _, success in
      if success != nil { onDismiss() }
    }
    .onChange(of: availableOptions.map(\.id)) { _, ids in
      if !ids.contains(providerID.wrappedValue), let first = ids.first { providerID.wrappedValue = first }
    }
    .onChange(of: providerID.wrappedValue) { _, id in modelID.wrappedValue = suggestedModel(id) }
  }

  private func suggestedModel(_ id: String) -> String {
    switch id {
    case "groq": "llama-3.1-8b-instant"
    case "cerebras": "llama3.1-8b"
    case "nim": "meta/llama-3.3-70b-instruct"
    case "gemini": "gemini-2.0-flash"
    case "openrouter": "meta-llama/llama-3.3-70b-instruct:free"
    default: ""
    }
  }
}
