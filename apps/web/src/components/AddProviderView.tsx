/** Add one API provider key to the daemon. The browser never keeps a copy. */
import { useEffect, useState } from "react";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { Spinner } from "./bits";
import { ChatGPTConnectionView } from "./ChatGPTConnectionView";

interface ProviderOption {
  id: string;
  title: string;
  note: string;
}

const OPTIONS: ProviderOption[] = [
  { id: "chatgpt", title: "ChatGPT", note: "Sign in with your existing ChatGPT account" },
  { id: "groq", title: "Groq", note: "Fast" },
  { id: "cerebras", title: "Cerebras", note: "Fast" },
  { id: "nim", title: "NVIDIA NIM", note: "Free credits · all lanes" },
  { id: "gemini", title: "Gemini", note: "Free tier · task and deep lanes" },
  { id: "openrouter", title: "OpenRouter", note: "Free models · deep lane" },
  { id: "custom", title: "Custom endpoint", note: "Any OpenAI-compatible URL · token router, proxy" },
];

const SUGGESTED_MODELS: Record<string, string> = {
  groq: "llama-3.1-8b-instant",
  cerebras: "llama3.1-8b",
  nim: "meta/llama-3.3-70b-instruct",
  gemini: "gemini-2.0-flash",
  openrouter: "meta-llama/llama-3.3-70b-instruct:free",
  custom: "",
};

const CUSTOM_ID = "custom";

export function AddProviderView({ onDismiss }: { onDismiss: () => void }) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [providerID, setProviderID] = useState("chatgpt");
  const [apiKey, setApiKey] = useState("");
  const [modelID, setModelID] = useState(SUGGESTED_MODELS.groq ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [label, setLabel] = useState("");

  const configured = new Set(snapshot.health?.providers.map((provider) => provider.id) ?? []);
  // Custom endpoints get their own id when they are added, so the option is
  // hidden once one exists rather than when the literal id is configured.
  const hasCustom = [...configured].some((id) => id.startsWith(CUSTOM_ID));
  const available = OPTIONS.filter((option) =>
    option.id === CUSTOM_ID ? !hasCustom : !configured.has(option.id),
  );
  const availableKey = available.map((option) => option.id).join(",");

  useEffect(() => {
    if (!available.some((option) => option.id === providerID)) {
      const first = available[0];
      if (first) {
        setProviderID(first.id);
        setModelID(SUGGESTED_MODELS[first.id] ?? "");
      }
    }
    // The available set is captured by its key so the effect is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableKey]);

  useEffect(() => {
    if (snapshot.providerAddSuccess) onDismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.providerAddSuccess]);

  const option = available.find((candidate) => candidate.id === providerID);
  const isCustom = providerID === CUSTOM_ID;
  const canSave =
    available.length > 0 &&
    apiKey.trim().length > 0 &&
    (!isCustom || (baseUrl.trim().length > 0 && modelID.trim().length > 0)) &&
    !snapshot.isAddingProvider;

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) { model.cancelChatGPTLogin(); onDismiss(); }
      }}
    >
      <div className="dialog wide" role="dialog" aria-label="Add a provider">
        <div>
          <h2>Add a provider</h2>
          <p style={{ marginTop: 4 }}>Connect your ChatGPT account or add an API provider.</p>
        </div>

        {available.length === 0 ? (
          <p>All supported providers are already configured.</p>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Provider</span>
              <select
                className="select"
                value={providerID}
                aria-label="Provider"
                onChange={(event) => {
                  const id = event.target.value;
                  if (providerID === "chatgpt" && id !== providerID) model.cancelChatGPTLogin();
                  setProviderID(id);
                  setModelID(SUGGESTED_MODELS[id] ?? "");
                }}
              >
                {available.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </option>
                ))}
              </select>
            </label>
            {option ? <span className="settings-note">{option.note}</span> : null}

            {providerID === "chatgpt" ? <ChatGPTConnectionView /> : <>
            {isCustom ? (
              <>
                <label className="field">
                  <span className="field-label">Endpoint URL</span>
                  <input
                    className="text-input"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://your-router.example/v1"
                    aria-label="Endpoint URL"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="settings-note">
                    The base URL of an OpenAI-compatible endpoint — your token router, a proxy, or a
                    self-hosted gateway. The daemon calls {"/chat/completions"} on it.
                  </span>
                </label>

                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    className="text-input"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    placeholder="Token Router"
                    aria-label="Endpoint name"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <span className="settings-note">How this endpoint is named in the list. The host is used when left empty.</span>
                </label>
              </>
            ) : null}

            <label className="field">
              <span className="field-label">API key</span>
              <input
                className="text-input"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="API key"
                aria-label="Provider API key"
                autoComplete="off"
              />
            </label>

            <label className="field">
              <span className="field-label">Model ID</span>
              <input
                className="text-input"
                value={modelID}
                onChange={(event) => setModelID(event.target.value)}
                placeholder="Model ID"
                aria-label="Model ID"
                spellCheck={false}
              />
              <span className="settings-note">
                {isCustom
                  ? "The model ID your endpoint serves — the name it knows that model by."
                  : "Use the model ID shown by your provider. Leave the suggested ID unless you want a different supported model."}
              </span>
            </label>

            <span className="settings-note">
              The key is sent to your connected daemon and saved in the daemon host's mode-600
              .env file. The app does not keep a copy.
            </span>
            </>}
          </>
        )}

        {providerID !== "chatgpt" && snapshot.providerAddError ? <p className="warning-text">{snapshot.providerAddError}</p> : null}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => { model.cancelChatGPTLogin(); onDismiss(); }}>
            Cancel
          </button>
          <span className="spacer" />
          {providerID !== "chatgpt" ? <button
            type="button"
            className="btn primary"
            disabled={!canSave}
            onClick={() => {
              const key = apiKey;
              setApiKey("");
              model.addProvider(providerID, key, modelID, isCustom ? baseUrl : undefined, isCustom ? label : undefined);
            }}
          >
            {snapshot.isAddingProvider ? <Spinner /> : null}
            Save provider
          </button> : null}
        </div>
      </div>
    </div>
  );
}
