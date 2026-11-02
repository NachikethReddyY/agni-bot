/**
 * Native two-column chat window: persistent conversation list and a unified
 * message pane. The inspector remains available from the Agni menu.
 */
import SwiftUI
import AgniKit
import AgniProtocol

struct RootView: View {
  var model: AppModel
  var sidebarVisible = State(wrappedValue: true)
  var sidebarWidth = State(wrappedValue: CGFloat(UserDefaults.standard.double(forKey: "agni.sidebar.width") == 0 ? 300 : UserDefaults.standard.double(forKey: "agni.sidebar.width")))
  var resizeStart = State<CGFloat?>(wrappedValue: nil)
  var systemReduceMotion = Environment(\.accessibilityReduceMotion)

  var body: some View {
    ZStack {
      appearanceBackground.ignoresSafeArea()
      switch model.screen {
      case .pairing:
        PairingView(model: model)
      case .chat:
        chat
      }
      if let toast = model.toast { toastOverlay(toast) }
    }
    .preferredColorScheme(model.appearance.mode == "system" ? nil : model.appearance.mode == "dark" ? .dark : .light)
    .environment(\.accessibilityReduceMotion, model.appearance.motion == "system" ? systemReduceMotion.wrappedValue : model.appearance.motion == "reduced")
    .transaction { transaction in
      if model.appearance.motion == "reduced" || (model.appearance.motion == "system" && systemReduceMotion.wrappedValue) { transaction.disablesAnimations = true }
    }
    .foregroundStyle(Palette.ink)
    .sheet(isPresented: model.agentSwitcherBinding) {
      AgentSwitcherView(model: model) { model.agentSwitcherBinding.wrappedValue = false }
    }
    .sheet(isPresented: model.settingsBinding) {
      SettingsView(model: model)
        .frame(minWidth: 680, minHeight: 560)
    }
  }

  private var chat: some View {
    HStack(spacing: 0) {
      if sidebarVisible.wrappedValue {
        SidebarView(model: model).frame(width: sidebarWidth.wrappedValue)
        Rectangle().fill(Palette.hairline).frame(width: 5)
          .gesture(DragGesture().onChanged { value in
            if resizeStart.wrappedValue == nil { resizeStart.wrappedValue = sidebarWidth.wrappedValue }
            sidebarWidth.wrappedValue = min(380, max(260, (resizeStart.wrappedValue ?? 300) + value.translation.width))
          }.onEnded { _ in
            resizeStart.wrappedValue = nil
            UserDefaults.standard.set(Double(sidebarWidth.wrappedValue), forKey: "agni.sidebar.width")
          })
          .accessibilityLabel("Sidebar width")
          .accessibilityAdjustableAction { direction in
            switch direction { case .increment: sidebarWidth.wrappedValue = min(380, sidebarWidth.wrappedValue + 10); case .decrement: sidebarWidth.wrappedValue = max(260, sidebarWidth.wrappedValue - 10); @unknown default: break }
          }
      }
      VStack(spacing: 0) {
        ThreadHeader(model: model, toggleSidebar: { sidebarVisible.wrappedValue.toggle() })
          .frame(height: 96)
        ThreadView(model: model)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(model.appearance.background.kind == "none" ? Palette.canvas : Palette.canvas.opacity(0.28))
    }
    .background(model.appearance.background.kind == "none" ? Palette.canvas : Color.clear)
  }

  private var appearanceBackground: some View {
    AppearanceBackgroundView(background: model.appearance.background, image: model.backgroundImage)
  }

  private func toastOverlay(_ toast: NoticeRow) -> some View {
    VStack {
      Spacer()
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: toast.kind == .failure ? "exclamationmark.triangle.fill" : "bell.badge.fill")
          .font(.system(size: 13))
          .foregroundStyle(toast.kind == .failure ? Color.orange : Palette.ember)
        VStack(alignment: .leading, spacing: 2) {
          Text(toast.title).font(Typography.rowTitle)
          Text(toast.body)
            .font(Typography.meta)
            .foregroundStyle(Palette.inkSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        Button { model.dismissToast() } label: {
          Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.inkTertiary)
        .accessibilityLabel("Dismiss")
      }
      .padding(12)
      .frame(maxWidth: 420)
      .background(Palette.surfaceRaised, in: RoundedRectangle(cornerRadius: Metrics.cardRadius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: Metrics.cardRadius).stroke(Palette.hairline, lineWidth: 1))
      .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
      .padding(.bottom, 24)
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .onTapGesture { model.dismissToast() }
    }
    .animation(.snappy(duration: 0.22), value: toast.id)
  }
}
