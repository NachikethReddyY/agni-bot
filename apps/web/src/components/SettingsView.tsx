/**
 * App settings reached from the account control at the bottom of the sidebar:
 * account, plugins, model providers, and this browser's pairing.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Cpu,
  Key,
  Laptop,
  Link as LinkIcon,
  Pencil,
  Palette,
  Plus,
  Puzzle,
  Settings,
  UserRound,
} from "lucide-react";
import type { PluginInfo, ProviderStatus } from "@agni/client";
import { useAppModel, useAppSnapshot } from "../state/use-app-model";
import { PresenceDot, Spinner, Switch } from "./bits";
import { AddProviderView } from "./AddProviderView";
import { ConfigurePluginView } from "./ConfigurePluginView";
import { ChatGPTConnectionView } from "./ChatGPTConnectionView";
import { AppearanceView } from "./AppearanceView";

type Section = "general" | "appearance" | "plugins" | "models" | "device";

const SECTIONS: { id: Section; title: string; icon: typeof Settings; subtitle: string }[] = [
  {
    id: "appearance",
    title: "Appearance",
    icon: Palette,
    subtitle: "Themes, colour, backgrounds and interface comfort.",
  },
  {
    id: "general",
    title: "General",
    icon: Settings,
    subtitle: "Account, appearance and system preferences.",
  },
  {
    id: "plugins",
    title: "Plugins",
    icon: Puzzle,
    subtitle: "Connections Agni can use on your behalf. Tokens stay on the daemon.",
  },
  {
    id: "models",
    title: "Models & providers",
    icon: Cpu,
    subtitle: "Connect ChatGPT or an API provider. Credentials stay on your Agni server.",
  },
  {
    id: "device",
    title: "This Browser",
    icon: Laptop,
    subtitle: "This browser and how it pairs with the daemon.",
  },
];

export function SettingsView() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [section, setSection] = useState<Section>("plugins");
  const [addingProvider, setAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderStatus | null>(null);
  const [connectingPlugin, setConnectingPlugin] = useState<PluginInfo | null>(null);

  useEffect(() => {
    void model.refreshSettingsData();
    // The pane refreshes once when it opens, like the Mac sheet's .task.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = SECTIONS.find((item) => item.id === section) ?? SECTIONS[0]!;

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings">
      <nav className="settings-rail">
        <h2>Settings</h2>
        <div className="settings-tabs">
          {SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={`settings-tab${section === item.id ? " active" : ""}`}
                onClick={() => setSection(item.id)}
              >
                <Icon size={14} />
                {item.title}
              </button>
            );
          })}
        </div>
        <span className="settings-rail-spacer" />
        <button type="button" className="settings-back" onClick={() => model.closeSettings()}>
          <ArrowLeft size={13} />
          Back to chat
        </button>
      </nav>

      <div className="settings-body">
        <div className="settings-content">
          <div className="settings-heading">
            <h1>{current.title}</h1>
            <p>{current.subtitle}</p>
          </div>

          {section === "general" ? <GeneralSection /> : null}
          {section === "appearance" ? <AppearanceView /> : null}
          {section === "plugins" ? <PluginsSection onConnect={setConnectingPlugin} /> : null}
          {section === "models" ? (
            <ModelsSection
              onAdd={() => {
                model.prepareToAddProvider();
                setAddingProvider(true);
              }}
              onEdit={(provider) => { model.prepareToAddProvider(); setEditingProvider(provider); }}
            />
          ) : null}
          {section === "device" ? <DeviceSection /> : null}
        </div>
      </div>

      {addingProvider ? <AddProviderView onDismiss={() => setAddingProvider(false)} /> : null}
      {editingProvider ? (
        <ProviderModelEditor provider={editingProvider} onDismiss={() => setEditingProvider(null)} />
      ) : null}
      {connectingPlugin ? (
        <ConfigurePluginView plugin={connectingPlugin} onDismiss={() => setConnectingPlugin(null)} />
      ) : null}
      <span hidden>{snapshot.screen}</span>
    </div>
  );
}

function GeneralSection() {
  return (
    <div className="settings-section">
      <div className="settings-group">
        <h3>Account</h3>
        <div className="settings-group-head">
          <UserRound size={28} color="var(--ember)" />
          <div>
            <div className="plugin-name">Agni</div>
            <div className="settings-note">Your personal assistant</div>
          </div>
        </div>
      </div>
      <PreferencesGroup />
      <ConnectionGroup />
    </div>
  );
}

/**
 * Browser-local preferences. Each switch changes something real, right away:
 * the notification is posted or not, the typing indicator is sent or not, and
 * the tool activity is drawn or not.
 */
