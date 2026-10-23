/**
 * The thread: transcript, anything waiting for you, the composer, and a quiet
 * status strip. Prose is left-aligned in a capped measure; only day dividers
 * and system notes centre, because they belong to the thread, not to a person.
 */
import SwiftUI
import AppKit
import AgniKit
import AgniProtocol

private struct TranscriptScrollState: Equatable {
  var offsetY: CGFloat
  var isAtBottom: Bool
}

struct ThreadView: View {
  var model: AppModel
  var composerFocused = FocusState<Bool>()
  var pinnedToBottom = State(wrappedValue: true)
  var selectedMessageIDs = State(wrappedValue: Set<String>())

  var body: some View {
    VStack(spacing: 0) {
      if model.conversation.messages.isEmpty {
        emptyState
      } else {
        transcript
      }
      PendingInbox(model: model)
      if let status = model.statusText {
        HStack(spacing: 8) {
          Circle()
            .fill(Palette.ember)
            .frame(width: 6, height: 6)
            .symbolEffect(.pulse, options: .repeating)
          Text(status).font(Typography.meta).foregroundStyle(Palette.inkSecondary)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.gutter + 8)
        .padding(.vertical, 6)
      }
      if !selectedMessageIDs.wrappedValue.isEmpty {
        selectionBar
      }
      ComposerView(model: model, composerFocused: composerFocused, draft: draft.projectedValue)
    }
    .background(AppearanceRuntime.profile.background.kind == "none" ? Palette.canvas : Color.clear)
    .onChange(of: model.focusComposerToken) { _, _ in composerFocused.wrappedValue = true }
  }

  var draft = State(wrappedValue: "")

  // MARK: transcript

