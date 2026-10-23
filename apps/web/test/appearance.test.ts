import { describe, expect, test } from "vitest";
import { accentColor, appearanceVariables, defaultAppearance } from "../src/appearance";

describe("appearance resolver", () => {
  test("resolves light semantic tokens and an accessible agent identity", () => {
    const profile = { ...defaultAppearance(), mode: "light" as const, preset: "paper" as const };
    const variables = appearanceVariables(profile, true, "#3366ff");
    expect(variables["--canvas"]).toBe("#f5f2ea");
    expect(variables["--ink"]).toBe("#27231e");
    expect(variables["--agent-accent"]).toMatch(/^#/);
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
