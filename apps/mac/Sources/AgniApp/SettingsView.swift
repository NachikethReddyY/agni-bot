/** App settings reached from the account control at the bottom of the sidebar. */
import SwiftUI
import AgniKit
import AgniProtocol
import AppKit
import UniformTypeIdentifiers

struct SettingsView: View {
  var model: AppModel
  var showingAddProvider = State(wrappedValue: false)
  var editingProvider = State<ProviderStatus?>(wrappedValue: nil)
  var section = State(wrappedValue: Section.plugins)
  var appearanceDraft = State(wrappedValue: AppearanceRuntime.profile)
  var appearanceError = State<String?>(wrappedValue: nil)

  enum Section: String, CaseIterable, Identifiable {
    case general = "General"
    case appearance = "Appearance"
    case plugins = "Plugins"
    case models = "Models & providers"
    case device = "This Mac"
    var id: String { rawValue }
    var systemImage: String {
      switch self {
      case .general: return "gearshape"
      case .appearance: return "paintpalette"
      case .plugins: return "puzzlepiece.extension"
      case .models: return "cpu"
      case .device: return "laptopcomputer"
      }
    }
  }

  var body: some View {
    HStack(spacing: 0) {
      rail
      Rectangle().fill(Palette.hairline).frame(width: 1)
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          heading
          content
        }
        .padding(28)
        .frame(maxWidth: 760, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(Palette.canvas)
    }
    .background(Palette.sidebar)
    .foregroundStyle(Palette.ink)
    .sheet(isPresented: showingAddProvider.projectedValue) {
      AddProviderView(model: model) { showingAddProvider.wrappedValue = false }
        .frame(minWidth: 380, minHeight: 360)
    }
    .sheet(item: editingProvider.projectedValue) { provider in
      ProviderModelEditor(model: model, provider: provider) { editingProvider.wrappedValue = nil }
        .frame(minWidth: 400, minHeight: 250)
    }
    .task { await model.refreshSettingsData() }
  }