  private var transcript: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          Color.clear.frame(height: 1).id(topAnchor)
          ForEach(Array(model.conversation.messages.enumerated()), id: \.element.id) { index, message in
            if isNewDay(index: index) {
              DayDivider(label: index == 0 ? AgniFormat.stamp(message.createdAt ?? Date()) : AgniFormat.dayTitle(message.createdAt ?? Date()))
            }
            MessageRowView(
              message: message,
              agent: model.agent,
              isSelected: selectedMessageIDs.wrappedValue.contains(message.id),
              onSelect: { toggleSelection(message.id) },
              onNotice: { model.dismissToast() },
              onRename: { model.renameAgent($0) }
            )
          }
          Color.clear.frame(height: 1).id(bottomAnchor)
        }
        .padding(.horizontal, Metrics.gutter + 6)
        .padding(.top, 18)
        .padding(.bottom, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .defaultScrollAnchor(.bottom)
      .onScrollGeometryChange(for: TranscriptScrollState.self) { geometry in
        TranscriptScrollState(
          offsetY: geometry.contentOffset.y,
          isAtBottom: geometry.contentOffset.y + geometry.containerSize.height >= geometry.contentSize.height - 48
        )
      } action: { previous, current in
        // Content growth changes contentSize without meaning the user scrolled
        // away. Only update the pin when the scroll offset itself moves.
        if abs(current.offsetY - previous.offsetY) > 1 {
          pinnedToBottom.wrappedValue = current.isAtBottom
        }
      }
      .onAppear {
        pinnedToBottom.wrappedValue = true
        Task { @MainActor in
          await Task.yield()
          proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
      }
      .onChange(of: streamingText) { _, _ in
        guard pinnedToBottom.wrappedValue else { return }
        Task { @MainActor in
          await Task.yield()
          proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
      }
      .onChange(of: model.conversation.messages.count) { _, _ in
        if model.conversation.messages.last?.role == .user {
          pinnedToBottom.wrappedValue = true
        }
        guard pinnedToBottom.wrappedValue else { return }
        Task { @MainActor in
          await Task.yield()
          proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
      }
      .onChange(of: model.conversation.threadID) { _, _ in
        pinnedToBottom.wrappedValue = true
        Task { @MainActor in
          await Task.yield()
          proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var streamingText: String {
    guard let id = model.conversation.streamingMessageID,
      let message = model.conversation.messages.first(where: { $0.id == id })
    else { return "" }
    return message.text
  }

  private let bottomAnchor = "agni.bottom"
  private let topAnchor = "agni.top"

  private var selectionBar: some View {
    HStack(spacing: 12) {
      Text("\(selectedMessageIDs.wrappedValue.count) selected")
        .font(Typography.meta)
        .foregroundStyle(Palette.inkSecondary)
      Spacer()
      Button("Copy") {
        let selected = model.conversation.messages.filter { selectedMessageIDs.wrappedValue.contains($0.id) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(selected.map(\.text).joined(separator: "\n\n"), forType: .string)
        selectedMessageIDs.wrappedValue.removeAll()
      }
      .buttonStyle(.borderedProminent)
      .tint(Palette.ember)
      Button("Cancel") { selectedMessageIDs.wrappedValue.removeAll() }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.inkSecondary)
    }
    .padding(.horizontal, Metrics.gutter + 6)
    .padding(.vertical, 8)
    .frame(maxWidth: Metrics.measure + 60)
    .background(Palette.surfaceRaised, in: Capsule())
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity)
  }

  private func toggleSelection(_ id: String) {
    if selectedMessageIDs.wrappedValue.contains(id) {
      selectedMessageIDs.wrappedValue.remove(id)
    } else {
      selectedMessageIDs.wrappedValue.insert(id)
    }
  }

  private func isNewDay(index: Int) -> Bool {
    let messages = model.conversation.messages
    guard index < messages.count, let date = messages[index].createdAt else { return false }
    if index == 0 { return true }
    guard let previous = messages[index - 1].createdAt else { return true }
    return !Calendar.current.isDate(previous, inSameDayAs: date)
  }

  private var emptyState: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      Text("Message \(model.agent?.name ?? "Agni") — one conversation, it never resets")
        .font(Typography.meta)
        .foregroundStyle(Palette.inkTertiary)
      Spacer().frame(height: 28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, Metrics.gutter + 6)
  }
}

/// Anything blocking the agent's next move sits directly above the composer.
private struct PendingInbox: View {
  var model: AppModel

  var body: some View {
    let approvals = model.conversation.openApprovals
    let forms = model.conversation.openForms
    if !approvals.isEmpty || !forms.isEmpty {
      VStack(spacing: 10) {
        ForEach(approvals) { approval in
          ApprovalCard(approval: approval) { decision in
            model.answer(approval: approval, decision: decision)
          }
        }
        ForEach(forms) { form in
          FormCard(form: form) { option in
            model.answer(form: form, option: option)
          }
        }
      }
      .frame(maxWidth: Metrics.measure + 60)
      .padding(.horizontal, Metrics.gutter + 6)
      .padding(.bottom, 12)
      .frame(maxWidth: .infinity, alignment: .center)
      .transition(.move(edge: .bottom).combined(with: .opacity))
    }
  }
}

private struct ApprovalCard: View {
  var approval: ApprovalRow
  var answer: (Decision) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "hand.raised.fill")
          .font(.system(size: 12))
          .foregroundStyle(Palette.ember)
        Text("Agni wants to run something")
          .font(Typography.rowTitle)
        Spacer(minLength: 0)
        Text(approval.id)
          .font(Typography.machine)
          .foregroundStyle(Palette.inkTertiary)
      }
      Text(approval.action)
        .font(Typography.code)
        .foregroundStyle(Palette.ink)
        .textSelection(.enabled)
      if !approval.preview.isEmpty {
        Text(approval.preview)
          .font(Typography.code)
          .foregroundStyle(Palette.inkSecondary)
          .lineLimit(6)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Palette.canvas, in: RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
          )
          .textSelection(.enabled)
      }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        ForEach(approval.decisions, id: \.wire) { decision in
          if decision == .once {
            Button(decision.title) { answer(decision) }
              .buttonStyle(.borderedProminent)
              .tint(Palette.ember)
          } else {
            Button(decision.title) { answer(decision) }
              .buttonStyle(.bordered)
          }
        }
      }
    }
    .padding(14)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
    )
  }
}

private struct FormCard: View {
  var form: FormRow
  var answer: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "questionmark.bubble.fill")
          .font(.system(size: 12))
          .foregroundStyle(Palette.amber)
        Text(self.form.question)
          .font(Typography.rowTitle)
        Spacer(minLength: 0)
      }
      if !form.options.isEmpty {
        HStack(spacing: 8) {
          ForEach(form.options, id: \.self) { option in
            Button(option) { answer(option) }
              .buttonStyle(.bordered)
          }
          Spacer(minLength: 0)
        }
      }
      Text("Or answer in your own words below.")
        .font(Typography.caption)
        .foregroundStyle(Palette.inkTertiary)
    }
    .padding(14)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous).stroke(Palette.hairline, lineWidth: 1)
    )
  }
}

private struct DayDivider: View {
  var label: String

  var body: some View {
    Text(label)
      .font(Typography.caption)
      .foregroundStyle(Palette.inkSecondary)
      .frame(maxWidth: .infinity, alignment: .center)
    .padding(.vertical, 4)
    .accessibilityLabel(label)
  }
}
