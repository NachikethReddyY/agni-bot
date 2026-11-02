/**
 * Browser-local preferences.
 *
 * These are the settings that belong to this browser, not to the daemon: who
 * gets a desktop notification, whether we tell the server we are typing, and
 * whether tool activity is drawn under an answer. They live in local storage
 * beside the token and the server address, and they are applied the moment
 * they change — a switch that does nothing would be a lie.
 */

export interface Preferences {
  /** Desktop notifications when the agent answers while you are elsewhere. */
  notifications: boolean;
  /** Send a typing indicator to the server while the composer has text. */
  typingIndicator: boolean;
  /** Draw the tool activity strip under each answer. */
  showActivity: boolean;
  /** Web Push when the app is closed (needs https or localhost; opt-in). */
  push: boolean;
  /** Agents pinned to the top of the roster. */
  favorites: string[];
}

const KEY = "dev.agni.web.preferences";

export function defaultPreferences(): Preferences {
  return {
    notifications: true,
    typingIndicator: true,
    showActivity: true,
    push: false,
    favorites: [],
  };
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadPreferences(): Preferences {
  const base = defaultPreferences();
  const store = storage();
  if (!store) return base;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      notifications: typeof parsed.notifications === "boolean" ? parsed.notifications : base.notifications,
      typingIndicator:
        typeof parsed.typingIndicator === "boolean" ? parsed.typingIndicator : base.typingIndicator,
      showActivity: typeof parsed.showActivity === "boolean" ? parsed.showActivity : base.showActivity,
      push: parsed.push === true,
      favorites: Array.isArray(parsed.favorites)
        ? parsed.favorites.filter((id): id is string => typeof id === "string")
        : base.favorites,
    };
  } catch {
    return base;
  }
}

export function savePreferences(preferences: Preferences): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(preferences));
  } catch {
    // A full or blocked store must never break the app.
  }
}
