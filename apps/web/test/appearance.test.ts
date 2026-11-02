import { describe, expect, test } from "vitest";
import { accentColor, appearanceVariables, contrastRatio, defaultAppearance } from "../src/appearance";

describe("appearance resolver", () => {
  test("resolves light semantic tokens and an accessible agent identity", () => {
    const profile = { ...defaultAppearance(), mode: "light" as const, preset: "paper" as const };
    const variables = appearanceVariables(profile, true, "#3366ff");
    expect(variables["--canvas"]).toBe("#f5f2ea");
    expect(variables["--ink"]).toBe("#27231e");
    expect(variables["--agent-accent"]).toMatch(/^#/);
  });

  test("keeps button labels readable and softens image backgrounds for the active mode", () => {
    for (const customAccent of ["#000000", "#ffffff", "#808080", "#ff3146", "#55aaee"]) {
      const profile = { ...defaultAppearance(), accent: "custom" as const, customAccent };
      const variables = appearanceVariables(profile, true);
      expect(contrastRatio(customAccent, variables["--accent-ink"]!)).toBeGreaterThanOrEqual(4.5);
    }
    const profile = { ...defaultAppearance(), mode: "light" as const,
      background: { kind: "image" as const, assetID: "bg_test", fit: "cover" as const, positionX: 50, positionY: 50, dim: 0.68, blur: 0 } };
    expect(appearanceVariables(profile, false, null, "blob:test")["--app-background-image"]).toContain("255 255 255 / 0.68");
    expect(appearanceVariables({ ...profile, mode: "dark" }, false, null, "blob:test")["--app-background-image"]).toContain("0 0 0 / 0.68");
  });

  test("uses custom accents and keeps image controls bounded in CSS", () => {
    const profile = {
      ...defaultAppearance(), accent: "custom" as const, customAccent: "#123456",
      background: { kind: "image" as const, assetID: "bg_demo", fit: "cover" as const, positionX: 25, positionY: 75, dim: 0.7, blur: 12 },
    };
    expect(accentColor(profile)).toBe("#123456");
    const variables = appearanceVariables(profile, true, null, "blob:test");
    expect(variables["--app-background-position"]).toBe("25% 75%");
    expect(variables["--app-background-blur"]).toBe("12px");
  });
});
