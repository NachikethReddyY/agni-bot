import { AppearanceProfileSchema, type AppearanceProfile } from "@agni/protocol";
import { themeFor, themeVariables } from "./theme";

export const APPEARANCE_CACHE_KEY = "dev.agni.web.appearance.v1";

export const PRESETS = [
  { id: "agni", name: "Agni", colors: ["#0d0d0f", "#17171a"] },
  { id: "midnight", name: "Midnight", colors: ["#080b14", "#141a2a"] },
  { id: "graphite", name: "Graphite", colors: ["#111315", "#23272a"] },
  { id: "paper", name: "Paper", colors: ["#f5f2ea", "#ffffff"] },
  { id: "ocean", name: "Ocean", colors: ["#07181d", "#102a31"] },
  { id: "forest", name: "Forest", colors: ["#0b1712", "#17271f"] },
  { id: "warm", name: "Warm", colors: ["#19120f", "#2a1e19"] },
] as const;

export const ACCENTS = [
  { id: "ember", name: "Ember", color: "#ff3146" },
  { id: "amber", name: "Amber", color: "#f0b95a" },
  { id: "ocean", name: "Ocean", color: "#38bdf8" },
  { id: "forest", name: "Forest", color: "#4ade80" },
  { id: "violet", name: "Violet", color: "#a78bfa" },
  { id: "rose", name: "Rose", color: "#fb7185" },
  { id: "mono", name: "Mono", color: "#d4d4d8" },
] as const;

export function defaultAppearance(): AppearanceProfile {
  return {
    version: 1,
    id: "theme_default",
    name: "My Agni",
    mode: "system",
    preset: "agni",
    accent: "ember",
    background: { kind: "none" },
    textScale: "default",
    density: "comfortable",
    corners: "standard",
    motion: "system",
    agentTint: "full",
    updatedAt: new Date(0).toISOString(),
  };
}

export function loadCachedAppearance(): AppearanceProfile {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    if (raw) return AppearanceProfileSchema.parse(JSON.parse(raw));
  } catch { /* storage may be blocked or from an older schema */ }
  return defaultAppearance();
}

export function cacheAppearance(profile: AppearanceProfile): void {
  try { localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(profile)); } catch { /* best effort */ }
}

export function newAppearanceID(): string {
  return `theme_${crypto.randomUUID().replaceAll("-", "")}`;
}

const darkPresets = {
  agni: ["#0d0d0f", "#08080a", "#17171a", "#1f1f23", "#1b1b1e", "#f4f4f6", "#9a9aa1", "#6d6d76"],
  midnight: ["#080b14", "#050811", "#111827", "#1c2538", "#151d2d", "#f3f7ff", "#9ba9c1", "#64748b"],
  graphite: ["#111315", "#0b0d0e", "#1c2022", "#272c2f", "#202527", "#f3f4f4", "#a3aaad", "#70787c"],
  paper: ["#171512", "#100f0d", "#24211d", "#302c27", "#29251f", "#fffaf1", "#b8ac9b", "#807568"],
  ocean: ["#07181d", "#041115", "#10262c", "#17343c", "#112a31", "#ecfeff", "#9bc5cc", "#638e96"],
  forest: ["#0b1712", "#07100c", "#15251c", "#203229", "#192a21", "#f0fdf4", "#a1c2aa", "#6f9278"],
  warm: ["#19120f", "#100c0a", "#281c17", "#35251e", "#2c201a", "#fff7ed", "#c8aa98", "#8f7465"],
} as const;

