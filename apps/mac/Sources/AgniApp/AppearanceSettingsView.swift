import SwiftUI
import AppKit
import AgniProtocol
import UniformTypeIdentifiers

private let appearanceGradients: [(String, String, String, Double)] = [
  ("Dusk", "#111827", "#3b1520", 135), ("Ocean", "#052e38", "#172554", 135),
  ("Forest", "#052e16", "#143b3b", 90), ("Lavender", "#241342", "#492136", 45)
]

struct AppearanceSettingsView: View {
  var model: AppModel
  var busy = State(wrappedValue: false)
  var error = State<String?>(wrappedValue: nil)

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        Text("Changes appear instantly.").font(Typography.meta)
        Spacer()
        Text(model.appearanceSaveStatus).font(Typography.caption).foregroundStyle(Palette.inkSecondary)
        if model.appearanceSaveStatus == "Could not sync changes" { Button("Retry save") { model.retryAppearanceSave() } }
      }
      themeControls
      Divider()
      colourControls
      Divider()
      backgroundControls
      Divider()
      DisclosureGroup("More options") {
        VStack(spacing: 12) {
          AppearanceColourControl(label: "Outgoing bubble", value: model.appearance.bubbleColor ?? "#0070e8") { hex in update { $0.bubbleColor = hex } }
          HStack {
            Text("Conversation width"); Spacer()
            Picker("Conversation width", selection: Binding(get: { model.appearance.conversationWidth ?? "wide" }, set: { value in update { $0.conversationWidth = value } })) { Text("Comfortable").tag("comfortable"); Text("Wide").tag("wide") }.labelsHidden()
          }
          HStack {
            Text("Transparency"); Spacer()
            Picker("Transparency", selection: Binding(get: { model.appearance.transparency ?? "subtle" }, set: { value in update { $0.transparency = value } })) { Text("Subtle").tag("subtle"); Text("Off").tag("off") }.labelsHidden()
          }
          choice("Text size", \.textScale, ["small", "default", "large"])
          choice("Density", \.density, ["compact", "comfortable"])
          choice("Corners", \.corners, ["square", "standard", "soft"])
          choice("Motion", \.motion, ["system", "full", "reduced"])
          choice("Bot colour", \.agentTint, ["full", "subtle", "off"])
        }.padding(.top, 12)
      }
      HStack {
        Button { model.undoAppearance() } label: { Label("Undo", systemImage: "arrow.uturn.backward") }
          .disabled(model.appearanceHistory.isEmpty)
        Button { model.resetAppearance() } label: { Label("Reset appearance", systemImage: "arrow.counterclockwise") }
      }
      if let error = error.wrappedValue { Text(error).font(Typography.caption).foregroundStyle(.orange) }
    }
    .onDisappear { model.endAppearanceAdjustment() }
  }

  private var themeControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Theme").font(Typography.title)
      choice("Theme", \.preset, ["agni", "midnight", "graphite", "paper", "ocean", "forest", "warm"])
      choice("Mode", \.mode, ["system", "dark", "light"])
    }
  }

  private var colourControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Colours").font(Typography.title)
      HStack(spacing: 12) {
        ForEach(["ember", "amber", "ocean", "forest", "violet", "rose", "mono"], id: \.self) { name in
          Button { update { $0.accent = name } } label: {
            Circle().fill(Color(serverHex: AppearanceRuntime.accentHex(name)))
              .frame(width: 26, height: 26)
              .overlay(Circle().stroke(model.appearance.accent == name ? Palette.ink : Color.clear, lineWidth: 2))
          }.buttonStyle(.plain).help(name.capitalized).accessibilityLabel(name.capitalized)
        }
      }
      AppearanceColourControl(label: "Custom accent", value: AppearanceRuntime.accentHex) { hex in
        update { $0.accent = "custom"; $0.customAccent = hex }
      }
      HStack {
        Text("Sample accent text").foregroundStyle(Palette.ember)
        Text("Sample button").padding(.horizontal, 12).padding(.vertical, 7)
          .foregroundStyle(Color(serverHex: AppearanceRuntime.buttonInk))
          .background(Palette.ember, in: RoundedRectangle(cornerRadius: Metrics.rowRadius))
      }.font(Typography.meta)
      let ratio = AppearanceRuntime.contrast(AppearanceRuntime.accentHex, Palette.surface)
      Text(String(format: "Text contrast %.1f:1", ratio)).font(Typography.caption).foregroundStyle(Palette.inkSecondary)
      if ratio < 4.5 {
        Text("This accent may be hard to read as small text on the theme surface. Try a lighter or darker colour.")
          .font(Typography.caption).foregroundStyle(Palette.inkSecondary)
      }
    }
  }

  private var backgroundControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Background").font(Typography.title)
      HStack {
        Button("None") { update { $0.background = AppearanceBackground(kind: "none") } }
        Button("Solid") { update { $0.background = AppearanceBackground(kind: "solid", color: "#111827") } }
        Button("Gradient") { update { $0.background = AppearanceBackground(kind: "gradient", from: "#111827", to: "#3b1520", angle: 135) } }
        Button(busy.wrappedValue ? "Preparing…" : "Choose image…") { chooseBackground() }.disabled(busy.wrappedValue)
      }
      if model.appearance.background.kind == "solid" {
        AppearanceColourControl(label: "Background colour", value: model.appearance.background.color ?? "#111827") { hex in update { $0.background.color = hex } }
      }
      if model.appearance.background.kind == "gradient" { gradientControls }
      if model.appearance.background.kind == "image" { imageControls }
    }
  }

  private var gradientControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        ForEach(appearanceGradients, id: \.0) { preset in
          Button {
            update { $0.background = AppearanceBackground(kind: "gradient", from: preset.1, to: preset.2, angle: preset.3) }
          } label: {
            Text(preset.0).font(Typography.meta).foregroundStyle(.white)
              .padding(10).frame(maxWidth: .infinity)
              .background(AppearanceBackgroundView(background: AppearanceBackground(kind: "gradient", from: preset.1, to: preset.2, angle: preset.3), image: nil))
              .clipShape(RoundedRectangle(cornerRadius: 6))
          }.buttonStyle(.plain).accessibilityLabel("\(preset.0) gradient")
        }
      }
      AppearanceBackgroundView(background: model.appearance.background, image: nil)
        .frame(height: 70).clipShape(RoundedRectangle(cornerRadius: 6)).accessibilityLabel("Gradient preview")
      AppearanceColourControl(label: "Gradient start", value: model.appearance.background.from ?? "#111827") { hex in update { $0.background.from = hex } }
      AppearanceColourControl(label: "Gradient end", value: model.appearance.background.to ?? "#3b1520") { hex in update { $0.background.to = hex } }
      slider("Direction", \.angle, fallback: 135, range: 0...360, suffix: "°")
    }
  }

  private var imageControls: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let image = model.backgroundImage {
        Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 180, maxHeight: 100).accessibilityLabel("Current background")
      }
      HStack {
        Button("Replace image") { chooseBackground() }.disabled(busy.wrappedValue)
        Button("Remove image") { update { $0.background = AppearanceBackground(kind: "none") } }
        Picker("Fit", selection: Binding(get: { model.appearance.background.fit ?? "cover" }, set: { fit in update { $0.background.fit = fit } })) {
          Text("Cover").tag("cover"); Text("Contain").tag("contain")
        }.frame(maxWidth: 180)
      }
      slider("Dimming", \.dim, fallback: 0.68, range: 0...0.95, suffix: "%", multiplier: 100)
      slider("Blur", \.blur, fallback: 0, range: 0...24, suffix: "px")
      slider("Horizontal position", \.positionX, fallback: 50, range: 0...100, suffix: "%")
      slider("Vertical position", \.positionY, fallback: 50, range: 0...100, suffix: "%")
    }
  }

  private func update(_ edit: (inout AppearanceProfile) -> Void) {
    var next = model.appearance; edit(&next); model.saveAppearance(next)
  }
  private func choice(_ label: String, _ key: WritableKeyPath<AppearanceProfile, String>, _ values: [String]) -> some View {
    Picker(label, selection: Binding(get: { model.appearance[keyPath: key] }, set: { value in update { $0[keyPath: key] = value } })) {
      ForEach(values, id: \.self) { Text($0.capitalized).tag($0) }
    }.font(Typography.meta)
  }
  private func slider(_ label: String, _ key: WritableKeyPath<AppearanceBackground, Double?>, fallback: Double, range: ClosedRange<Double>, suffix: String, multiplier: Double = 1) -> some View {
    HStack {
      Text(label).font(Typography.meta).frame(width: 125, alignment: .leading)
      Slider(value: Binding(get: { model.appearance.background[keyPath: key] ?? fallback }, set: { value in update { $0.background[keyPath: key] = value } }), in: range, onEditingChanged: { editing in
        if editing { model.beginAppearanceAdjustment() } else { model.endAppearanceAdjustment() }
      }).accessibilityLabel(label)
      Text("\(Int(((model.appearance.background[keyPath: key] ?? fallback) * multiplier).rounded()))\(suffix)")
        .font(Typography.caption).monospacedDigit().frame(width: 45, alignment: .trailing)
    }
  }
  private func chooseBackground() {
    let panel = NSOpenPanel(); panel.allowedContentTypes = [.png, .jpeg, .webP]; panel.allowsMultipleSelection = false
    guard panel.runModal() == .OK, let url = panel.url else { return }
    busy.wrappedValue = true; error.wrappedValue = nil
    Task {
      defer { busy.wrappedValue = false }
      do {
        let id = try await model.uploadBackground(url)
        update { $0.background = AppearanceBackground(kind: "image", assetID: id, fit: "cover", positionX: 50, positionY: 50, dim: 0.68, blur: 0) }
      } catch { self.error.wrappedValue = error.localizedDescription }
    }
  }
}

