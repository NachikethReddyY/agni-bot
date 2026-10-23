import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { AgentProfileView } from "../src/components/AgentProfileView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("takes the new name on blur, not only on Enter", () => {
  const model = new AppModel({ healthPollMs: 0 });
  render(
    <AppModelProvider model={model}>
      <AgentProfileView />
    </AppModelProvider>,
  );
  const rename = vi.spyOn(model, "renameAgent").mockImplementation(() => undefined);
  const field = screen.getByLabelText("Name");

  fireEvent.change(field, { target: { value: "Bob" } });
  fireEvent.blur(field);

  expect(rename).toHaveBeenCalledWith("Bob", "ea");
  expect(rename).toHaveBeenCalledTimes(1);
});

it("leaves the name alone when it was not touched", () => {
  const model = new AppModel({ healthPollMs: 0 });
  render(
    <AppModelProvider model={model}>
      <AgentProfileView />
    </AppModelProvider>,
  );
  const rename = vi.spyOn(model, "renameAgent").mockImplementation(() => undefined);
  fireEvent.blur(screen.getByLabelText("Name"));
  expect(rename).not.toHaveBeenCalled();
});