  private var rail: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text("Settings")
        .font(.system(size: 17, weight: .semibold))
        .padding(.horizontal, 14)
        .padding(.top, 24)
        .padding(.bottom, 12)
      ForEach(Section.allCases) { item in
        Button {
          section.wrappedValue = item
        } label: {
          Label(item.rawValue, systemImage: item.systemImage)
            .foregroundStyle(section.wrappedValue == item ? Palette.ink : Palette.inkSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(section.wrappedValue == item ? Palette.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
      }
      Spacer()
      Button { model.isSettingsPresented = false } label: {
        Label("Back to chat", systemImage: "arrow.left")
          .foregroundStyle(Palette.inkSecondary)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .padding(.bottom, 12)
    }
    .padding(.horizontal, 10)
    .frame(width: 210)
    .background(Palette.sidebar)
  }

  private var heading: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(section.wrappedValue.rawValue)
        .font(.system(size: 24, weight: .semibold))
      Text(subtitle)
        .font(Typography.body)
        .foregroundStyle(Palette.inkSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var subtitle: String {
    switch section.wrappedValue {
    case .general: return "Account, appearance and system preferences."
    case .appearance: return "Themes, colour, backgrounds and interface comfort."
    case .plugins: return "Connections Agni can use on your behalf. Tokens stay on the daemon."
    case .models: return "Connect API providers. Keys are stored on the server and never on this Mac."
    case .device: return "This Mac and how it pairs with the daemon."
    }
  }

  @ViewBuilder
  private var content: some View {
    switch section.wrappedValue {
    case .general: generalSection
    case .appearance: appearanceSection
    case .plugins: pluginsSection
    case .models: modelsSection
    case .device: deviceSection
    }
  }

  // MARK: - General

  private var generalSection: some View {
    VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 12) {
        Text("Account").font(Typography.title)
        HStack(spacing: 10) {
          Image(systemName: "person.crop.circle.fill").font(.system(size: 28)).foregroundStyle(Palette.ember)
          VStack(alignment: .leading, spacing: 2) {
            Text("Agni").font(Typography.rowTitle)
            Text("Your personal assistant").font(Typography.caption).foregroundStyle(Palette.inkSecondary)
          }
          Spacer()
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

      connectionSection
    }
  }

  // MARK: - Appearance

  private var appearanceSection: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Profile").font(Typography.meta).foregroundStyle(Palette.inkSecondary)
        Picker("Profile", selection: Binding(
          get: { model.appearance.id },
          set: { id in model.activateAppearance(id); appearanceDraft.wrappedValue = model.appearance }
        )) {
          ForEach(model.appearanceProfiles) { profile in Text(profile.name).tag(profile.id) }
        }.labelsHidden().frame(maxWidth: 220)
        TextField("Theme name", text: profileBinding(\.name)).frame(maxWidth: 170)
        Spacer()
        Button("Save as new") {
          var copy = appearanceDraft.wrappedValue
          copy.id = "theme_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
          copy.name += " copy"
          appearanceDraft.wrappedValue = copy
        }
      }

      VStack(alignment: .leading, spacing: 12) {
        Text("Theme").font(Typography.title)
        Picker("Theme", selection: profileBinding(\.preset)) {
          ForEach(["agni", "midnight", "graphite", "paper", "ocean", "forest", "warm"], id: \.self) { Text($0.capitalized).tag($0) }
        }.pickerStyle(.segmented)
        Picker("Mode", selection: profileBinding(\.mode)) {
          Text("System").tag("system"); Text("Dark").tag("dark"); Text("Light").tag("light")
        }.pickerStyle(.segmented)
      }.appearanceCard()

      VStack(alignment: .leading, spacing: 12) {
        Text("Accent palette").font(Typography.title)
        Picker("Accent", selection: profileBinding(\.accent)) {
          ForEach(["ember", "amber", "ocean", "forest", "violet", "rose", "mono"], id: \.self) { Text($0.capitalized).tag($0) }
        }.pickerStyle(.segmented)
      }.appearanceCard()

      VStack(alignment: .leading, spacing: 12) {
        Text("Background").font(Typography.title)
        HStack {
          Button("None") { appearanceDraft.wrappedValue.background = AppearanceBackground(kind: "none") }
          Button("Solid") { appearanceDraft.wrappedValue.background = AppearanceBackground(kind: "solid", color: "#111827") }
          Button("Gradient") { appearanceDraft.wrappedValue.background = AppearanceBackground(kind: "gradient", from: "#111827", to: "#3b1520", angle: 135) }
          Button("Choose image…") { chooseBackground() }
        }
        if appearanceDraft.wrappedValue.background.kind == "image" {
          HStack {
            Text("Dim").font(Typography.meta)
            Slider(value: backgroundBinding(\.dim, fallback: 0.68), in: 0...0.95)
            Text("Blur").font(Typography.meta)
            Slider(value: backgroundBinding(\.blur, fallback: 0), in: 0...24)
          }
        }
        if let error = appearanceError.wrappedValue { Text(error).font(Typography.caption).foregroundStyle(.orange) }
      }.appearanceCard()

      DisclosureGroup("Advanced") {
        VStack(alignment: .leading, spacing: 12) {
          appearancePicker("Text size", keyPath: \.textScale, values: ["small", "default", "large"])
          appearancePicker("Density", keyPath: \.density, values: ["compact", "comfortable"])
          appearancePicker("Corners", keyPath: \.corners, values: ["square", "standard", "soft"])
          appearancePicker("Motion", keyPath: \.motion, values: ["system", "full", "reduced"])
          appearancePicker("Agent color", keyPath: \.agentTint, values: ["full", "subtle", "off"])
        }.padding(.top, 10)
      }.appearanceCard()

      HStack {
        if model.appearanceProfiles.count > 1 { Button("Delete profile", role: .destructive) { model.deleteAppearance(model.appearance.id) } }
        Spacer()
        Button("Cancel") { appearanceDraft.wrappedValue = model.appearance }
        Button("Apply") { model.saveAppearance(appearanceDraft.wrappedValue) }.buttonStyle(.borderedProminent).tint(Palette.ember)
      }
    }
  }

