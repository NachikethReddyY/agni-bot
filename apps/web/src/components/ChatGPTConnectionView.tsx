import { useState } from "react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { Spinner } from "./bits";

/** The same sign-in ceremony in onboarding and in account settings. */
export function ChatGPTConnectionView({ manage = false }: { manage?: boolean }) {
  const model = useAppModel();
  const { chatgpt: connection, chatgptLogin: login, chatgptBusy: busy, chatgptError: error, connectionState } = useAppSnapshot();
  const [chosenAccountID, setAccountID] = useState<string | null>(null);
  const accountID = chosenAccountID ?? (manage ? connection?.activeAccountID ?? connection?.accounts[0]?.id ?? "" : connection?.accounts.length === 1 && !connection.activeAccountID ? connection.accounts[0]!.id : "");
  const pending = connection?.status === "pending" || !!login;
  const active = connection?.accounts.find((a) => a.id === connection.activeAccountID);
  const disabled = busy || pending || connectionState.kind !== "ready";
  const connected = connection?.status === "connected";
  return (
    <div className="chatgpt-connection">
      {manage ? <h3>ChatGPT</h3> : null}
      <p>Use your existing ChatGPT plan. No API key needed.</p>
      <span className="settings-note">Your plan's usage limits apply. Agni uses this account for model requests while connected and keeps its own conversations and memory.</span>
      {active ? <div className="settings-row"><span>{active.label}</span><strong>{connected ? "Connected" : connection?.status === "reauth_required" ? "Sign in again" : "Needs attention"}</strong></div> : null}
      {connection?.accounts.length ? (
        <label className="field">
          <span className="field-label">ChatGPT account</span>
          <select className="select" value={accountID} disabled={disabled} onChange={(event) => setAccountID(event.target.value)}>
            <option value="">Add another account</option>
            {connection.accounts.map((account) => <option key={account.id} value={account.id}>{account.label}{account.id === connection.activeAccountID ? " (current)" : ""}</option>)}
          </select>
        </label>
      ) : null}
      <div className="chatgpt-actions">
        <button type="button" className="btn ink" disabled={disabled} onClick={() => model.startChatGPTLogin(accountID || undefined)}>
          {busy ? <Spinner /> : null} {pending ? "Waiting for sign-in…" : "Continue with ChatGPT"}
        </button>
        {manage && accountID && accountID !== connection?.activeAccountID && connection?.accounts.find((a) => a.id === accountID)?.connected ? (
          <button type="button" className="btn" disabled={disabled} onClick={() => model.changeChatGPTAccount(accountID)}>Use this account</button>
        ) : null}
        {pending && login ? <button type="button" className="btn" onClick={() => model.cancelChatGPTLogin()}>Cancel sign-in</button> : null}
        {manage && active ? <button type="button" className="btn" disabled={disabled} onClick={() => model.changeChatGPTAccount(active.id, true)}>Disconnect ChatGPT</button> : null}
      </div>
      {pending ? <span className="settings-note" role="status">Finish signing in on OpenAI's page, then return here. This step needs Agni and your browser on the same computer.</span> : null}
      {login ? <a className="link" href={login.authorizeURL} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a> : null}
      {error || connection?.message ? <p className="warning-text" role="alert">{error ?? connection?.message}</p> : null}
      {manage ? <a className="link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage ChatGPT usage and limits</a> : null}
    </div>
  );
}

export function ChatGPTPlanNotice() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  if (!snapshot.chatgpt?.showWelcome || snapshot.screen !== "chat") return null;
  return <div className="overlay chatgpt-welcome">
    <div className="dialog" role="dialog" aria-modal="true" aria-label="You're using your ChatGPT plan">
      <h2>You're using your ChatGPT plan</h2>
      <p>Eligible AI requests in Agni use your ChatGPT plan and its usage limits. You can manage Agni's allowance in ChatGPT settings.</p>
      <a className="link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>
      {snapshot.chatgptError ? <p className="warning-text" role="alert">{snapshot.chatgptError}</p> : null}
      <div className="dialog-actions"><span className="spacer" /><button type="button" className="btn ink" onClick={() => model.acknowledgeChatGPTPlan()}>Got it</button></div>
    </div>
  </div>;
}
