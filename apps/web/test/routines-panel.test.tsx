import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { JobInfo } from "@agni/client";
import type { RoutineInfo } from "@agni/protocol";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { InspectorView } from "../src/components/InspectorView";

const routine: RoutineInfo = {
  name: "Morning brief",
  cron: "0 9 * * 1-5",
  timezone: "Europe/London",
  misfire: "skip",
  preflight: "http",
  maxTokens: 4000,
  maxExecutionMs: 30000,
  allowedDomains: ["news.example.com"],
  successStreak: 3,
  failureStreak: 0,
  recentRuns: [
    { at: "2026-10-26T09:00:00.000Z", outcome: "skipped_no_delta", tokens: 0, summary: "Nothing new." },
    { at: "2026-10-25T09:00:00.000Z", outcome: "skipped_no_delta", tokens: 0 },
    { at: "2026-10-24T09:00:00.000Z", outcome: "ran", tokens: 812, summary: "Three stories." },
  ],
};

function routineJob(partial: Partial<RoutineInfo> = {}, job: Partial<JobInfo> = {}): JobInfo {
  return {
    id: "job_routine",
    kind: "routine",
    state: "queued",
    runAt: "2026-10-27T09:00:00.000Z",
    enabled: true,
    attempts: 0,
    title: "Summarise the morning news",
    threadID: "thr_brief",
    routine: { ...routine, ...partial },
    ...job,
  };
}

function modelWithJobs(jobs: JobInfo[]): AppModel {
  const model = new AppModel({ healthPollMs: 0 });
  (model as unknown as { handleFrame: (frame: unknown) => void }).handleFrame({ type: "job.list.ok", seq: 1, jobs });
  return model;
}

function renderInspector(model: AppModel) {
  return render(
    <AppModelProvider model={model}>
      <InspectorView />
    </AppModelProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("the routines panel", () => {
  it("shows a routine's cadence, last outcome and streak", () => {
    renderInspector(modelWithJobs([routineJob()]));

    expect(screen.getByText("Morning brief")).toBeInTheDocument();
    expect(screen.getByText(/^Weekdays at 09:00 · Europe\/London/)).toBeInTheDocument();
    expect(screen.getByText(/^Last skipped, no change/)).toBeInTheDocument();
    expect(screen.getByText(/3 ok in a row$/)).toBeInTheDocument();
  });

  it("shows a routine with no runs yet", () => {
    renderInspector(modelWithJobs([routineJob({ recentRuns: [], allowedDomains: [] })]));

    expect(screen.getByText(/^No runs yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Morning brief/ }));
    expect(screen.queryByText(/runs skipped/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Routine domains")).toHaveValue("");
  });

  it("saves the owner's domain list through the owner-only frame", () => {
    const model = modelWithJobs([routineJob({ allowedDomains: [] })]);
    const setRoutineDomains = vi.spyOn(model, "setRoutineDomains").mockImplementation(() => undefined);
    renderInspector(model);
    fireEvent.click(screen.getByRole("button", { name: /Morning brief/ }));

    fireEvent.change(screen.getByLabelText("Routine domains"), { target: { value: " news.example.com, docs.example.org ," } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(setRoutineDomains).toHaveBeenCalledWith(expect.objectContaining({ id: "job_routine" }), ["news.example.com", "docs.example.org"]);
  });

  it("counts skipped runs and their tokens for the zero-token gate", () => {
    renderInspector(modelWithJobs([routineJob()]));
    fireEvent.click(screen.getByRole("button", { name: /Morning brief/ }));

    expect(screen.getByText("2 of last 3 runs skipped, 0 tokens")).toBeInTheDocument();
  });

  it("expands to show the runs, the config and the actions", () => {
    const model = modelWithJobs([routineJob()]);
    const setRoutine = vi.spyOn(model, "setRoutine").mockImplementation(() => undefined);
    renderInspector(model);
    const toggle = screen.getByRole("button", { name: /Morning brief/ });

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Three stories.")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Three stories.")).toBeInTheDocument();
    expect(screen.getByText("Nothing new.")).toBeInTheDocument();
    expect(screen.getByText("812 tokens", { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText("Routine domains")).toHaveValue("news.example.com");
    expect(screen.getByText((4000).toLocaleString())).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(setRoutine).toHaveBeenCalledWith(expect.objectContaining({ id: "job_routine" }), false);
    expect(screen.getByRole("button", { name: "Open report" })).toBeInTheDocument();
  });

  it.each([
    ["*/15 * * * *", "Every 15 minutes · Europe/London"],
    ["0 */2 * * *", "Every 2 hours · Europe/London"],
    ["30 8 * * *", "Daily at 08:30 · Europe/London"],
    ["0 9 * * 1,3", "0 9 * * 1,3 · Europe/London"],
  ])("reads the cron %j as a cadence", (cron, expected) => {
    renderInspector(modelWithJobs([routineJob({ cron })]));

    expect(screen.getByRole("button", { name: /Morning brief/ })).toHaveTextContent(expected);
  });

  it("renders a non-routine job exactly as before", () => {
    const job: JobInfo = {
      id: "job_digest",
      kind: "digest",
      state: "queued",
      runAt: "2026-10-27T09:00:00.000Z",
      enabled: true,
      attempts: 0,
      everyMs: 3_600_000,
      title: "Hourly digest",
    };
    const { container } = renderInspector(modelWithJobs([job]));
    const row = container.querySelector(".routine-row");

    expect(row?.children).toHaveLength(3);
    expect(row?.querySelector(".routine-main")?.children).toHaveLength(2);
    expect(row?.querySelector("button")).toHaveClass("icon-btn");
    expect(row?.querySelector(".routine-toggle")).toBeNull();
    expect(row?.querySelector(".routine-detail")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Hourly digest routine" })).toBeChecked();
    expect(screen.getByText("Hourly digest")).toBeInTheDocument();
  });
});
