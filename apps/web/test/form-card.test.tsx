import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SecretStore, type FrameTransport, type HealthReport } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { silentNotifications } from "../src/state/notifications";
import { AppModelProvider } from "../src/state/use-app-model";
import { RootView } from "../src/components/RootView";

const health: HealthReport = {
  ok: true,
  v: 2,
  serverTime: new Date().toISOString(),
  uptimeMs: 90_000,
  seq: 1,
  providers: [],
  usageToday: { turns: 0, inputTokens: 0, outputTokens: 0 },
};

function idleTransport(): FrameTransport {
  return {
    open: () => new Promise<void>(() => undefined),
    send: async () => undefined,
    receive: () => new Promise<string>(() => undefined),
    close: async () => undefined,
  };
}

function renderApp(model: AppModel) {
  return render(
    <AppModelProvider model={model}>
      <RootView />
    </AppModelProvider>,
  );
}

function connectStub(model: AppModel): void {
  const inner = model as unknown as { connection: unknown; connectionState: unknown };
  inner.connection = { send: async () => undefined };
  inner.connectionState = { kind: "ready", lastSeq: 0 };
}

function frame(model: AppModel, value: unknown): void {
  (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value);
}

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  SecretStore.memoryToken = null;
});

describe("a question the agent asked", () => {
  it("draws the choices with letters, and Done when more than one may be chosen", async () => {
    SecretStore.save("test-token");
    const model = new AppModel({
      makeTransport: idleTransport,
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();
    frame(model, {
      type: "form.request",
      seq: 1,
      requestID: "frm_1",
      question: "Which sections should the update cover?",
      options: ["Revenue and burn", "Key hires this week", "Product launches"],
      multiple: true,
      kind: "choice",
    });
    connectStub(model);
    renderApp(model);

    expect(screen.getAllByText("Which sections should the update cover?").length).toBeGreaterThan(0);
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();

    // Choosing two and pressing Done answers with both.
    fireEvent.click(screen.getByText("Key hires this week"));
    fireEvent.click(screen.getByText("Product launches"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(model.getSnapshot().conversation.forms[0]?.answer).toBe("Key hires this week, Product launches"),
    );
  });

  it("draws an email draft with the fields and two ways out", async () => {
    SecretStore.save("test-token");
    const model = new AppModel({
      makeTransport: idleTransport,
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();
    frame(model, {
      type: "form.request",
      seq: 1,
      requestID: "frm_2",
      question: "Send this email?",
      kind: "email",
      email: {
        from: "cory@acme.com",
        to: "sarah@acme.com",
        subject: "Moving Friday's design review to 2 PM",
        body: "Hi Sarah,\n\nCould we move the review?",
      },
    });
    connectStub(model);
    renderApp(model);

    expect(screen.getByText("New email")).toBeInTheDocument();
    expect(screen.getByText("sarah@acme.com")).toBeInTheDocument();
    expect(screen.getByText("Moving Friday's design review to 2 PM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send email" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(model.getSnapshot().conversation.forms[0]?.answer).toBe("Discard"));
  });
});
