import { describe, expect, it } from "vitest";
import { themeFor, themeVariables } from "../src/theme";

/** Relative luminance, the honest measure of "will I see this on black". */
function luminance(hex: string): number {
  const full = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

describe("agent theme", () => {
  it("keeps the accent visible on a near-black canvas", () => {
    for (const color of ["#4f8cff", "#65a765", "#e0a75a", "#d95f9e", "#8a9a5b"]) {
      expect(luminance(themeFor(color).accent)).toBeGreaterThanOrEqual(0.22);
    }
  });

  it("lifts a colour that would vanish on black", () => {
    const theme = themeFor("#101010");
    expect(luminance(theme.accent)).toBeGreaterThanOrEqual(0.22);
    expect(theme.accent).not.toBe("#101010");
  });

  it("leaves room for white text on the bubble", () => {
    for (const color of ["#4f8cff", "#f0b95a", "#ffffff", "#d95f9e", "#c96442"]) {
      const theme = themeFor(color);
      const bg = luminance(theme.bubble);
      const ink = luminance(theme.bubbleInk);
      // Contrast between the bubble and its ink, WCAG AA for body text.
      const contrast = (Math.max(bg, ink) + 0.05) / (Math.min(bg, ink) + 0.05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("falls back to the brand colour for a value it cannot read", () => {
    expect(themeFor("not-a-colour").accent).toBe(themeFor("#ff3146").accent);
    expect(themeFor(undefined).accent).toBe(themeFor("#ff3146").accent);
  });

  it("hands the theme over as CSS custom properties", () => {
    const vars = themeVariables(themeFor("#4f8cff"));
    expect(vars["--agent-accent"]).toBe(themeFor("#4f8cff").accent);
    expect(vars["--agent-bubble"]).toBe(themeFor("#4f8cff").bubble);
  });
});
