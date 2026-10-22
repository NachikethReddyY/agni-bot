import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClientFrame, HealthReport, IncomingFrame } from "@agni/client";
import { AppModel } from "../src/state/app-model";
import { AppModelProvider } from "../src/state/use-app-model";
import { AddProviderView } from "../src/components/AddProviderView";
import { ChatGPTConnectionView, ChatGPTPlanNotice } from "../src/components/ChatGPTConnectionView";

const health: HealthReport = { ok: true, v: 2, serverTime: "", uptimeMs: 0, seq: 0, providers: [], usageToday: { turns: 0, inputTokens: 0, outputTokens: 0 } };
const disconnected = { status: "disconnected" as const, accounts: [], activeAccountID: null, model: "", models: [] };
function setup() {
  const sent: ClientFrame[] = [];
  const model = new AppModel({ healthFetch: async () => health, healthPollMs: 0 });
  Object.assign(model, { connection: { send: async (frame: ClientFrame) => { sent.push(frame); } }, connectionState: { kind: "ready" } });
  model.prepareToAddProvider();
  const frame = (value: unknown) => act(() => (model as unknown as { handleFrame(frame: IncomingFrame): void }).handleFrame(value as IncomingFrame));
  return { model, sent, frame, wrap: (node: React.ReactNode) => render(<AppModelProvider model={model}>{node}</AppModelProvider>) };
}
beforeEach(() => { localStorage.clear(); vi.spyOn(window, "open").mockReturnValue(null); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ChatGPT provider onboarding", () => {
  it("defaults to ChatGPT with a single sign-in button and no API-key fields", () => {
    const h = setup(); h.wrap(<AddProviderView onDismiss={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("chatgpt");
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled();
    expect(screen.queryByLabelText("Provider API key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model ID")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(h.sent).toContainEqual({ type: "provider.auth.start", providerID: "chatgpt" });
    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
  });

  it("retains API-key setup for other providers", () => {
    const h = setup(); h.wrap(<AddProviderView onDismiss={() => {}} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "groq" } });
    expect(screen.getByLabelText("Provider API key")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save provider" })).toBeDisabled();
  });

  it("offers a safe fallback link when the popup is blocked", () => {
    const h = setup(); h.wrap(<AddProviderView onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    h.frame({ type: "provider.auth.started", seq: 1, providerID: "chatgpt", loginID: "login", authorizeURL: "https://auth.openai.com/api/accounts/authorize?state=unit", expiresAt: "2030-01-01T00:00:00Z" });
    expect(screen.getByRole("link", { name: "Open ChatGPT sign-in" })).toHaveAttribute("href", "https://auth.openai.com/api/accounts/authorize?state=unit");
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(h.sent).toContainEqual({ type: "provider.auth.cancel", providerID: "chatgpt", loginID: "login" });
    expect(screen.queryByRole("link", { name: "Open ChatGPT sign-in" })).not.toBeInTheDocument();
  });

  it("cancels a login even when the start reply arrives after the user dismisses", () => {
    const h = setup(); const dismiss = vi.fn(); h.wrap(<AddProviderView onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    h.frame({ type: "provider.auth.started", seq: 1, providerID: "chatgpt", loginID: "late-login", authorizeURL: "https://auth.openai.com/api/accounts/authorize", expiresAt: "2030-01-01T00:00:00Z" });
    expect(h.sent).toContainEqual({ type: "provider.auth.cancel", providerID: "chatgpt", loginID: "late-login" });
    expect(h.model.getSnapshot().chatgptLogin).toBeNull();
  });

  it("rejects unexpected authorization destinations and retained ID tokens", () => {
    const h = setup();
    for (const authorizeURL of ["https://attacker.test/login", "https://auth.openai.com/api/accounts/authorize?id_token_hint=unit"]) {
      act(() => h.model.startChatGPTLogin());
      h.frame({ type: "provider.auth.started", seq: 1, providerID: "chatgpt", loginID: "unit", authorizeURL, expiresAt: "2030-01-01T00:00:00Z" });
      expect(h.model.getSnapshot().chatgptLogin).toBeNull();
      expect(h.model.getSnapshot().chatgptError).toContain("could not be verified");
    }
  });

  it("shows account, reconnect action, disconnect, and subscription limits", () => {
    const h = setup();
    h.frame({ type: "provider.auth.state", seq: 1, providerID: "chatgpt", connection: { ...disconnected,
      status: "reauth_required", activeAccountID: "account-one", accounts: [{ id: "account-one", label: "unit@example.test · account", connected: false }], message: "Please sign in again." } });
    h.wrap(<ChatGPTConnectionView manage />);
    expect(screen.getByText("Sign in again")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Please sign in again.");
    expect(screen.getByRole("button", { name: "Disconnect ChatGPT" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(h.sent).toContainEqual({ type: "provider.auth.start", providerID: "chatgpt", accountID: "account-one" });
    expect(screen.getByRole("link", { name: "Manage ChatGPT usage and limits" })).toHaveAttribute("href", "https://chatgpt.com/settings/usage");
  });

  it("closes onboarding when login completes", () => {
    const h = setup(); const dismiss = vi.fn(); h.wrap(<AddProviderView onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    h.frame({ type: "provider.auth.state", seq: 1, providerID: "chatgpt", connection: { ...disconnected, status: "connected", activeAccountID: "unit", accounts: [{ id: "unit", label: "Account", connected: true }], model: "unit-model", models: [{ id: "unit-model", label: "Available model" }] } });
    expect(dismiss).toHaveBeenCalled();
    expect(h.model.getSnapshot().chatgptBusy).toBe(false);
  });

  it("shows the first-sign-in plan notice and acknowledges it on the server", () => {
    const h = setup();
    Object.assign(h.model, { screen: "chat" });
    const connection = { ...disconnected, status: "connected", activeAccountID: "unit", showWelcome: true };
    h.frame({ type: "provider.auth.state", seq: 1, providerID: "chatgpt", connection });
    h.wrap(<ChatGPTPlanNotice />);
    expect(screen.getByRole("dialog", { name: "You're using your ChatGPT plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(h.sent).toContainEqual({ type: "provider.auth.acknowledge", providerID: "chatgpt", accountID: "unit" });
    h.frame({ type: "provider.auth.state", seq: 2, providerID: "chatgpt", connection: { ...connection, showWelcome: false } });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
