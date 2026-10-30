import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** A transport that opens and then waits forever: enough for the chat shell. */
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

beforeEach(() => {
  localStorage.clear();
  SecretStore.memoryToken = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  SecretStore.memoryToken = null;
});

describe("web shell", () => {
  it("keeps the agent the owner picked when a stale conversation reply lands", () => {
    SecretStore.save("test-token");
    const model = new AppModel({
      makeTransport: idleTransport,
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();
    const frame = (value: unknown): void => {
      (model as unknown as { handleFrame: (value: unknown) => void }).handleFrame(value);
    };
    const surface = model as unknown as {
      conversation: { agentID: string; conversationID: string | null; threadID: string | null };
    };

    frame({ type: "agents.update", seq: 1, agents: [{ id: "ea", name: "Vision" }, { id: "friday", name: "F.R.I.D.A.Y." }] });
    // The owner picks the other agent in the sidebar.
    model.selectAgent({ id: "friday", name: "F.R.I.D.A.Y." });
    expect(surface.conversation.agentID).toBe("friday");

    // The reply for the conversation the owner just left lands late. It must
    // not drag the surface back to the old agent.
    frame({ type: "conversation.ok", seq: 2, conversationID: "cnv_ea", agentID: "ea", sessionID: "thr_ea" });
    expect(surface.conversation.agentID).toBe("friday");
    expect(surface.conversation.conversationID).not.toBe("cnv_ea");

    // The live reply binds the agent that was picked.
    frame({ type: "conversation.ok", seq: 3, conversationID: "cnv_friday", agentID: "friday", sessionID: "thr_friday" });
    expect(surface.conversation.conversationID).toBe("cnv_friday");
    expect(surface.conversation.threadID).toBe("thr_friday");
  });

  it("shows pairing when no token is stored", () => {
    const model = new AppModel({
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    renderApp(model);

    expect(screen.getByRole("heading", { name: "Connect to Agni" })).toBeInTheDocument();
    expect(screen.getByLabelText("Pairing code")).toBeInTheDocument();
    // The token fallback defaults to the page's own origin (the daemon serves the app).
    expect(screen.getByLabelText("Agni server address")).toHaveValue(window.location.origin);
    expect(screen.getByPlaceholderText("Paste the token shown by the command")).toBeInTheDocument();
  });

  it("pairs from #code= in the URL and connects with the session cookie", async () => {
    window.history.replaceState(null, "", "/#code=ABCD-EFGH");
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Response.json({ paired: true, deviceName: "Test" });
    });
    const sent: string[] = [];
    const model = new AppModel({
      makeTransport: () => ({ ...idleTransport(), open: async () => undefined, send: async (text) => void sent.push(text) }),
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();

    await vi.waitFor(() => expect(model.getSnapshot().screen).toBe("chat"));
    expect(calls.map((call) => call.url)).toEqual(["/auth/pair", "/auth/session"]);
    expect(calls[0]?.body).toMatchObject({ code: "ABCD-EFGH" });
    expect(window.location.hash).toBe("");
    expect(model.getSnapshot().cookieSession).toBe(true);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(JSON.parse(sent[0]!)).not.toHaveProperty("token");
  });

  it("shows the chat shell when a token is stored", () => {
    SecretStore.save("test-token");
    const model = new AppModel({
      makeTransport: idleTransport,
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();
    renderApp(model);

    expect(screen.getAllByText("New Bot").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("Message New Bot")).toBeInTheDocument();
    expect(screen.getByText("Message New Bot — one conversation, it never resets")).toBeInTheDocument();
  });

  it("keeps a failed local echo and explains why", () => {
    SecretStore.save("test-token");
    const model = new AppModel({
      makeTransport: idleTransport,
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();
    renderApp(model);

    const composer = screen.getByPlaceholderText("Message New Bot");
    fireEvent.change(composer, { target: { value: "are you there?" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(screen.getByText("are you there?", { selector: "p" })).toBeInTheDocument();
    expect(composer).toHaveValue("are you there?");
    expect(screen.getByText("Not connected — this message was not sent.")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("opens the search overlay with Command-K and closes on Escape", () => {
    SecretStore.save("test-token");
    const model = new AppModel({
      makeTransport: idleTransport,
      healthFetch: async () => health,
      notifier: silentNotifications,
      healthPollMs: 0,
    });
    model.start();
    renderApp(model);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Search" })).not.toBeInTheDocument();
  });
});
