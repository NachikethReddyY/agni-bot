/**
 * Seamless chat header: current agent/thread at left, connection details on
 * demand at right.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct ThreadHeader: View {
  var model: AppModel
  var isConnectionPopoverPresented = State(wrappedValue: false)
  var isSharePopoverPresented = State(wrappedValue: false)

  var body: some View {
    HStack(spacing: 9) {
      SidebarAgentBadge(agent: model.agent, size: 20)
      VStack(alignment: .leading, spacing: 0) {
        Text(model.agent?.name ?? "Agni")
          .font(Typography.rowTitle)
          .foregroundStyle(Palette.ink)
          .lineLimit(1)
        if model.conversation.isStreaming {
          Text("Writing…")
            .font(Typography.caption)
            .foregroundStyle(Palette.inkSecondary)
        }
      }
      Spacer()
      Button {
        model.exportConversation()
        isSharePopoverPresented.wrappedValue = true
      } label: {
        Image(systemName: "square.and.arrow.up")
          .font(.system(size: 14, weight: .regular))
          .foregroundStyle(Palette.inkSecondary)
          .frame(width: 30, height: 30)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("Share this conversation as a document")
      .accessibilityLabel("Export this conversation")
      .popover(isPresented: isSharePopoverPresented.projectedValue, arrowEdge: .top) {
        SharePopover(model: model) { isSharePopoverPresented.wrappedValue = false }
      }
      Button { isConnectionPopoverPresented.wrappedValue.toggle() } label: {
        Image(systemName: "desktopcomputer")
          .font(.system(size: 14, weight: .regular))
          .foregroundStyle(Palette.inkSecondary)
          .frame(width: 30, height: 30)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .help("Server connection")
      .accessibilityLabel("Server connection details")
      .popover(isPresented: isConnectionPopoverPresented.projectedValue, arrowEdge: .top) {
        ConnectionPopover(model: model) {
          isConnectionPopoverPresented.wrappedValue = false
        }
      }
    }
    .padding(.leading, 18)
    .padding(.trailing, 16)
    .background(Palette.canvas)
    .overlay(alignment: .bottom) {
      Rectangle().fill(Color.white.opacity(0.06)).frame(height: 1)
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
