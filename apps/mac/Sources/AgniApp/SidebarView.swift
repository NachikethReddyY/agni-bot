/** The roster, and nothing else. Scheduled tasks lived beneath the agents;
 *  they are moving elsewhere in the redesign, so the sidebar is a pure agent
 *  list again. Threads are not shown — each agent has one enduring
 *  conversation surface; sessions are seams in it, not list entries
 *  (blueprint v3 §5). */
import SwiftUI
import AgniKit
import AgniProtocol

struct SidebarView: View {
  var model: AppModel

  var body: some View {
    VStack(spacing: 0) {
      header
      searchField
      sections
      pluginsButton
      profileButton
    }
    .background(Palette.sidebar)
  }

  private var header: some View {
    HStack {
      Spacer()
    }
    .padding(.horizontal, 14)
    .frame(height: 52)
    .padding(.leading, 72)
    .padding(.trailing, 14)
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 12))
        .foregroundStyle(Palette.inkTertiary)
      TextField("Search", text: model.searchBinding)
        .textFieldStyle(.plain)
        .font(Typography.meta)
        .accessibilityLabel("Search agents")
      if !model.searchText.isEmpty {
        Button { model.searchText = "" } label: {
          Image(systemName: "xmark.circle.fill")
            .foregroundStyle(Palette.inkTertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.horizontal, 12)
    .frame(height: 32)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.bottom, 14)
  }

  private var sections: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 4) {
          sectionTitle("Agents")
          if model.filteredAgents.isEmpty {
            sectionEmpty(model.searchText.isEmpty ? "No agents available" : "No matching agents")
          } else {
            ForEach(model.filteredAgents) { agent in agentRow(agent) }
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 12)
    }
    .scrollContentBackground(.hidden)
    .frame(maxHeight: .infinity)
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title)
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(Palette.inkTertiary)
      .padding(.horizontal, 12)
      .padding(.top, 2)
      .padding(.bottom, 5)
  }

  private func sectionEmpty(_ message: String) -> some View {
    Text(message)
      .font(Typography.meta)
      .foregroundStyle(Palette.inkTertiary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func agentRow(_ agent: AgentInfo) -> some View {
    let selected = model.conversation.agentID == agent.id
    let unreadBlocks = model.unreadBlocks(for: agent.id)
    return Button { model.selectAgent(agent) } label: {
      HStack(spacing: 10) {
        SidebarAgentBadge(agent: agent, size: 36)
        VStack(alignment: .leading, spacing: 3) {
          Text(agent.name)
            .font(Typography.rowTitle)
            .foregroundStyle(Palette.ink)
            .lineLimit(1)
          Text(agent.model ?? "Assistant")
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        if let state = model.agentStates[agent.id], state != "idle" {
          Circle()
            .fill(state == "working" ? Palette.ember : (state == "waiting" ? Palette.amber : Palette.emberDeep))
            .frame(width: 6, height: 6)
            .accessibilityLabel(state)
        }
        if unreadBlocks {
          Circle().fill(Palette.ember).frame(width: 6, height: 6)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? Palette.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open \(agent.name) chat")
    .contextMenu {
      Button("Open chat") { model.selectAgent(agent) }
    }
  }

  private var pluginsButton: some View {
    Button { model.isSettingsPresented = true } label: {
      HStack(spacing: 8) {
        Image(systemName: "puzzlepiece.extension")
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(Palette.ember)
          .frame(width: 28, height: 28)
          .background(Palette.ember.opacity(0.15), in: Circle())
        Text("Plugins")
          .font(Typography.meta.weight(.medium))
          .foregroundStyle(Palette.ink)
          .lineLimit(1)
        Spacer(minLength: 0)
        let connected = model.plugins.filter { $0.status == "connected" }.count
        let total = model.plugins.count
        Text("\(connected)/\(total)")
          .font(Typography.caption.weight(.medium))
          .foregroundStyle(Palette.ember)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Palette.ember.opacity(0.1), in: Capsule())
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Connect plugins (Gmail, Calendar, Drive, Granola, Notion)")
    .accessibilityLabel("Open plugins")
  }

  private var profileButton: some View {
    Button { model.isSettingsPresented = true } label: {
      HStack(spacing: 8) {
        Text(profileInitials)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Color(hex: 0xA1A1AA))
          .frame(width: 28, height: 28)
          .background(Palette.surfaceRaised, in: Circle())
        Text(profileName)
          .font(Typography.meta)
          .foregroundStyle(Color(hex: 0xD4D4D8))
          .lineLimit(1)
        Spacer(minLength: 0)
        if !model.connectionState.isReady {
          Image(systemName: "circle.fill")
            .font(.system(size: 7))
            .foregroundStyle(.orange)
            .help(connectionStatus)
        }
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(Palette.inkTertiary)
      }
      .padding(.horizontal, 16)
      .frame(height: 52)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Settings, providers, and connection")
    .accessibilityLabel("Open settings for \(profileName)")
  }

  private var profileName: String {
    let device = model.settings.deviceName
    if let range = device.range(of: "'s ") { return String(device[..<range.lowerBound]) }
    return device.isEmpty ? "This Mac" : device
  }

  private var profileInitials: String {
    String(profileName.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
  }

  private var connectionStatus: String {
    switch model.connectionState {
    case .ready: "Connected"
    case .connecting, .handshaking: "Connecting…"
    case .waiting(let attempt, _, _): "Reconnecting · attempt \(attempt)"
    case .refused: "Needs attention"
    case .idle: "Starting"
    case .stopped: "Disconnected"
    }
  }
}