function PreferencesGroup() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const preferences = snapshot.preferences;
  return (
    <div className="settings-section">
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>This browser</h3>
        <div className="settings-note">Preferences live in this browser, not on the daemon.</div>
      </div>
      <div className="settings-group preference-group">
        <PreferenceRow
          label="Desktop notifications"
          note="A quiet notification when the agent answers while you are elsewhere."
        >
          <Switch
            label="Desktop notifications"
            checked={preferences.notifications}
            onChange={(next) => model.setPreference("notifications", next)}
          />
        </PreferenceRow>
        <PreferenceRow
          label="Show that you are typing"
          note="Tells the agent you are mid-sentence, so it does not answer too early."
        >
          <Switch
            label="Show that you are typing"
            checked={preferences.typingIndicator}
            onChange={(next) => model.setPreference("typingIndicator", next)}
          />
        </PreferenceRow>
        <PreferenceRow
          label="Tool activity"
          note="Show the quiet strip under an answer that says what the agent ran."
        >
          <Switch
            label="Tool activity"
            checked={preferences.showActivity}
            onChange={(next) => model.setPreference("showActivity", next)}
          />
        </PreferenceRow>
      </div>
    </div>
  );
}

function PreferenceRow({
  label,
  note,
  children,
}: {
  label: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="preference-row">
      <div className="preference-text">
        <div className="preference-label">{label}</div>
        <div className="settings-note">{note}</div>
      </div>
      {children}
    </div>
  );
}

function PluginsSection({ onConnect }: { onConnect: (plugin: PluginInfo) => void }) {
  return (
    <div className="settings-section">
      <PluginGroup
        title="Agent-owned"
        subtitle="Agni's own accounts — it acts freely within Google's limits."
        account="agent"
        onConnect={onConnect}
      />
      <PluginGroup
        title="Your accounts"
        subtitle="Your data — reads and drafts are direct; sends, creates and shares ask first."
        account="owner"
        onConnect={onConnect}
      />
    </div>
  );
}

function PluginGroup({
  title,
  subtitle,
  account,
  onConnect,
}: {
  title: string;
  subtitle: string;
  account: "agent" | "owner";
  onConnect: (plugin: PluginInfo) => void;
}) {
  const snapshot = useAppSnapshot();
  const rows = snapshot.plugins.filter((plugin) => plugin.account === account);
  return (
    <div className="settings-section">
      <div>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{title}</h3>
        <div className="settings-note">{subtitle}</div>
      </div>
      <div className="settings-group">
        {rows.length === 0 ? (
          <span className="settings-note">No plugins in this group.</span>
        ) : (
          rows.map((plugin) => (
            <PluginRow key={`${plugin.id}_${plugin.account}`} plugin={plugin} onConnect={onConnect} />
          ))
        )}
      </div>
    </div>
  );
}

function PluginRow({
  plugin,
  onConnect,
}: {
  plugin: PluginInfo;
  onConnect: (plugin: PluginInfo) => void;
}) {
  const model = useAppModel();
  const status = plugin.status ?? "disconnected";
  const statusClass = status === "connected" ? "connected" : status === "pending" ? "pending" : status === "error" ? "error" : "off";
  const statusText =
    status === "connected"
      ? "Connected"
      : status === "pending"
        ? "Connecting…"
        : status === "error"
          ? "Error"
          : "Not connected";

  return (
    <div className="plugin-row">
      <span className="plugin-icon">
        {plugin.authKind === "oauth" ? (
          <LinkIcon size={14} />
        ) : plugin.authKind === "api-key" ? (
          <Key size={14} />
        ) : (
          <Puzzle size={14} />
        )}
      </span>
      <div className="plugin-main">
        <div className="plugin-name-line">
          <span className="plugin-name">{plugin.name}</span>
          <span className={`chip ${statusClass}`}>{statusText}</span>
        </div>
        <div className="plugin-description">{plugin.description}</div>
        {plugin.accountLabel ? <div className="plugin-account">{plugin.accountLabel}</div> : null}
        {plugin.error ? <div className="plugin-error">{plugin.error}</div> : null}
      </div>
      {status === "connected" ? (
        <button
          type="button"
          className="btn small danger"
          onClick={() => {
            if (plugin.connectionID) model.disconnectPlugin(plugin.connectionID);
          }}
        >
          Disconnect
        </button>
      ) : status === "pending" ? (
        <button type="button" className="btn small" disabled>
          Waiting…
        </button>
      ) : !plugin.available ? (
        <button type="button" className="btn small" disabled>
          Coming soon
        </button>
      ) : (
        <button
          type="button"
          className="btn primary small"
          onClick={() => onConnect(plugin)}
        >
          Connect
        </button>
      )}
    </div>
  );
}