  private func profileBinding(_ keyPath: WritableKeyPath<AppearanceProfile, String>) -> Binding<String> {
    Binding(get: { appearanceDraft.wrappedValue[keyPath: keyPath] }, set: { appearanceDraft.wrappedValue[keyPath: keyPath] = $0 })
  }

  private func backgroundBinding(_ keyPath: WritableKeyPath<AppearanceBackground, Double?>, fallback: Double) -> Binding<Double> {
    Binding(get: { appearanceDraft.wrappedValue.background[keyPath: keyPath] ?? fallback }, set: { appearanceDraft.wrappedValue.background[keyPath: keyPath] = $0 })
  }

  private func appearancePicker(_ label: String, keyPath: WritableKeyPath<AppearanceProfile, String>, values: [String]) -> some View {
    HStack { Text(label).font(Typography.body); Spacer(); Picker(label, selection: profileBinding(keyPath)) { ForEach(values, id: \.self) { Text($0.capitalized).tag($0) } }.labelsHidden().frame(width: 240) }
  }

  private func chooseBackground() {
    let panel = NSOpenPanel(); panel.allowedContentTypes = [.png, .jpeg, .webP]; panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    Task {
      do {
        let id = try await model.uploadBackground(url)
        appearanceDraft.wrappedValue.background = AppearanceBackground(kind: "image", assetID: id, fit: "cover", positionX: 50, positionY: 50, dim: 0.68, blur: 0)
        appearanceError.wrappedValue = nil
      } catch { appearanceError.wrappedValue = error.localizedDescription }
    }
  }

  // MARK: - Plugins

  private var pluginsSection: some View {
    VStack(alignment: .leading, spacing: 14) {
      pluginGroup(title: "Agent-owned", subtitle: "Agni's own accounts — it acts freely within Google's limits.", account: "agent")
      pluginGroup(title: "Your accounts", subtitle: "Your data — reads and drafts are direct; sends, creates and shares ask first.", account: "owner")
    }
  }

