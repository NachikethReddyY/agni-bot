/**
 * The root: pairing or the two-column chat window, plus the overlays that can
 * appear over either. Keyboard commands mirror the Agni menu in the Mac app.
 */
import { useEffect, type CSSProperties } from "react";
import { AlertTriangle, BellRing, X } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { themeFor, themeVariables } from "../theme";
import { AgentSwitcherView } from "./AgentSwitcherView";
import { AgentProfileView } from "./AgentProfileView";
import { PairingView } from "./PairingView";
import { SettingsView } from "./SettingsView";
import { SidebarView } from "./SidebarView";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadView } from "./ThreadView";
import { InspectorView } from "./InspectorView";
import { ChatGPTPlanNotice } from "./ChatGPTConnectionView";

export function RootView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (snapshot.isAgentSwitcherPresented) model.closeAgentSwitcher();
        else model.openAgentSwitcher();
        return;
      }
      if (command && event.shiftKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        model.toggleInspector();
        return;
      }
      if (command && event.shiftKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        model.reloadConversation();
        return;
      }
      if (command && event.key === ".") {
        event.preventDefault();
        model.stopTurn();
        return;
      }
      if (event.key === "Escape") {
        if (snapshot.isSettingsPresented) {
          model.closeSettings();
        } else if (snapshot.isAgentSwitcherPresented) {
          model.closeAgentSwitcher();
        } else if (snapshot.isAgentProfilePresented) {
          model.closeAgentProfile();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [model, snapshot.isAgentSwitcherPresented, snapshot.isSettingsPresented, snapshot.isAgentProfilePresented]);

  return (
    <div className="app" style={themeVariables(themeFor(model.agent?.color)) as CSSProperties}>
      {snapshot.screen === "pairing" ? <PairingView /> : <ChatView />}
      {snapshot.isAgentSwitcherPresented ? <AgentSwitcherView /> : null}
      {snapshot.isSettingsPresented ? <SettingsView /> : null}
      <ChatGPTPlanNotice />
      {snapshot.toast ? <Toast /> : null}
    </div>
  );
}

function ChatView() {
  const snapshot = useAppSnapshot();
  const model = useAppModel();
  return (
    <>
      <SidebarView />
      {snapshot.isSidebarPresented ? (
        <div className="drawer-backdrop" onClick={() => model.closeSidebar()} />
      ) : null}
      <main className="chat-main">
        <ThreadHeader />
        <ThreadView />
      </main>
      {snapshot.isAgentProfilePresented ? <AgentProfileView /> : null}
      {snapshot.isInspectorPresented ? <InspectorView /> : null}
    </>
  );
}

function Toast() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const toast = snapshot.toast;
  if (!toast) return null;
  const failure = toast.kind === "failure";
  return (
    <div className="toast" role="status" onClick={() => model.dismissToast()}>
      <span className={`toast-icon ${failure ? "failure" : "info"}`}>
        {failure ? <AlertTriangle size={13} /> : <BellRing size={13} />}
      </span>
      <div className="toast-text">
        <div className="toast-title">{toast.title}</div>
        <div className="toast-body">{toast.body}</div>
      </div>
      <button
        type="button"
        className="icon-btn toast-close"
        aria-label="Dismiss"
        onClick={(event) => {
          event.stopPropagation();
          model.dismissToast();
        }}
      >
        <X size={10} strokeWidth={2.4} />
      </button>
    </div>
  );
}