function ModelsSection({ onAdd, onEdit }: { onAdd: () => void; onEdit: (provider: ProviderStatus) => void }) {
  const snapshot = useAppSnapshot();
  return (
    <div className="settings-section">
      <div className="settings-group">
        <div className="settings-group-head">
          <div>
            <h3>Connected providers</h3>
            <div className="settings-note">Agni routes requests across available models automatically.</div>
          </div>
          <span className="spacer" />
          <button
            type="button"
            className="btn primary small"
            disabled={snapshot.connectionState.kind !== "ready"}
            onClick={onAdd}
          >
            <Plus size={12} /> Add provider
          </button>
        </div>

        {snapshot.configuredProviders.length > 0 ? (
          snapshot.configuredProviders.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} onEdit={() => onEdit(provider)} />
          ))
        ) : snapshot.health ? (
          <div className="empty-note" style={{ background: "transparent", border: "none", padding: 0 }}>
            <strong>No model providers connected</strong>
            <span>
              Connect your ChatGPT account or add an API provider to start chatting.
            </span>
          </div>
        ) : (
          <span className="settings-note">{snapshot.healthError ?? "Waiting for the daemon status…"}</span>
        )}

        {snapshot.providerAddSuccess ? (
          <span style={{ color: "#4ade80", fontSize: 12 }}>✓ {snapshot.providerAddSuccess}</span>
        ) : null}
        <span className="settings-note">
          Connect ChatGPT with your existing plan, or use Groq, Cerebras, NVIDIA NIM, Gemini, and OpenRouter API keys.
          Local models can be served by LM Studio on the daemon host.
        </span>
        <span className="settings-note">
          Model choices are saved on the daemon in data/providers.json. Provider API keys stay
          in its mode-600 .env file.
        </span>
      </div>
      {snapshot.configuredProviders.length === 0 || (snapshot.chatgpt?.accounts.length ?? 0) > 0 || snapshot.chatgpt?.status === "pending" ? <div className="settings-group"><ChatGPTConnectionView manage /></div> : null}
    </div>
  );
}

function ProviderRow({ provider, onEdit }: { provider: ProviderStatus; onEdit: () => void }) {
  return (
    <div className="plugin-row">
      <span className={`provider-dot${provider.available ? "" : " off"}`} style={{ marginTop: 6 }} />
      <div className="plugin-main">
        <div className="provider-name">{provider.label}</div>
        <div className="provider-model">{provider.model}</div>
        <div className={`settings-note${provider.available ? "" : " warning-text"}`}>
          {provider.available ? provider.tiers.join(" · ") : provider.lastError ?? "Unavailable"}
        </div>
      </div>
      <span className="settings-note" style={{ color: provider.available ? "#4ade80" : "#f0a04b" }}>
        {provider.available ? "Ready" : "Needs attention"}
      </span>
      <button
        type="button"
        className="icon-btn"
        title="Choose model"
        aria-label={`Choose model for ${provider.label}`}
        onClick={onEdit}
      >
        <Pencil size={12} />
      </button>
    </div>
  );
}

function DeviceSection() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  return (
    <div className="settings-section">
      <div className="settings-group">
        <h3>This Browser</h3>
        <div className="settings-row">
          <span>Device</span>
          <span className="spacer" />
          <strong>{snapshot.settings.deviceName}</strong>
        </div>
        <div className="settings-row">
          <span>Token storage</span>
          <span className="spacer" />
          <strong>
            {snapshot.secretKind === "memory" ? "Memory for this session" : "Browser local storage"}
          </strong>
        </div>
        <button
          type="button"
          className="btn danger"
          style={{ alignSelf: "flex-start" }}
          onClick={() => model.forgetDevice()}
        >
          Forget this device
        </button>
      </div>
      <ConnectionGroup />
    </div>
  );
}

