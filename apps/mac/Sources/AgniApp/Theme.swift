/**
 * The design tokens from DESIGN.md, in one place. Colour, type, spacing and the
 * few motion values the app uses. Nothing here is decorative: every token is
 * referenced by a view, and the comments say what for.
 */
import SwiftUI
import AgniProtocol

/**
 * NOTE ON PROPERTY WRAPPERS
 *
 * This app is built with Command Line Tools only, which does not ship SwiftUI's
 * macro plugin, so `@State`, `@Binding`, `@Environment`, `@FocusState` and
 * `@NSApplicationDelegateAdaptor` are unavailable here. The wrappers are
 * therefore declared as explicit stored properties (`var phase = State(...)`)
 * and reached through `.wrappedValue` / `.projectedValue`.
 *
 * Installing Xcode restores the sugar; the wrappers are the same types, so the
 * change is mechanical (one `@` per declaration).
 */

enum Palette {
  private static var values: [UInt32] {
    let dark: [String: [UInt32]] = [
      "agni": [0x0D0D0F, 0x08080A, 0x17171A, 0x1F1F23, 0x1B1B1E, 0xF4F4F6, 0x9A9AA1, 0x6D6D76],
      "midnight": [0x080B14, 0x050811, 0x111827, 0x1C2538, 0x151D2D, 0xF3F7FF, 0x9BA9C1, 0x64748B],
      "graphite": [0x111315, 0x0B0D0E, 0x1C2022, 0x272C2F, 0x202527, 0xF3F4F4, 0xA3AAAD, 0x70787C],
      "paper": [0x171512, 0x100F0D, 0x24211D, 0x302C27, 0x29251F, 0xFFFAF1, 0xB8AC9B, 0x807568],
      "ocean": [0x07181D, 0x041115, 0x10262C, 0x17343C, 0x112A31, 0xECFEFF, 0x9BC5CC, 0x638E96],
      "forest": [0x0B1712, 0x07100C, 0x15251C, 0x203229, 0x192A21, 0xF0FDF4, 0xA1C2AA, 0x6F9278],
      "warm": [0x19120F, 0x100C0A, 0x281C17, 0x35251E, 0x2C201A, 0xFFF7ED, 0xC8AA98, 0x8F7465],
    ]
    let light: [String: [UInt32]] = [
      "agni": [0xF7F7F8, 0xEFEFF1, 0xFFFFFF, 0xE9E9ED, 0xF0F0F2, 0x18181B, 0x5B5B63, 0x85858D],
      "midnight": [0xEEF2FF, 0xE2E8F8, 0xFFFFFF, 0xDCE4F4, 0xE7EDF8, 0x111827, 0x52617A, 0x7B8AA1],
      "graphite": [0xF1F3F3, 0xE5E8E8, 0xFFFFFF, 0xDFE4E5, 0xE8ECEC, 0x1D2325, 0x596367, 0x80898D],
      "paper": [0xF5F2EA, 0xEBE6DB, 0xFFFDF8, 0xE5DED0, 0xEEE8DC, 0x27231E, 0x655E54, 0x90877A],
      "ocean": [0xECF8FA, 0xDCEFF2, 0xFFFFFF, 0xD5EAEE, 0xE2F2F4, 0x102A31, 0x53747B, 0x7C9DA3],
      "forest": [0xEFF8F2, 0xDFEFE4, 0xFFFFFF, 0xD9EADD, 0xE5F2E8, 0x17271F, 0x587363, 0x809A88],
      "warm": [0xFAF3EF, 0xF1E5DE, 0xFFFDFB, 0xEDDDD4, 0xF5E9E2, 0x2D201B, 0x755E52, 0x9B8376],
    ]
    let profile = AppearanceRuntime.profile
    return (profile.mode == "light" ? light : dark)[profile.preset] ?? dark["agni"]!
  }
  static var canvas: Color { Color(hex: values[0]) }
  static var sidebar: Color { Color(hex: values[1]) }
  static var surface: Color { Color(hex: values[2]) }
  static var surfaceRaised: Color { Color(hex: values[3]) }
  static var incomingBubble: Color { Color(hex: values[4]) }
  static var outgoingBubble: Color { Color(hex: 0xE8E8E3) }
  static var hairline: Color { ink.opacity(0.10) }
  static var ink: Color { Color(hex: values[5]) }
  static var inkSecondary: Color { Color(hex: values[6]) }
  static var inkTertiary: Color { Color(hex: values[7]) }
  static var ember: Color { Color(serverHex: AppearanceRuntime.accentHex) }
  static var emberDeep: Color { ember.opacity(0.75) }
  /// The persona colour the server assigns, used for scheduled work.
  static let amber = Color(hex: 0xF0B95A)
}

enum Metrics {
  static let sidebarMin: CGFloat = 240
  static let sidebarIdeal: CGFloat = 268
  static let inspectorMin: CGFloat = 280
  static let inspectorIdeal: CGFloat = 320
  /// Chat column caps the measure so prose stays under ~80 characters.
  static let measure: CGFloat = 680
  static let gutter: CGFloat = 20
  static var rowRadius: CGFloat { AppearanceRuntime.profile.corners == "square" ? 4 : AppearanceRuntime.profile.corners == "soft" ? 18 : 10 }
  static var bubbleRadius: CGFloat { AppearanceRuntime.profile.corners == "square" ? 7 : AppearanceRuntime.profile.corners == "soft" ? 24 : 18 }
  static var cardRadius: CGFloat { AppearanceRuntime.profile.corners == "square" ? 4 : AppearanceRuntime.profile.corners == "soft" ? 18 : 12 }
}