  private func pluginGroup(title: String, subtitle: String, account: String) -> some View {
    let rows = model.plugins.filter { $0.account == account }
    return VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(Typography.title)
        Text(subtitle).font(Typography.meta).foregroundStyle(Palette.inkSecondary)
      }
      VStack(spacing: 0) {
        if rows.isEmpty {
          Text("No plugins in this group.")
            .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
            .padding(.vertical, 8)
        } else {
          ForEach(rows) { plugin in pluginRow(plugin) }
        }
      }
      .padding(16)
      .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }

  private func pluginRow(_ plugin: PluginInfo) -> some View {
    HStack(spacing: 12) {
      Image(systemName: plugin.authKind == "oauth" ? "link" : plugin.authKind == "api-key" ? "key" : "puzzlepiece.extension")
        .font(.system(size: 14))
        .foregroundStyle(Palette.inkSecondary)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(plugin.name).font(Typography.rowTitle)
          statusChip(plugin)
        }
        Text(plugin.description)
          .font(Typography.caption).foregroundStyle(Palette.inkSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if let label = plugin.accountLabel {
          Text(label).font(Typography.machine).foregroundStyle(Palette.inkTertiary)
        }
        if let error = plugin.error {
          Text(error).font(Typography.caption).foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer()
      pluginAction(plugin)
    }
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
  }

  private func statusChip(_ plugin: PluginInfo) -> some View {
    let status = plugin.status ?? "disconnected"
    let (text, color): (String, Color) = {
      switch status {
      case "connected": return ("Connected", .green)
      case "pending": return ("Connecting…", .orange)
      case "error": return ("Error", .red)
      default: return ("Not connected", Palette.inkTertiary)
      }
    }()
    return Text(text)
      .font(Typography.caption)
      .foregroundStyle(color)
      .padding(.horizontal, 7).padding(.vertical, 2)
      .background(color.opacity(0.12), in: Capsule())
  }

  @ViewBuilder
  private func pluginAction(_ plugin: PluginInfo) -> some View {
    if plugin.status == "connected" {
      Button("Disconnect") {
        if let id = plugin.connectionID { model.disconnectPlugin(connectionID: id) }
      }
      .buttonStyle(.bordered)
      .tint(.red)
    } else if plugin.status == "pending" {
      Button("Waiting…") {}
        .buttonStyle(.bordered)
        .disabled(true)
    } else if !plugin.available {
      Button("Coming soon") {}
        .buttonStyle(.bordered)
        .disabled(true)
    } else {
      Button("Connect") {
        model.connectPlugin(pluginID: plugin.id, account: plugin.account)
      }
      .buttonStyle(.borderedProminent)
      .tint(Palette.ember)
    }
  }

  // MARK: - Models

  private var modelsSection: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("Connected providers").font(Typography.title)
          Text("Agni routes requests across available models automatically.")
            .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
        }
        Spacer()
        Button {
          model.prepareToAddProvider()
          showingAddProvider.wrappedValue = true
        } label: {
          Label("Add provider", systemImage: "plus")
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.ember)
        .disabled(!model.connectionState.isReady)
      }
      if !model.configuredProviders.isEmpty {
        ForEach(model.configuredProviders) { provider in providerRow(provider) }
      } else if model.health != nil {
        emptyProviders
      } else {
        Text(model.healthError ?? "Waiting for the daemon status…")
          .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
      }
      if let success = model.providerAddSuccess {
        Label(success, systemImage: "checkmark.circle.fill")
          .font(Typography.meta).foregroundStyle(.green)
      }
      Text("Supported API providers include Groq, Cerebras, NVIDIA NIM, Gemini, and OpenRouter. Local models can be served by LM Studio on the daemon host.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
      Text("Model choices are saved on the daemon in data/providers.json. Provider API keys stay in its mode-600 .env file.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(16)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var emptyProviders: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text("No model providers connected").font(Typography.rowTitle)
      Text("Add a provider key to let Agni answer using hosted models. The key is sent directly to your daemon.")
        .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
    }
    .padding(.vertical, 8)
  }

  private func providerRow(_ provider: ProviderStatus) -> some View {
    HStack(spacing: 12) {
      Circle().fill(provider.available ? Color.green : Color.orange).frame(width: 8, height: 8)
      VStack(alignment: .leading, spacing: 3) {
        Text(provider.label).font(Typography.rowTitle)
        Text(provider.model).font(Typography.machine).foregroundStyle(Palette.inkSecondary)
        Text(provider.available ? provider.tiers.joined(separator: " · ") : (provider.lastError ?? "Unavailable"))
          .font(Typography.caption).foregroundStyle(provider.available ? Palette.inkTertiary : Color.orange)
      }
      Spacer()
      Text(provider.available ? "Ready" : "Needs attention")
        .font(Typography.caption)
        .foregroundStyle(provider.available ? Color.green : Color.orange)
      Button { editingProvider.wrappedValue = provider } label: {
        Image(systemName: "pencil")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(Palette.inkSecondary)
          .frame(width: 28, height: 28)
      }
      .buttonStyle(.plain)
      .help("Choose model")
      .accessibilityLabel("Choose model for \(provider.label)")
    }
    .padding(.vertical, 8)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
  }

  // MARK: - Device

  private var deviceSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("This Mac").font(Typography.title)
      settingsRow("Device", model.settings.deviceName)
      settingsRow("Token storage", model.secretKind == .file ? "Secure local file" : "macOS Keychain")
      Button("Forget this device", role: .destructive) { model.forgetDevice() }
        .buttonStyle(.bordered)
      connectionSection
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var connectionSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Connection").font(Typography.title)
      HStack(spacing: 9) {
        PresenceDot(isOnline: model.connectionState.isReady)
        Text(connectionTitle).font(Typography.rowTitle)
      }
      Text(model.serverAddress).font(Typography.machine).foregroundStyle(Palette.inkSecondary)
      Button("Connection settings…") { model.editConnection() }
        .buttonStyle(.bordered)
    }
    .padding(16)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private func settingsRow(_ title: String, _ value: String) -> some View {
    HStack {
      Text(title).foregroundStyle(Palette.inkSecondary)
      Spacer()
      Text(value).foregroundStyle(Palette.ink).textSelection(.enabled)
    }
    .font(Typography.meta)
  }

  private var connectionTitle: String {
    model.connectionState.isReady ? "Agni is connected" : "Agni is disconnected"
  }
}

