/**
 * Per-agent theming.
 *
 * Every agent carries a colour. In the reference app that colour *is* the
 * theme: the room, the bubbles and the accents all take it. Here the colour
 * is tuned for a near-black UI instead of a white one — an accent that would
 * vanish against `#0d0d0f` is lifted until it reads, and the bubble colour is
 * pushed down until white text on it is still legible.
 *
 * Nothing here paints: the theme comes back as CSS custom properties, so one
 * rule change can move the whole surface.
 */

export interface AgentTheme {
  /** Highlights, dots and rings on a dark ground. */
  accent: string;
  /** The pressed state of the accent. */
  accentDeep: string;
  /** The user's bubble, carrying the agent's colour. */
  bubble: string;
  /** The text that sits on that bubble. */
  bubbleInk: string;
  /** A whisper of the colour, for surfaces. */
  tint: string;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const DEFAULT = "#ff3146";

function parseHex(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(cleaned)) return null;
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((char) => char + char)
          .join("")
      : cleaned;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function toHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
  else h = ((rn - gn) / delta + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

function toHex({ h, s, l }: Hsl): string {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const channel = (t: number): number => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };
  const r = Math.round(channel(hn + 1 / 3) * 255);
  const g = Math.round(channel(hn) * 255);
  const b = Math.round(channel(hn - 1 / 3) * 255);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Relative luminance, the honest measure of "will I see this on black". */
function luminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** The theme for an agent colour, tuned for a near-black room. */
export function themeFor(color: string | null | undefined): AgentTheme {
  const rgb = parseHex(color) ?? parseHex(DEFAULT)!;
  const hsl = toHsl(rgb);

  // The accent has to read on near-black: lift it until it does.
  let accentLightness = hsl.l;
  let accentRgb = rgb;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    accentRgb = parseHex(toHex({ ...hsl, l: accentLightness }))!;
    if (luminance(accentRgb) >= 0.22) break;
    accentLightness = Math.min(88, accentLightness + 6);
  }
  const accent = toHex({ ...hsl, l: accentLightness });
  const accentDeep = toHex({ ...hsl, l: Math.max(18, accentLightness - 14) });

  // The bubble carries the colour but has to hold white text: push it down
  // until the luminance leaves room for it.
  let bubbleLightness = Math.min(hsl.l, 46);
  let bubbleRgb = parseHex(toHex({ ...hsl, l: bubbleLightness }))!;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    bubbleRgb = parseHex(toHex({ ...hsl, l: bubbleLightness }))!;
    if (luminance(bubbleRgb) <= 0.15) break;
    bubbleLightness = Math.max(12, bubbleLightness - 4);
  }
  const bubble = toHex({ ...hsl, s: Math.min(hsl.s, 88), l: bubbleLightness });
  const bubbleInk = toHex({ h: hsl.h, s: Math.min(hsl.s, 30), l: 97 });

  const tint = `color-mix(in srgb, ${accent} 9%, transparent)`;

  return { accent, accentDeep, bubble, bubbleInk, tint };
}

/** The theme as CSS custom properties, ready for an inline style. */
export function themeVariables(theme: AgentTheme): Record<string, string> {
  return {
    "--agent-accent": theme.accent,
    "--agent-accent-deep": theme.accentDeep,
    "--agent-bubble": theme.bubble,
    "--agent-bubble-ink": theme.bubbleInk,
    "--agent-tint": theme.tint,
  };
}