enum Typography {
  private static var scale: CGFloat { AppearanceRuntime.profile.textScale == "small" ? 0.93 : AppearanceRuntime.profile.textScale == "large" ? 1.12 : 1 }
  static var display: Font { .system(size: 22 * scale, weight: .semibold) }
  static var title: Font { .system(size: 15 * scale, weight: .semibold) }
  static var body: Font { .system(size: 14 * scale) }
  static var rowTitle: Font { .system(size: 14 * scale, weight: .medium) }
  static var meta: Font { .system(size: 12 * scale) }
  static var caption: Font { .system(size: 11 * scale) }
  static var machine: Font { .system(size: 11 * scale, design: .monospaced) }
  static var code: Font { .system(size: 13 * scale, design: .monospaced) }
}

enum AppearanceRuntime {
  nonisolated(unsafe) static var profile = AppearanceProfile(
    id: "theme_default", name: "My Agni", mode: "system", preset: "agni", accent: "ember",
    background: AppearanceBackground(kind: "none"), textScale: "default", density: "comfortable",
    corners: "standard", motion: "system", agentTint: "full", updatedAt: "1970-01-01T00:00:00.000Z"
  )
  static var accentHex: String {
    if profile.accent == "custom" { return profile.customAccent ?? "#ff3146" }
    return ["ember": "#ff3146", "amber": "#f0b95a", "ocean": "#38bdf8", "forest": "#4ade80",
            "violet": "#a78bfa", "rose": "#fb7185", "mono": "#d4d4d8"][profile.accent] ?? "#ff3146"
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }

  /// Server colours arrive as `#rrggbb`.
  init(serverHex: String) {
    let cleaned = serverHex.trimmingCharacters(in: CharacterSet(charactersIn: "# ")).lowercased()
    guard cleaned.count == 6, let value = UInt32(cleaned, radix: 16) else {
      self = Palette.amber
      return
    }
    self.init(hex: value)
  }
}

/// The flame. One shape, three sizes, and a pulse that means "working".
struct FlameMark: View {
  enum Size {
    case small
    case medium
    case large

    var points: CGFloat {
      switch self {
      case .small: 16
      case .medium: 26
      case .large: 56
      }
    }
  }

  var size: Size = .medium
  /// Live: the agent is producing tokens right now.
  var isAlive: Bool = false
  var reduceMotion = Environment(\.accessibilityReduceMotion)

  var body: some View {
    Image(systemName: "flame.fill")
      .font(.system(size: size.points, weight: .semibold))
      .foregroundStyle(
        LinearGradient(colors: [Palette.ember, Palette.emberDeep], startPoint: .top, endPoint: .bottom)
      )
      .shadow(color: Palette.ember.opacity(isAlive ? 0.45 : 0), radius: isAlive ? 8 : 0)
      .scaleEffect(isAlive && !reduceMotion.wrappedValue ? 1.04 : 1)
      .animation(reduceMotion.wrappedValue ? nil : .easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: isAlive)
      .accessibilityHidden(true)
  }
}

/// Agent avatar: the flame for Agni, a coloured monogram for everyone else.
struct AgentAvatar: View {
  var agent: AgentInfo?
  var isAlive: Bool = false
  var size: FlameMark.Size = .medium

  var body: some View {
    if let agent, agent.id != "agni" {
      ZStack {
        Circle().fill(Color(serverHex: agent.colorHex).opacity(0.22))
        Text(monogram(agent.name))
          .font(.system(size: size.points * 0.42, weight: .semibold))
          .foregroundStyle(Color(serverHex: agent.colorHex))
      }
      .frame(width: size.points + 10, height: size.points + 10)
      .accessibilityLabel(agent.name)
    } else {
      FlameMark(size: size, isAlive: isAlive)
        .frame(width: size.points + 10, height: size.points + 10)
        .accessibilityLabel(agent?.name ?? "Agni")
    }
  }

  private func monogram(_ name: String) -> String {
    let initials = name.split(separator: " ").prefix(2).compactMap { $0.first }
    return String(initials).uppercased()
  }
}

/// Compact circular identity badge used in the thread list and chat header.
struct SidebarAgentBadge: View {
  var agent: AgentInfo?
  var size: CGFloat

  var body: some View {
    ZStack {
      Circle().fill(background)
      if agent == nil || agent?.id == "agni" {
        Image(systemName: "flame.fill")
          .font(.system(size: size * 0.48, weight: .semibold))
          .foregroundStyle(Color(hex: 0x18181B))
      } else {
        Text(initials)
          .font(.system(size: size * 0.34, weight: .semibold))
          .foregroundStyle(Color(hex: 0x18181B))
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel(agent?.name ?? "Agni")
  }

  private var background: Color {
    if let agent, agent.id != "agni" { return Color(serverHex: agent.colorHex) }
    return Color(hex: 0xEA9A3E)
  }

  private var initials: String {
    guard let agent else { return "A" }
    return String(agent.name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
  }
}

/// Presence: a dot that is ember when the daemon is reachable, quiet when not.
struct PresenceDot: View {
  var isOnline: Bool

  var body: some View {
    Circle()
      .fill(isOnline ? Palette.ember : Palette.inkTertiary)
      .frame(width: 6, height: 6)
      .shadow(color: Palette.ember.opacity(isOnline ? 0.7 : 0), radius: 4)
      .accessibilityLabel(isOnline ? "Connected" : "Offline")
  }
}

/// A hairline that reads as structure, not decoration.
struct Hairline: View {
  var body: some View {
    Rectangle().fill(Palette.hairline).frame(height: 1)
  }
}