private extension View {
  func appearanceCard() -> some View {
    padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Metrics.cardRadius).stroke(Palette.hairline, lineWidth: 1))
  }
}

// MARK: - Provider editors (unchanged)

private struct ProviderModelEditor: View {
  var model: AppModel
  var provider: ProviderStatus
  var onDismiss: () -> Void
  var draft = State(wrappedValue: "")
  var selectedModel = State(wrappedValue: "")
  var isCustomModel = State(wrappedValue: false)

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Choose a model").font(.system(size: 18, weight: .semibold))
      Text("Enter a model ID supported by \(provider.label). The daemon will route future requests to it.")
        .font(Typography.meta).foregroundStyle(Palette.inkSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if !model.providerModels.isEmpty {
        Picker("Available models", selection: selectedModel.projectedValue) {
          ForEach(model.providerModels, id: \.self) { modelID in
            Text(modelID).tag(modelID)
          }
          Text("Enter a custom model ID…").tag("__custom__")
        }
        .pickerStyle(.menu)
        .onChange(of: selectedModel.wrappedValue) { _, value in
          if value == "__custom__" {
            isCustomModel.wrappedValue = true
            draft.wrappedValue = ""
          } else {
            isCustomModel.wrappedValue = false
            draft.wrappedValue = value
          }
        }
      }
      if model.providerModels.isEmpty || isCustomModel.wrappedValue {
        TextField("Model ID", text: draft.projectedValue)
          .textFieldStyle(.roundedBorder)
      }
      if let error = model.providerModelsError {
        HStack {
          Text(error).font(Typography.caption).foregroundStyle(.orange)
          Spacer()
          Button("Retry") { model.loadProviderModels(providerID: provider.id) }
            .buttonStyle(.link).font(Typography.caption)
        }
      }
      if let error = model.providerAddError {
        Text(error).font(Typography.caption).foregroundStyle(.orange)
      }
      Spacer(minLength: 0)
      HStack {
        Button("Cancel") { onDismiss() }.keyboardShortcut(.cancelAction)
        Spacer()
        Button(model.isAddingProvider ? "Saving…" : "Save model") {
          model.setProviderModel(providerID: provider.id, model: draft.wrappedValue)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.ember)
        .disabled(model.isAddingProvider || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(20)
    .background(Palette.canvas)
    .onAppear {
      draft.wrappedValue = provider.model
      selectedModel.wrappedValue = provider.model
      model.loadProviderModels(providerID: provider.id)
    }
    .onChange(of: model.providerModels) { _, models in
      guard !models.isEmpty else { return }
      let choice = models.contains(provider.model) ? provider.model : models[0]
      selectedModel.wrappedValue = choice
      draft.wrappedValue = choice
      isCustomModel.wrappedValue = false
    }
    .onChange(of: model.providerAddSuccess) { _, success in
      if success != nil { onDismiss() }
    }
  }
}