const lightPresets = {
  agni: ["#f7f7f8", "#efeff1", "#ffffff", "#e9e9ed", "#f0f0f2", "#18181b", "#5b5b63", "#85858d"],
  midnight: ["#eef2ff", "#e2e8f8", "#ffffff", "#dce4f4", "#e7edf8", "#111827", "#52617a", "#7b8aa1"],
  graphite: ["#f1f3f3", "#e5e8e8", "#ffffff", "#dfe4e5", "#e8ecec", "#1d2325", "#596367", "#80898d"],
  paper: ["#f5f2ea", "#ebe6db", "#fffdf8", "#e5ded0", "#eee8dc", "#27231e", "#655e54", "#90877a"],
  ocean: ["#ecf8fa", "#dceff2", "#ffffff", "#d5eaee", "#e2f2f4", "#102a31", "#53747b", "#7c9da3"],
  forest: ["#eff8f2", "#dfefe4", "#ffffff", "#d9eadd", "#e5f2e8", "#17271f", "#587363", "#809a88"],
  warm: ["#faf3ef", "#f1e5de", "#fffdfb", "#edddd4", "#f5e9e2", "#2d201b", "#755e52", "#9b8376"],
} as const;

export function accentColor(profile: AppearanceProfile): string {
  if (profile.accent === "custom") return profile.customAccent ?? "#ff3146";
  return ACCENTS.find((item) => item.id === profile.accent)?.color ?? "#ff3146";
}

function contrastInk(hex: string): string {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  return luminance > 0.179 ? "#18181b" : "#ffffff";
}

export function appearanceVariables(
  profile: AppearanceProfile,
  prefersDark: boolean,
  agentColor?: string | null,
  backgroundURL?: string | null,
): Record<string, string> {
  const dark = profile.mode === "dark" || (profile.mode === "system" && prefersDark);
  const [canvas, sidebar, surface, raised, incoming, ink, secondary, tertiary] =
    (dark ? darkPresets : lightPresets)[profile.preset];
  const accent = accentColor(profile);
  const agent = profile.agentTint === "off" ? accent : (agentColor ?? accent);
  const agentTheme = themeFor(agent);
  if (profile.agentTint === "subtle") agentTheme.bubble = themeFor(accent).bubble;
  const radius = profile.corners === "square" ? "4px" : profile.corners === "soft" ? "18px" : "10px";
  const scale = profile.textScale === "small" ? 0.93 : profile.textScale === "large" ? 1.12 : 1;
  const background = profile.background;
  let image = "none";
  let size = "cover";
  let position = "50% 50%";
  let overlay = "transparent";
  let blur = "0px";
  if (background.kind === "solid") image = `linear-gradient(${background.color}, ${background.color})`;
  if (background.kind === "gradient") image = `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`;
  if (background.kind === "image" && backgroundURL) {
    image = `linear-gradient(rgb(0 0 0 / ${background.dim}), rgb(0 0 0 / ${background.dim})), url("${backgroundURL}")`;
    size = background.fit;
    position = `${background.positionX}% ${background.positionY}%`;
    blur = `${background.blur}px`;
    overlay = dark ? "rgb(0 0 0 / 8%)" : "rgb(255 255 255 / 10%)";
  }
  return {
    "--canvas": canvas, "--sidebar": sidebar, "--surface": surface,
    "--surface-raised": raised, "--incoming-bubble": incoming,
    "--ink": ink, "--ink-secondary": secondary, "--ink-tertiary": tertiary,
    "--hairline": dark ? "rgb(255 255 255 / 9%)" : "rgb(24 24 27 / 12%)",
    "--ember": accent, "--ember-deep": themeFor(accent).accentDeep,
    "--accent-ink": contrastInk(accent), "--agent-accent-ink": contrastInk(agentTheme.accent),
    "--row-radius": radius, "--card-radius": profile.corners === "soft" ? "18px" : radius,
    "--text-display": `${22 * scale}px`, "--text-title": `${15 * scale}px`,
    "--text-body": `${14 * scale}px`, "--text-row-title": `${14 * scale}px`,
    "--text-meta": `${12 * scale}px`, "--text-caption": `${11 * scale}px`,
    "--text-machine": `${11 * scale}px`, "--text-code": `${13 * scale}px`,
    "--appearance-gap": profile.density === "compact" ? "10px" : "14px",
    "--app-background-image": image, "--app-background-size": size,
    "--app-background-position": position, "--app-background-overlay": overlay,
    "--app-background-blur": blur,
    "colorScheme": dark ? "dark" : "light",
    ...themeVariables(agentTheme),
  };
}
