/**
 * The app: one window, a dark room, a flame.
 */
import AppKit
import SwiftUI

@main
struct AgniApp: App {
  var model: AppModel

  init() {
    let model = AppModel()
    self.model = model
  }

  var body: some Scene {
    WindowGroup("Agni") {
      RootView(model: model)
        .frame(minWidth: 940, minHeight: 560)
        .background(Palette.canvas)
        .preferredColorScheme(model.appearance.mode == "system" ? nil : (model.appearance.mode == "light" ? .light : .dark))
        .ignoresSafeArea(.container, edges: .top)
        .windowConfigurator()
        .task { model.start() }
        .onChange(of: model.conversation.threadID) { _, _ in WindowChrome.retitle(model) }
        .onChange(of: model.conversation.agentID) { _, _ in WindowChrome.retitle(model) }
    }
    .defaultSize(width: 1180, height: 760)
    .windowStyle(.hiddenTitleBar)
    .windowToolbarStyle(.unifiedCompact)
    .commands {
      CommandGroup(replacing: .newItem) { }
      CommandMenu("Agni") {
        Button("Switch agent…") { model.isAgentSwitcherPresented = true }
          .keyboardShortcut("k", modifiers: .command)
        Button(model.isInspectorPresented ? "Hide details" : "Show details") {
          model.isInspectorPresented.toggle()
        }
        .keyboardShortcut("i", modifiers: [.command, .shift])
        Divider()
        Button("Connection settings…") { model.editConnection() }
        Button("Forget this device…") { model.forgetDevice() }
        Divider()
        Button("Reload conversation") { model.reloadConversation() }
          .keyboardShortcut("r", modifiers: [.command, .shift])
      }
    }
  }

}

/// Window chrome: true black, no title text (the transcript names the thread),
/// draggable by its background like every good Mac chat app.
private struct WindowConfigurator: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async {
      guard view.window != nil else { return }
      WindowChrome.configure()
    }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {}
}

extension View {
  func windowConfigurator() -> some View {
    background(WindowConfigurator().frame(width: 0, height: 0))
  }
}
