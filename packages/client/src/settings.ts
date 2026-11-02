/**
 * Where the token and the server address live in a browser.
 *
 * The Mac app used Keychain. A web app has no Keychain: the honest equivalent
 * is this browser's local storage, scoped to the app's origin. The token never
 * leaves the machine except to the daemon it was minted for, and the UI says
 * so. Settings (address, device name, replay cursor) live beside it.
 */

export interface ServerSettings {
  url: string;
  deviceName: string;
  /** Highest server frame seq this browser has seen. */
  lastSeq: number;
}

const SETTINGS_KEY = "dev.agni.web.settings";
const TOKEN_KEY = "dev.agni.web.device-token";

export type SecretStoreKind = "browser" | "memory";

export function defaultServerSettings(): ServerSettings {
  return {
    url: pageOrigin() ?? "127.0.0.1:8787",
    deviceName: browserDeviceName(),
    lastSeq: 0,
  };
}

/** The page's own origin when served over http(s): the daemon serves the web app. */
export function pageOrigin(): string | null {
  if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return null;
  return `${location.protocol}//${location.host}`;
}

function browserDeviceName(): string {
  if (typeof navigator === "undefined") return "This Browser";
  const platform = navigator.platform || "";
  if (/Mac/i.test(platform)) return "This Mac";
  if (/Win/i.test(platform)) return "This PC";
  if (/Linux|X11/i.test(platform)) return "This Computer";
  return "This Browser";
}

/** Minimal storage facade so tests (and SSR) do not need a DOM. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = "__agni_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Accept host[:port], http(s)://…, ws(s)://… — people type all four.
 * A bare host means the daemon's default port; a typed scheme keeps its own,
 * so a real wss:// endpoint is not dragged onto 8787.
 */
export function websocketURL(settings: Pick<ServerSettings, "url">): string | null {
  const trimmed = settings.url.trim();
  if (trimmed.length === 0) return null;

  const typedScheme = trimmed.includes("://");
  let text = trimmed;
  if (!typedScheme) text = `ws://${text}`;
  if (text.startsWith("http://")) text = `ws://${text.slice("http://".length)}`;
  if (text.startsWith("https://")) text = `wss://${text.slice("https://".length)}`;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.hostname.length === 0) return null;

  if (parsed.protocol === "wss:") {
    parsed.protocol = "wss:";
  } else if (parsed.protocol === "ws:") {
    parsed.protocol = "ws:";
  } else {
    return null;
  }

  if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/ws";
  if (!typedScheme && parsed.port === "") parsed.port = "8787";
  return parsed.toString();
}

export function healthURL(settings: Pick<ServerSettings, "url">): string | null {
  const ws = websocketURL(settings);
  if (!ws) return null;
  const parsed = new URL(ws);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/health";
  parsed.search = "";
  return parsed.toString();
}

export class SettingsStore {
  constructor(private readonly storage: KeyValueStorage = browserStorage() ?? new MemoryStorage()) {}

  load(): ServerSettings {
    const raw = this.storage.getItem(SETTINGS_KEY);
    if (!raw) return defaultServerSettings();
    try {
      const value = JSON.parse(raw) as Partial<ServerSettings>;
      if (typeof value.url !== "string" || typeof value.deviceName !== "string") {
        return defaultServerSettings();
      }
      return {
        url: value.url,
        deviceName: value.deviceName,
        lastSeq: typeof value.lastSeq === "number" && Number.isFinite(value.lastSeq) ? value.lastSeq : 0,
      };
    } catch {
      return defaultServerSettings();
    }
  }

  save(settings: ServerSettings): void {
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private mode / quota: settings just do not survive a reload.
    }
  }
}

/**
 * Device token storage. Browser storage is the web equivalent of the Keychain
 * fallback file: mode-600 on disk has no analogue, so the UI states plainly
 * where the token lives. `memory` is used when storage is unavailable.
 */
export const SecretStore = {
  memoryToken: null as string | null,
  memoryKind: "memory" as SecretStoreKind,

  load(): { token: string; kind: SecretStoreKind } | null {
    const storage = browserStorage();
    if (storage) {
      const token = storage.getItem(TOKEN_KEY)?.trim();
      if (token) return { token, kind: "browser" };
    }
    if (this.memoryToken) return { token: this.memoryToken, kind: "memory" };
    return null;
  },

  save(token: string): SecretStoreKind {
    const trimmed = token.trim();
    const storage = browserStorage();
    if (storage) {
      try {
        storage.setItem(TOKEN_KEY, trimmed);
        return "browser";
      } catch {
        // fall through to memory
      }
    }
    this.memoryToken = trimmed;
    return "memory";
  },

  clear(): void {
    const storage = browserStorage();
    storage?.removeItem(TOKEN_KEY);
    this.memoryToken = null;
  },
};
