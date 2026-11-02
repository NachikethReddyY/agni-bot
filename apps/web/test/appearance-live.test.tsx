import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClientFrame, IncomingFrame } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { AppearanceView } from "../src/components/AppearanceView";
import { APPEARANCE_PENDING_KEY, defaultAppearance } from "../src/appearance";

function setup(ready = true) {
  const sent: ClientFrame[] = [];
  const model = new AppModel({ healthPollMs: 0 });
  const send = vi.fn(async (frame: ClientFrame) => { sent.push(frame); });
  Object.assign(model, { connection: { send }, connectionState: { kind: ready ? "ready" : "idle" } });
  const frame = (profile: ReturnType<typeof defaultAppearance>) => act(() => (model as unknown as { handleFrame(frame: IncomingFrame): void }).handleFrame({ type: "appearance.updated", seq: 1, profiles: [profile], activeID: profile.id }));
  return { model, sent, send, frame, render: () => render(<AppModelProvider model={model}><AppearanceView /></AppModelProvider>) };
}
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("live appearance", () => {
  it("updates immediately, coalesces edits and only says Saved after acknowledgement", async () => {
    const h = setup(); h.render();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.queryByText("Save as new")).toBeNull();
    fireEvent.change(screen.getByLabelText("Custom accent picker"), { target: { value: "#112233" } });
    fireEvent.change(screen.getByLabelText("Custom accent picker"), { target: { value: "#334455" } });
    expect(h.model.getSnapshot().appearance.customAccent).toBe("#334455");
    expect(h.sent).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(h.sent).toHaveLength(1);
    expect(h.model.getSnapshot().appearanceSaveStatus).toBe("saving");
    h.frame(h.model.getSnapshot().appearance);
    expect(h.model.getSnapshot().appearanceSaveStatus).toBe("saved");
    expect(localStorage.getItem(APPEARANCE_PENDING_KEY)).toBeNull();
  });

  it("serializes saves and keeps newer edits when an old acknowledgement arrives", async () => {
    const h = setup();
    h.model.saveAppearance({ ...defaultAppearance(), preset: "ocean" });
    const old = h.model.getSnapshot().appearance;
    await vi.advanceTimersByTimeAsync(400);
    h.model.saveAppearance({ ...old, preset: "forest" });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.sent).toHaveLength(1);
    h.frame(old);
    expect(h.model.getSnapshot().appearance.preset).toBe("forest");
    expect(h.sent).toHaveLength(2);
    const current = h.model.getSnapshot().appearance;
    await vi.advanceTimersByTimeAsync(8000);
    expect(h.model.getSnapshot().appearanceSaveStatus).toBe("error");
    h.model.retryAppearanceSave();
    expect(h.sent.at(-1)).toEqual({ type: "appearance.save", profile: current, activate: true });
    h.frame(current);
    expect(h.model.getSnapshot().appearanceSaveStatus).toBe("saved");
  });

  it("keeps the debounce pause when an acknowledgement arrives during another adjustment", async () => {
    const h = setup();
    h.model.saveAppearance({ ...defaultAppearance(), preset: "ocean" });
    await vi.advanceTimersByTimeAsync(400);
    const first = h.model.getSnapshot().appearance;
    h.model.saveAppearance({ ...first, preset: "forest" });
    await vi.advanceTimersByTimeAsync(100);
    h.frame(first);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sent).toHaveLength(2);
  });

  it("restores pending edits on launch and retries instead of replacing them with server state", async () => {
    const h = setup(false);
    h.model.saveAppearance({ ...defaultAppearance(), preset: "warm" });
    await vi.advanceTimersByTimeAsync(400);
    expect(h.model.getSnapshot().appearanceSaveStatus).toBe("pending");
    const reloaded = setup();
    expect(reloaded.model.getSnapshot().appearance.preset).toBe("warm");
    reloaded.model.refreshAppearance();
    expect(reloaded.sent[0]?.type).toBe("appearance.save");
    reloaded.frame(defaultAppearance());
    expect(reloaded.model.getSnapshot().appearance.preset).toBe("warm");
    reloaded.frame(reloaded.model.getSnapshot().appearance);
    expect(reloaded.model.getSnapshot().appearanceSaveStatus).toBe("saved");
  });

  it("shows retry when sending fails without losing the latest adjustment", async () => {
    const h = setup();
    h.send.mockRejectedValueOnce(new Error("disconnected"));
    h.model.saveAppearance({ ...defaultAppearance(), preset: "warm" });
    await vi.advanceTimersByTimeAsync(400);
    h.render();
    expect(screen.getByRole("button", { name: "Retry save" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(APPEARANCE_PENDING_KEY)!)).toMatchObject({ preset: "warm" });
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    expect(h.sent).toHaveLength(1);
  });

  it("previews gradients, validates HEX, and undoes entire slider gestures separately", () => {
    const h = setup(); h.render();
    fireEvent.click(screen.getByRole("button", { name: "Gradient" }));
    fireEvent.click(screen.getByRole("button", { name: "Ocean gradient" }));
    expect(screen.getByRole("img", { name: "Gradient preview" }).getAttribute("style")).toContain("rgb(5, 46, 56)");
    const slider = screen.getByLabelText(/Direction/);
    fireEvent.change(slider, { target: { value: "180" } });
    fireEvent.change(slider, { target: { value: "270" } });
    fireEvent.pointerUp(slider);
    fireEvent.change(slider, { target: { value: "90" } });
    fireEvent.pointerUp(slider);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(h.model.getSnapshot().appearance.background).toMatchObject({ angle: 270 });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(h.model.getSnapshot().appearance.background).toMatchObject({ angle: 135 });
    fireEvent.change(screen.getByLabelText("Gradient start HEX"), { target: { value: "#oops" } });
    expect(screen.getByLabelText("Gradient start HEX")).toHaveAttribute("aria-invalid", "true");
    expect(h.model.getSnapshot().appearance.background).toMatchObject({ from: "#052e38" });
    fireEvent.change(screen.getByLabelText("Gradient start HEX"), { target: { value: "#123456" } });
    expect(h.model.getSnapshot().appearance.background).toMatchObject({ from: "#123456" });
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(h.model.getSnapshot().appearance.background).toEqual({ kind: "none" });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(h.model.getSnapshot().appearance.background).toMatchObject({ from: "#123456" });
  });
});
