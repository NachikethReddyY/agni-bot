/**
 * Connection setup: type the one-time code from `agni open` (the daemon sets a
 * session cookie), or connect to another server with a device token.
 */
import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Copy, Info } from "lucide-react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { FlameMark, Spinner, connectionStatusText, copyText } from "./bits";

export function PairingView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [url, setUrl] = useState(snapshot.settings.url);
  const [token, setToken] = useState(() => model.tokenForConnectionForm);
  const [deviceName, setDeviceName] = useState(snapshot.settings.deviceName);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const [code, setCode] = useState("");
  const safeName = deviceName.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const pairCommand = `bun run pair --name "${safeName}"`;
  const busy = snapshot.isCheckingServer || snapshot.isPairing;
  const canPair = token.trim().length > 0 && !busy;

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    model.pairWithCode(code, deviceName);
  };

  const submitToken = (event: FormEvent) => {
    event.preventDefault();
    model.pair(url, token, deviceName);
  };

  return (
    <div className="pairing">
      <div className="pairing-card">
        <div className="pairing-heading">
          <FlameMark size="medium" />
          <div className="pairing-heading-text">
            <h1>Connect to Agni</h1>
            <p>Connect this browser to the machine running your assistant.</p>
          </div>
        </div>

        <form className="pairing-steps" onSubmit={submitCode}>
          <section className="pairing-step">
            <div className="step-heading">Enter the pairing code</div>
            <p className="pairing-hint">
              <Info size={13} aria-hidden="true" />
              On the machine running Agni, run <code>agni open</code> (or <code>bun run open</code> in
              the repo) — it opens this page already paired, or shows a code to type here.
            </p>
            <input
              className="text-input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCD-EFGH"
              aria-label="Pairing code"
              autoComplete="one-time-code"
              spellCheck={false}
            />
            <label className="field">
              <span className="field-label">Browser name</span>
              <input
                className="text-input"
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                placeholder="This Browser"
              />
            </label>
          </section>
          <div className="pairing-actions">
            {(snapshot.tokenIsStored || snapshot.cookieSession) && !snapshot.isPairing ? (
              <button type="button" className="btn plain" onClick={() => model.cancelConnectionEdit()}>
                Back
              </button>
            ) : null}
            <span className="spacer" />
            <button type="submit" className="btn primary large" disabled={code.trim().length === 0 || busy}>
              {snapshot.isCheckingServer ? <Spinner /> : null}
              {snapshot.isCheckingServer ? "Checking…" : snapshot.isPairing ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>

        <details>
          <summary className="pairing-note">Connect to a different server with a device token</summary>
          <form className="pairing-steps" onSubmit={submitToken}>
            <section className="pairing-step">
              <div className="step-heading">
                <span className="step-number">1</span>
                Where is your Agni server?
              </div>
              <input
                className="text-input"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="127.0.0.1:8787"
                aria-label="Agni server address"
                autoComplete="url"
                spellCheck={false}
              />
              <p className="pairing-hint">
                <Info size={13} aria-hidden="true" />
                Another machine: enter its Tailscale address, such as 100.x.x.x:8787.
              </p>
            </section>

            <section className="pairing-step">
              <div className="step-heading">
                <span className="step-number">2</span>
                Pair this browser
              </div>
              <p className="pairing-note">
                On the machine running Agni, run this command and copy the token it prints:
              </p>

              <div className="pairing-command">
                <code title={pairCommand}>{pairCommand}</code>
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    void copyText(pairCommand).then((ok) => setCopied(ok));
                  }}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <label className="field">
                <span className="field-label">Device token</span>
                <input
                  className="text-input"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Paste the token shown by the command"
                  autoComplete="current-password"
                />
              </label>

              <p className="pairing-note">
                The token is stored in this browser's local storage and can be revoked from
                the server at any time.
              </p>
            </section>
            <div className="pairing-actions">
              <span className="spacer" />
              <button type="submit" className="btn" disabled={!canPair}>
                Connect with token
              </button>
            </div>
          </form>
        </details>

        {snapshot.pairingError ? (
          <p className="pairing-error" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            {snapshot.pairingError}
          </p>
        ) : null}

        {snapshot.isPairing ? (
          <div className="pairing-status">
            <Spinner />
            <span>{connectionStatusText(snapshot.connectionState)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
