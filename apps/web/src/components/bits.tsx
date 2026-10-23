/**
 * Identity and chrome shared by every view: the flame, agent badges, presence,
 * hairlines, and the tiny string helpers that name a connection state.
 */
import { Flame } from "lucide-react";
import type { ConnectionState } from "@agni/client";
import type { AgentInfo } from "@agni/client";
import { isPrimaryAgent } from "../state/app-model";
import { APP_MARKS, APP_MONOGRAMS } from "./app-marks";

export type FlameSize = "small" | "medium" | "large";

const FLAME_POINTS: Record<FlameSize, number> = {
  small: 16,
  medium: 26,
  large: 56,
};

/** The flame. One shape, three sizes, and a pulse that means "working". */
export function FlameMark({ size = "medium", alive = false }: { size?: FlameSize; alive?: boolean }) {
  const points = FLAME_POINTS[size];
  return (
    <span
      className={`flame-mark${alive ? " alive" : ""}`}
      style={{ width: points, height: points }}
      aria-hidden="true"
    >
      <Flame size={points} strokeWidth={1.8} fill="currentColor" />
    </span>
  );
}

/** Server colours arrive as `#rrggbb`; anything else falls back to amber. */
export function serverColor(value: string | null | undefined): string {
  if (!value) return "#f0b95a";
  const cleaned = value.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(cleaned)) return "#f0b95a";
  return `#${cleaned}`;
}

function withAlpha(hex: string, alpha: number): string {
  const value = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${value}`;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => Array.from(part)[0] ?? "").join("").toUpperCase() || "A";
}

/** Agent avatar: the flame for Agni, a coloured monogram for everyone else. */
export function AgentAvatar({
  agent,
  alive = false,
  size = "medium",
}: {
  agent: AgentInfo | null | undefined;
  alive?: boolean;
  size?: FlameSize;
}) {
  const points = FLAME_POINTS[size];
  if (!isPrimaryAgent(agent)) {
    const color = serverColor(agent?.color);
    return (
      <span
        className="avatar"
        style={{
          width: points + 10,
          height: points + 10,
          background: withAlpha(color, 0.22),
          color,
          fontSize: points * 0.42,
        }}
        aria-label={agent?.name ?? "Agent"}
      >
        {initials(agent?.name ?? "A")}
      </span>
    );
  }
  return (
    <span
      className="avatar"
      style={{ width: points + 10, height: points + 10 }}
      aria-label={agent?.name ?? "Agni"}
    >
      <FlameMark size={size} alive={alive} />
    </span>
  );
}

/** Compact circular identity badge used in the agent list and chat header. */
export function SidebarAgentBadge({
  agent,
  size,
}: {
  agent: AgentInfo | null | undefined;
  size: number;
}) {
  const primary = isPrimaryAgent(agent);
  const background = primary ? "#ea9a3e" : serverColor(agent?.color);
  return (
    <span
      className="badge"
      style={{ width: size, height: size, background, fontSize: size * 0.34 }}
      aria-label={agent?.name ?? "Agni"}
    >
      {primary ? (
        <Flame size={size * 0.48} strokeWidth={1.8} fill="currentColor" />
      ) : (
        initials(agent?.name ?? "A")
      )}
    </span>
  );
}

/** Presence: a dot that is ember when the daemon is reachable, quiet when not. */
export function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      className={`presence-dot${online ? " online" : ""}`}
      role="img"
      aria-label={online ? "Connected" : "Offline"}
    />
  );
}

/** A hairline that reads as structure, not decoration. */
export function Hairline() {
  return <div className="hairline" role="separator" />;
}

/**
 * A connected app, as a tile: its own brand mark on a light chip, the way the
 * app switcher shows it. Brands we have a mark for get the real thing; the
 * rest get a quiet monogram, so the row never lies about what is connected.
 */
export function AppTile({ plugin }: { plugin: { id: string; name: string } }) {
  const mark = APP_MARKS[plugin.id];
  if (mark) {
    return (
      <span className="app-tile" style={{ background: mark.chip }} aria-hidden="true">
        <svg className="app-tile-mark" viewBox="0 0 24 24" focusable="false">
          <path d={mark.path} fill={mark.color} />
        </svg>
      </span>
    );
  }
  const mono = APP_MONOGRAMS[plugin.id];
  const glyph = mono?.glyph ?? Array.from(plugin.name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      className="app-tile app-tile-mono"
      style={{ background: mono?.chip ?? "#2a2a2d", color: mono?.ink ?? "#d4d4d8" }}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Working" />;
}

/**
 * A switch, the way the reference app sets a preference: one tap, one state,
 * and the label says what it changes. It is a real button, so it works with
 * a keyboard and a screen reader.
 */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}

export function connectionStatusText(state: ConnectionState): string {
  switch (state.kind) {
    case "connecting":
      return "Opening a private connection…";
    case "handshaking":
      return "Checking this browser's token…";
    case "waiting":
      return `Retrying in ${Math.round(state.seconds)} seconds…`;
    case "ready":
      return "Connected";
    case "refused":
      return state.reason;
    case "idle":
    case "stopped":
      return "Connecting to the Agni server…";
  }
}

export function connectionShortStatus(state: ConnectionState): string {
  switch (state.kind) {
    case "ready":
      return "Connected";
    case "connecting":
    case "handshaking":
      return "Connecting…";
    case "waiting":
      return `Reconnecting · attempt ${state.attempt}`;
    case "refused":
      return "Needs attention";
    case "idle":
      return "Starting";
    case "stopped":
      return "Disconnected";
  }
}

export function connectionTitle(state: ConnectionState): string {
  switch (state.kind) {
    case "ready":
      return "Agni is connected";
    case "connecting":
    case "handshaking":
      return "Connecting to Agni…";
    case "waiting":
      return `Reconnecting · attempt ${state.attempt}`;
    case "refused":
      return "Connection needs attention";
    case "idle":
    case "stopped":
      return "Agni is disconnected";
  }
}

/** Clipboard with a quiet fallback for browsers that gate the async API. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