private struct AppearanceColourControl: View {
  var label: String
  var value: String
  var onChange: (String) -> Void
  var hex = State(wrappedValue: "")
  var invalid: Bool { hex.wrappedValue.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) == nil }
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        ColorPicker(label, selection: Binding(get: { Color(serverHex: value) }, set: { colour in
          guard let rgb = NSColor(colour).usingColorSpace(.sRGB) else { return }
          onChange(String(format: "#%02x%02x%02x", Int((rgb.redComponent * 255).rounded()), Int((rgb.greenComponent * 255).rounded()), Int((rgb.blueComponent * 255).rounded())))
        }), supportsOpacity: false)
        TextField("HEX", text: hex.projectedValue).frame(width: 95).textFieldStyle(.roundedBorder).accessibilityLabel("\(label) HEX")
      }
      if invalid { Text("Use # followed by six hex digits.").font(Typography.caption).foregroundStyle(.orange) }
    }
    .onAppear { hex.wrappedValue = value }
    .onChange(of: value) { _, next in hex.wrappedValue = next }
    .onChange(of: hex.wrappedValue) { _, next in if !invalid, next != value { onChange(next) } }
  }
}

/// Shared by the root canvas and thumbnails so direction and image positioning match.
struct AppearanceBackgroundView: View {
  var background: AppearanceBackground
  var image: NSImage?
  var body: some View {
    GeometryReader { proxy in
      let size = proxy.size
      if background.kind == "image", let image, image.size.width > 0, image.size.height > 0 {
        let xScale = size.width / image.size.width, yScale = size.height / image.size.height
        let scale = background.fit == "contain" ? min(xScale, yScale) : max(xScale, yScale)
        let width = image.size.width * scale, height = image.size.height * scale
        ZStack(alignment: .topLeading) {
          Palette.canvas
          Image(nsImage: image).resizable().frame(width: width, height: height)
            .offset(x: (size.width - width) * (background.positionX ?? 50) / 100,
                    y: (size.height - height) * (background.positionY ?? 50) / 100)
            .blur(radius: background.blur ?? 0)
          Palette.canvas.opacity(background.dim ?? 0.68)
        }.clipped()
      } else if background.kind == "gradient" {
        let radians = (background.angle ?? 135) * .pi / 180
        let length = abs(size.width * sin(radians)) + abs(size.height * cos(radians))
        let dx = sin(radians) * length / max(size.width, 1), dy = -cos(radians) * length / max(size.height, 1)
        LinearGradient(colors: [Color(serverHex: background.from ?? "#111827"), Color(serverHex: background.to ?? "#3b1520")],
                       startPoint: UnitPoint(x: 0.5 - dx / 2, y: 0.5 - dy / 2), endPoint: UnitPoint(x: 0.5 + dx / 2, y: 0.5 + dy / 2))
      } else if background.kind == "solid" { Color(serverHex: background.color ?? "#111827") }
      else { Palette.canvas }
    }.allowsHitTesting(false)
  }
}
