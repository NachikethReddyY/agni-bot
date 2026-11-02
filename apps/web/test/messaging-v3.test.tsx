import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage } from "@agni/client";
import { AppearanceProfileSchema } from "@agni/protocol";
import { sameMessageGroup } from "../src/components/ThreadView";
import { ThreadHeader } from "../src/components/ThreadHeader";
import { RootView } from "../src/components/RootView";
import { SidebarView } from "../src/components/SidebarView";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { appearanceVariables, contrastRatio, defaultAppearance } from "../src/appearance";

const message = (date: string, overrides: Partial<ChatMessage> = {}) => ({ role: "assistant", agentID: "ea", uiHint: null, createdAt: new Date(date), ...overrides }) as ChatMessage;
beforeEach(() => { localStorage.clear(); window.history.replaceState({}, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("desktop messaging V3", () => {
  it("can reopen the desktop sidebar from every task view after collapsing it", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const model = new AppModel({ healthPollMs: 0 });
    Object.assign(model, { screen: "chat" });
    model.toggleTasks();
    const view = render(<AppModelProvider model={model}><RootView /></AppModelProvider>);
    for (const label of ["Upcoming", "Completed", "Calendar", "Inbox", "Today"]) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
      expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(view.container.querySelector(".sidebar")).toHaveClass("desktop-collapsed");
      fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      expect(view.container.querySelector(".sidebar")).not.toHaveClass("desktop-collapsed");
    }
    vi.unstubAllGlobals();
  });

  it("groups consecutive messages only within a day and sender, without changing message boundaries", () => {
    const a = message("2026-11-03T10:00:00");
    expect(sameMessageGroup(a, message("2026-11-03T10:01:00"))).toBe(true);
    expect(sameMessageGroup(a, message("2026-11-03T10:06:00"))).toBe(false);
    expect(sameMessageGroup(a, message("2026-11-03T10:01:00", { agentID: "other" }))).toBe(false);
    expect(sameMessageGroup(a, message("2026-11-03T10:01:00", { role: "user" }))).toBe(false);
    expect(sameMessageGroup(message("2026-11-03T23:59:00"), message("2026-11-04T00:01:00"))).toBe(false);
    expect(sameMessageGroup(a, undefined)).toBe(false);
  });
  it("accepts V2 profiles and keeps bubble colour separate from the bot identity", () => {
    const old = AppearanceProfileSchema.parse(defaultAppearance());
    const base = appearanceVariables(old, true, "#cc3344");
    expect(contrastRatio(base["--outgoing-bubble"]!, base["--outgoing-ink"]!)).toBeGreaterThanOrEqual(4.5);
    const next = AppearanceProfileSchema.parse({ ...old, bubbleColor: "#fafafa", conversationWidth: "comfortable", transparency: "off" });
    const resolved = appearanceVariables(next, true, "#cc3344");
    expect(resolved["--outgoing-bubble"]).toBe("#fafafa");
    expect(resolved["--outgoing-ink"]).toBe("#000000");
    expect(resolved["--conversation-width"]).toBe("1100px");
    expect(resolved["--chrome-blur"]).toBe("none");
    expect(resolved["--agent-accent"]).toBe(base["--agent-accent"]);
    expect(AppearanceProfileSchema.safeParse({ ...old, bubbleColor: "red" }).success).toBe(false);
  });
  it("keeps connection details and debugging accessible through the conversation menu", () => {
    const model = new AppModel({ healthPollMs: 0 });
    const debug = vi.spyOn(model, "toggleDebug");
    render(<AppModelProvider model={model}><ThreadHeader /></AppModelProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Bot debugger/ }));
    expect(debug).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("supports keyboard sidebar resizing and remembers the size", () => {
    const model = new AppModel({ healthPollMs: 0 });
    render(<AppModelProvider model={model}><SidebarView /></AppModelProvider>);
    const handle = screen.getByRole("separator", { name: "Sidebar width" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle).toHaveAttribute("aria-valuenow", "310");
    expect(localStorage.getItem("dev.agni.sidebar.width")).toBe("310");
    fireEvent.change(screen.getByRole("textbox", { name: "Search bots" }), { target: { value: "Design" } });
    expect(model.getSnapshot().searchText).toBe("Design");
  });
});
