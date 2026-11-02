/** A full-width, bottom-anchored chat composer with slash commands above. */
import SwiftUI
import AgniKit

struct ComposerView: View {
  var model: AppModel
  var composerFocused: FocusState<Bool>
  var draft: Binding<String>
  var isActionsPresented = State(wrappedValue: false)

  struct Command: Identifiable {
    var id: String { trigger }
    var trigger: String
    var title: String
    var subtitle: String
    var action: () -> Void
  }

  var commands: [Command] {
    [
      Command(trigger: "agent", title: "Switch agent…", subtitle: "Another conversation surface") {
        model.isAgentSwitcherPresented = true
      },
    ]
  }

  var filteredCommands: [Command] {
    let raw = draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard raw.hasPrefix("/") else { return [] }
    let term = String(raw.dropFirst()).lowercased()
    return commands.filter {
      $0.trigger.hasPrefix(term) || $0.title.lowercased().contains(term)
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !filteredCommands.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(filteredCommands) { command in
            Button {
              draft.wrappedValue = ""
              command.action()
            } label: {
              HStack {
                Text("/\(command.trigger)")
                  .font(Typography.machine)
                  .foregroundStyle(Palette.inkSecondary)
                Text(command.title)
                  .font(Typography.body)
                  .foregroundStyle(Palette.ink)
                Spacer(minLength: 0)
                Text(command.subtitle)
                  .font(Typography.caption)
                  .foregroundStyle(Palette.inkTertiary)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if command.id != filteredCommands.last?.id {
              Divider().padding(.leading, 10)
            }
          }
        }
        .background(Palette.surfaceRaised, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }

      HStack(alignment: .center, spacing: 10) {
        Button { isActionsPresented.wrappedValue.toggle() } label: {
          Image(systemName: "plus")
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Color(hex: 0xA1A1AA))
            .frame(width: 30, height: 30)
            .background(Palette.surfaceRaised, in: Circle())
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help("Conversation actions")
        .accessibilityLabel("Conversation actions")
        .popover(isPresented: isActionsPresented.projectedValue, arrowEdge: .bottom) {
          VStack(alignment: .leading, spacing: 8) {
            Button("Switch agent…", systemImage: "person.crop.circle") {
              isActionsPresented.wrappedValue = false
              model.isAgentSwitcherPresented = true
            }
            .buttonStyle(.plain)
          }
          .padding(12)
        }

        HStack(alignment: .bottom, spacing: 8) {
        TextField("", text: draft, axis: .vertical)
          .textFieldStyle(.plain)
          .font(Typography.body)
          .foregroundStyle(Palette.ink)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
          .lineLimit(1...4)
          .focused(composerFocused.projectedValue)
          .onChange(of: draft.wrappedValue) { _, value in
            model.updateTypingState(isTyping: !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
          .padding(.vertical, 8)
          .overlay(alignment: .leading) {
            if draft.wrappedValue.isEmpty {
              Text(placeholder)
                .font(Typography.body)
                .foregroundStyle(Palette.inkTertiary)
                .allowsHitTesting(false)
            }
          }
          .accessibilityLabel(placeholder)

        if model.conversation.isStreaming {
          Button { model.stopTurn() } label: {
            Image(systemName: "stop.fill")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(Palette.outgoingInk)
              .frame(width: 32, height: 32)
              .background(Palette.outgoingBubble, in: Circle())
          }
          .buttonStyle(.plain)
          .keyboardShortcut(".", modifiers: .command)
          .help("Stop this turn (⌘.)")
          .accessibilityLabel("Stop")
        } else {
          Button { submit() } label: {
            Image(systemName: "arrow.up")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(Palette.outgoingInk)
              .frame(width: 32, height: 32)
              .background(Palette.outgoingBubble, in: Circle())
          }
          .buttonStyle(.plain)
          // Match the web composer: Return sends, while Shift-Return remains
          // available to the multiline TextField for a line break.
          .keyboardShortcut(.return, modifiers: [])
          .disabled(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .help("Send (Enter); new line (Shift-Enter)")
          .accessibilityLabel("Send")
        }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .frame(minHeight: 44)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Palette.hairline, lineWidth: 1))
      }
    }
    .animation(.snappy(duration: 0.15), value: filteredCommands.count)
    .padding(.horizontal, 20)
    .padding(.top, 12)
    .padding(.bottom, 18)
  }

  private var placeholder: String {
    model.conversation.isStreaming ? "\(model.agent?.name ?? "New Bot") is writing…" : "Message \(model.agent?.name ?? "New Bot")"
  }

  private func submit() {
    let text = draft.wrappedValue
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    if trimmed.hasPrefix("/") {
      if let first = filteredCommands.first {
        draft.wrappedValue = ""
        first.action()
      } else {
        draft.wrappedValue = ""
      }
      return
    }
    draft.wrappedValue = ""
    model.send(text: text)
  }
}