function ConnectionGroup() {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  return (
    <div className="settings-group">
      <h3>Connection</h3>
      <div className="popover-row">
        <PresenceDot online={snapshot.connectionState.kind === "ready"} />
        <strong style={{ fontSize: 14, fontWeight: 500 }}>
          {snapshot.connectionState.kind === "ready" ? "Agni is connected" : "Agni is disconnected"}
        </strong>
      </div>
      <span className="machine" style={{ color: "var(--ink-secondary)", userSelect: "text" }}>
        {snapshot.settings.url}
      </span>
      <button
        type="button"
        className="btn"
        style={{ alignSelf: "flex-start" }}
        onClick={() => model.editConnection()}
      >
        Connection settings…
      </button>
    </div>
  );
}

function ProviderModelEditor({
  provider,
  onDismiss,
}: {
  provider: ProviderStatus;
  onDismiss: () => void;
}) {
  const model = useAppModel();
  const snapshot = useAppSnapshot();
  const [draft, setDraft] = useState(provider.model);
  const [selectedModel, setSelectedModel] = useState(provider.model);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    model.loadProviderModels(provider.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  useEffect(() => {
    const models = snapshot.providerModels;
    if (models.length === 0) return;
    const first = models[0];
    if (!first) return;
    const choice = models.includes(provider.model) ? provider.model : first;
    setSelectedModel(choice);
    setDraft(choice);
    setCustom(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.providerModels]);

  useEffect(() => {
    if (snapshot.providerAddSuccess) onDismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.providerAddSuccess]);

  const isChatGPT = provider.id === "chatgpt";
  const showInput = !isChatGPT && (snapshot.providerModels.length === 0 || custom);
  const canSave = !snapshot.isAddingProvider && draft.trim().length > 0 && (!isChatGPT || snapshot.providerModels.includes(draft));

  return (
    <div
      className="overlay"
      style={{ zIndex: 85 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div className="dialog wide" role="dialog" aria-label="Choose a model">
        <div>
          <h2>Choose a model</h2>
          <p style={{ marginTop: 4 }}>
            {isChatGPT ? "Choose a model available to your ChatGPT account." : `Enter a model ID supported by ${provider.label}. The daemon will route future requests to it.`}
          </p>
        </div>

        {snapshot.providerModels.length > 0 ? (
          <label className="field">
            <span className="field-label">Available models</span>
            <select
              className="select"
              value={selectedModel}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedModel(value);
                if (value === "__custom__") {
                  setCustom(true);
                  setDraft("");
                } else {
                  setCustom(false);
                  setDraft(value);
                }
              }}
            >
              {snapshot.providerModels.map((modelID) => (
                <option key={modelID} value={modelID}>
                  {isChatGPT ? snapshot.chatgpt?.models.find((m) => m.id === modelID)?.label ?? modelID : modelID}
                </option>
              ))}
              {!isChatGPT ? <option value="__custom__">Enter a custom model ID…</option> : null}
            </select>
          </label>
        ) : null}

        {showInput ? (
          <label className="field">
            <span className="field-label">Model ID</span>
            <input
              className="text-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Model ID"
              spellCheck={false}
            />
          </label>
        ) : null}

        {snapshot.providerModelsError ? (
          <div className="popover-row">
            <span className="warning-text" style={{ fontSize: 11, flex: 1 }}>
              {snapshot.providerModelsError}
            </span>
            <button type="button" className="link" onClick={() => model.loadProviderModels(provider.id)}>
              Retry
            </button>
          </div>
        ) : null}
        {snapshot.providerAddError ? <p className="warning-text">{snapshot.providerAddError}</p> : null}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onDismiss}>
            Cancel
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn primary"
            disabled={!canSave}
            onClick={() => model.setProviderModel(provider.id, draft)}
          >
            {snapshot.isAddingProvider ? <Spinner /> : null}
            Save model
          </button>
        </div>
      </div>
    </div>
  );
}
