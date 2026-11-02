/**
 * Centred bot identity with conversation actions available on demand.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct ThreadHeader: View {
  var model: AppModel
  var toggleSidebar: (() -> Void)? = nil
  var isConnectionPopoverPresented = State(wrappedValue: false)
  var isSharePopoverPresented = State(wrappedValue: false)
  var isBotInfoPresented = State(wrappedValue: false)

  var body: some View {
    ZStack {
      Button { isBotInfoPresented.wrappedValue = true } label: {
      VStack(spacing: 4) {
        SidebarAgentBadge(agent: model.agent, size: 36)
        Text(model.agent?.name ?? "New Bot").font(Typography.meta).fontWeight(.semibold).lineLimit(1)
        if model.conversation.isStreaming { Text("Writing…").font(Typography.caption).foregroundStyle(Palette.inkSecondary) }
      }.padding(.horizontal, 70)
      }.buttonStyle(.plain).accessibilityLabel("Open bot profile")
        .popover(isPresented: isBotInfoPresented.projectedValue) {
          VStack(alignment: .leading, spacing: 12) {
            Text(model.agent?.name ?? "New Bot").font(Typography.title)
            if let name = model.agent?.model { Text(name).font(Typography.meta).foregroundStyle(Palette.inkSecondary) }
            if let tools = model.agent?.tools, !tools.isEmpty { Text(tools.joined(separator: ", ")).font(Typography.caption).textSelection(.enabled) }
          }.padding(18).frame(minWidth: 220, maxWidth: 320)
        }
      HStack {
        Button { toggleSidebar?() } label: { Image(systemName: "sidebar.left").frame(width: 34, height: 34) }
          .buttonStyle(.plain).accessibilityLabel("Toggle sidebar")
        Spacer()
        Menu {
          Button("Export conversation") { model.exportConversation(); isSharePopoverPresented.wrappedValue = true }
          Button("Server connection") { isConnectionPopoverPresented.wrappedValue = true }
          Button("Switch bot") { model.isAgentSwitcherPresented = true }
        } label: {
          Image(systemName: "ellipsis").frame(width: 34, height: 34)
            .background(Palette.surface, in: Circle())
        }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Conversation options")
      }
    }
    .padding(.horizontal, 20)
    .frame(maxWidth: .infinity)
    .background {
      if model.appearance.transparency == "off" { Palette.canvas }
      else { Palette.canvas.opacity(0.94) }
    }
    .popover(isPresented: isSharePopoverPresented.projectedValue, arrowEdge: .top) {
      SharePopover(model: model) { isSharePopoverPresented.wrappedValue = false }
    }
    .popover(isPresented: isConnectionPopoverPresented.projectedValue, arrowEdge: .top) {
      ConnectionPopover(model: model) { isConnectionPopoverPresented.wrappedValue = false }
    }
  }
}

private struct SharePopover: View {
  var model: AppModel
  var dismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Share this conversation").font(Typography.rowTitle)
      if model.isExporting {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Rendering the document…").font(Typography.meta).foregroundStyle(Palette.inkSecondary)
        }
      } else if let error = model.exportError {
        Text(error)
          .font(Typography.meta)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      } else if let link = model.exportedLink {
        Text("A single HTML file with everything in this conversation — what was said, what was run, and what was asked for approval.")
          .font(Typography.meta)
          .foregroundStyle(Palette.inkSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Text(link.url)
          .font(Typography.machine)
          .foregroundStyle(Palette.ink)
          .textSelection(.enabled)
          .lineLimit(2)
          .truncationMode(.middle)
        Text("\(link.records) records")
          .font(Typography.caption)
          .foregroundStyle(Palette.inkTertiary)
        HStack(spacing: 10) {
          Button("Copy link") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(link.url, forType: .string)
          }
          .buttonStyle(.borderedProminent)
          Button("Open") {
            if let url = URL(string: link.url) { NSWorkspace.shared.open(url) }
          }
          .buttonStyle(.bordered)
        }
        .controlSize(.small)
      }
    }
    .padding(14)
    .frame(minWidth: 300, alignment: .leading)
    .background(Palette.surface)
  }
}

private struct ConnectionPopover: View {
  var model: AppModel
  var dismiss: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        PresenceDot(isOnline: model.connectionState.isReady)
        Text(stateTitle).font(Typography.rowTitle)
      }
      Text(model.serverAddress)
        .font(Typography.machine)
        .foregroundStyle(Palette.inkSecondary)
        .textSelection(.enabled)
      if let health = model.health {
        Text("\(AgniFormat.uptime(health.uptimeMs)) · \(health.providers.filter(\.available).count) of \(health.providers.count) providers available")
          .font(Typography.meta)
          .foregroundStyle(Palette.inkSecondary)
      } else if let error = model.healthError {
        Text(error).font(Typography.meta).foregroundStyle(.orange)
      }
      Button("Connection settings…") {
        dismiss()
        model.editConnection()
      }
      .buttonStyle(.link)
      .font(Typography.meta)
    }
    .padding(14)
    .frame(minWidth: 260, alignment: .leading)
    .background(Palette.surface)
  }

  private var stateTitle: String {
    switch model.connectionState {
    case .ready: "Agni is connected"
    case .connecting, .handshaking: "Connecting to Agni…"
    case .waiting(let attempt, _, _): "Reconnecting · attempt \(attempt)"
    case .refused: "Connection needs attention"
    case .idle, .stopped: "Agni is disconnected"
    }
  }
}

struct AgentSwitcherView: View {
  var model: AppModel
  var onClose: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Switch agent")
        .font(Typography.title)
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 10)

      ForEach(model.agents) { agent in
        Button {
          model.selectAgent(agent)
          onClose()
        } label: {
          HStack(spacing: 10) {
            AgentAvatar(agent: agent, size: .medium)
            VStack(alignment: .leading, spacing: 2) {
              Text(agent.name).font(Typography.rowTitle)
              Text(agent.model ?? "task lane")
                .font(Typography.machine)
                .foregroundStyle(Palette.inkSecondary)
            }
            Spacer(minLength: 0)
            if agent.id == model.conversation.agentID {
              Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Palette.ember)
            }
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 9)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }

      Spacer(minLength: 8)
      Button("Close") { onClose() }
        .buttonStyle(.bordered)
        .keyboardShortcut(.cancelAction)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .frame(width: 340)
    .background(Palette.canvas)
    .foregroundStyle(Palette.ink)
  }
}
