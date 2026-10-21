/**
 * One row of the transcript. A person's message is a bubble on the right;
 * the assistant's reply is unfilled prose in a quiet bubble, so long answers
 * read like something written to you rather than a card that was delivered.
 *
 * The name is never spelled out again — the header already says who you are
 * talking to, and a thread is a conversation, not a stack of labels.
 *
 * Tool activity is deliberately not rendered. The transcript answers "what did
 * I ask and what came back"; the mechanics of a turn (which tool, which
 * arguments, how long it took) are diagnostics, not conversation, and the app
 * still carries them in the durable records for anyone debugging. Progress is
 * shown by the status pill, and a turn that produced nothing says why.
 */
import SwiftUI
import AppKit
import AgniKit
import AgniProtocol

struct MessageRowView: View {
  var message: ChatMessage
  var agent: AgentInfo?
  var isSelected = false
  var onSelect: () -> Void = {}
  var onNotice: () -> Void
  var onRename: (String) -> Void = { _ in }
  var preferredName = State(wrappedValue: "")
  /// Whether the activity strip is expanded.
  var activityOpen = State(wrappedValue: false)

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch message.role {
      case .user:
        userBubble
      case .assistant:
        assistantProse
      case .system:
        if message.uiHint == "handoff_notice" {
          handoffNotice
        } else if message.text.isEmpty {
          // A record with nothing to read — tool activity is kept in the
          // durable log but deliberately not rendered, so a row that only ever
          // held tools collapses instead of leaving a blank gap.
          EmptyView()
        } else {
          systemNote
        }
      }
      if message.uiHint == "onboarding_name_prompt" {
        HStack(spacing: 8) {
          TextField("Type your preferred name…", text: preferredName.projectedValue)
            .textFieldStyle(.roundedBorder)
            .onSubmit(saveName)
          Button("Save", action: saveName)
            .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: 420, alignment: .leading)
      }
      if message.uiHint == "onboarding_completed" {
        // The name is settled: the field is gone and the thread says so.
        HStack(spacing: 6) {
          Image(systemName: "checkmark")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Palette.ember)
          Text("Renamed to \(message.senderName ?? "your assistant")")
            .font(Typography.caption)
            .foregroundStyle(Palette.inkSecondary)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 5)
        .background(Palette.surfaceRaised, in: Capsule())
        .frame(maxWidth: .infinity, alignment: .center)
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    .padding(.horizontal, isSelected ? 5 : 0)
    .padding(.vertical, isSelected ? 4 : 0)
    .background(isSelected ? Palette.ember.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 12))
    .contextMenu {
      Button(isSelected ? "Deselect message" : "Select message", systemImage: isSelected ? "checkmark.circle" : "text.cursor") {
        onSelect()
      }
      Button("Copy message", systemImage: "doc.on.doc") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(message.text, forType: .string)
      }
    }
  }

  private func saveName() {
    let name = preferredName.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return }
    onRename(name)
    preferredName.wrappedValue = ""
  }

  // MARK: user

  private var userBubble: some View {
    VStack(alignment: .trailing, spacing: 4) {
      VStack(alignment: .leading, spacing: 5) {
        Text(message.text)
          .font(Typography.body)
          .foregroundStyle(Color(hex: 0x18181B))
          .textSelection(.enabled)
        if case .failed(let reason) = message.state {
          Text(reason)
            .font(Typography.caption)
            .foregroundStyle(Color(hex: 0x55554F))
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(Palette.outgoingBubble, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
      .frame(maxWidth: 520, alignment: .trailing)
    }
  }

  // MARK: assistant

  private var assistantProse: some View {
    VStack(alignment: .leading, spacing: 8) {
      if message.text.isEmpty && message.isStreaming {
        HStack(spacing: 8) {
          ThinkingDots()
          Text("Thinking")
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Palette.surfaceRaised, in: Capsule())
      } else if !message.text.isEmpty {
        ProseText(text: message.text)
      } else if case .failed(let reason) = message.state {
        Text(reason)
          .font(Typography.body)
          .foregroundStyle(Palette.ink)
      } else {
        // A turn that ends with nothing to read has to account for itself.
        Text(failureText)
          .font(Typography.body)
          .foregroundStyle(Palette.ink)
      }
      if let explanation = message.stopExplanation, !message.text.isEmpty {
        Text("Response didn't finish · \(explanation)")
          .font(Typography.caption)
          .foregroundStyle(Palette.inkSecondary)
      }
      if !message.tools.isEmpty {
        activityStrip
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: 620, alignment: .leading)
    .background(Palette.incomingBubble, in: RoundedRectangle(cornerRadius: Metrics.bubbleRadius, style: .continuous))
  }

  /// The activity strip: what the agent did, quietly. One line until the
  /// owner wants to see it — the transcript answers "what did I ask and what
  /// came back", this is the progress behind it.
  private var activityStrip: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        activityOpen.wrappedValue.toggle()
      } label: {
        Text(activitySummary)
          .font(Typography.caption)
          .foregroundStyle(Palette.inkTertiary)
      }
      .buttonStyle(.plain)
      if activityOpen.wrappedValue {
        ForEach(message.tools) { tool in
          HStack(spacing: 8) {
            Text(tool.name)
              .font(Typography.caption)
              .foregroundStyle(isFailed(tool) ? Palette.ember : Palette.inkSecondary)
            if let preview = tool.preview, !preview.isEmpty {
              Text(preview)
                .font(Typography.caption)
                .foregroundStyle(Palette.inkTertiary)
                .lineLimit(1)
            }
          }
        }
      }
    }
  }

  private func isFailed(_ tool: ToolActivity) -> Bool {
    if case .failed = tool.state { return true }
    return false
  }

  private var activitySummary: String {
    if let running = message.tools.first(where: { tool in
      if case .running = tool.state { return true }
      return false
    }) {
      return "Working · \(running.name)"
    }
    let failed = message.tools.filter(isFailed).count
    let steps = message.tools.count
    let suffix = failed > 0 ? " · \(failed) failed" : ""
    return "\(steps) step\(steps == 1 ? "" : "s")\(suffix)"
  }

  /// The empty row's account of itself. A stopped turn names its reason; when
  /// even that is missing, say so plainly and point at the records rather than
  /// leaving the owner staring at a prompt that never answered.
  private var failureText: String {
    if let explanation = message.stopExplanation {
      return "No reply — \(explanation.lowercased())."
    }
    return "\(agent?.name ?? "The assistant") produced no reply, and the daemon recorded no reason. Ask it to share this thread to see the records."
  }

  // MARK: system

  private var systemNote: some View {
    Text(message.text)
      .font(Typography.meta)
      .foregroundStyle(Palette.inkSecondary)
      .padding(.vertical, 2)
  }

  /// "Bahu → Researcher: <brief>" — the routing is stated plainly and the brief
  /// sits quieter beside it, so a delegated turn reads as a sequence (who was
  /// asked, what for, then what came back) rather than a run-on status line.
  private var handoffNotice: some View {
    HStack(spacing: 6) {
      Text(handoffParts.flow)
        .font(Typography.caption)
        .foregroundStyle(Palette.inkSecondary)
        .lineLimit(1)
      if let brief = handoffParts.brief {
        Text(brief)
          .font(Typography.caption)
          .foregroundStyle(Palette.inkTertiary)
          .lineLimit(2)
      }
    }
    .padding(.horizontal, 11)
    .padding(.vertical, 6)
    .background(Palette.surfaceRaised, in: Capsule())
    .frame(maxWidth: .infinity, alignment: .center)
  }

  private var handoffParts: (flow: String, brief: String?) {
    guard let colon = message.text.firstIndex(of: ":") else { return (message.text, nil) }
    let flow = String(message.text[message.text.startIndex..<colon])
    let brief = message.text[message.text.index(after: colon)...].trimmingCharacters(in: .whitespaces)
    return (flow, brief.isEmpty ? nil : brief)
  }
}

/// Prose with inline code and links honoured while tokens stream into place.
struct ProseText: View {
  var text: String

  var body: some View {
    Text(attributed)
      .font(Typography.body)
      .lineSpacing(4)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
  }

  /// Runtime markdown, inline only: bold, italic, code, links.
  private var attributed: AttributedString {
    (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
  }
}

/// Three dots while the first token is on its way.
struct ThinkingDots: View {
  var phase = State(wrappedValue: 0)
  var reduceMotion = Environment(\.accessibilityReduceMotion)

  var body: some View {
    HStack(spacing: 4) {
      ForEach(0..<3, id: \.self) { index in
        Circle()
          .fill(Palette.inkTertiary)
          .frame(width: 5, height: 5)
          .opacity(phase.wrappedValue == index ? 0.95 : 0.35)
      }
    }
    .accessibilityLabel("Agni is thinking")
    .onAppear {
      guard !reduceMotion.wrappedValue else { return }
      withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { phase.wrappedValue = 1 }
      Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
        Task { @MainActor in phase.wrappedValue = (phase.wrappedValue + 1) % 3 }
      }
    }
  }
}
