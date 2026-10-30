#!/usr/bin/env bash
# Install Agni Bot: bash infra/install.sh [--no-service] [--no-open]
# or: curl -fsSL <raw url>/infra/install.sh | bash
set -euo pipefail

SERVICE=1
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --no-service) SERVICE=0 ;;
    --no-open) OPEN=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

AGNI_HOME="${AGNI_HOME:-$HOME/.agni}"
AGNI_REPO="${AGNI_REPO:-https://github.com/Nachikethreddyy/agni-bot.git}"
PORT="${AGNI_PORT:-8787}"
export AGNI_HOME

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install it with:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
BUN="$(command -v bun)"

umask 077
mkdir -p "$AGNI_HOME"
chmod 700 "$AGNI_HOME"

# Source: the checkout this script lives in, else a clone under AGNI_HOME/app.
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  CAND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [ -f "$CAND/apps/server/src/index.ts" ]; then SRC="$CAND"; fi
fi
if [ -z "$SRC" ]; then
  command -v git >/dev/null 2>&1 || { echo "git is required to fetch the source" >&2; exit 1; }
  SRC="$AGNI_HOME/app"
  if [ -d "$SRC/.git" ]; then
    git -C "$SRC" pull --ff-only
  else
    git clone "$AGNI_REPO" "$SRC"
  fi
fi
echo "source: $SRC"

cd "$SRC"
bun install --frozen-lockfile
bun run web:build

if [ ! -f "$AGNI_HOME/config.env" ]; then
  if [ -f "$SRC/.env" ]; then cp "$SRC/.env" "$AGNI_HOME/config.env"
  else cp "$SRC/infra/env.example" "$AGNI_HOME/config.env"; fi
  chmod 600 "$AGNI_HOME/config.env"
  echo "created $AGNI_HOME/config.env"
fi

mkdir -p "$AGNI_HOME/bin"
printf '#!/usr/bin/env bash\nexport AGNI_HOME="${AGNI_HOME:-%s}"\nexec "%s" "%s/apps/server/src/index.ts" "$@"\n' "$AGNI_HOME" "$BUN" "$SRC" > "$AGNI_HOME/bin/agni"
chmod 755 "$AGNI_HOME/bin/agni"
if mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  ln -sf "$AGNI_HOME/bin/agni" "$HOME/.local/bin/agni"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
fi
AGNI="$AGNI_HOME/bin/agni"

if [ "$SERVICE" = 1 ]; then
  "$AGNI" service install
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || echo "server not answering yet; check $AGNI_HOME/logs/agni.log" >&2
  if [ "$OPEN" = 1 ]; then "$AGNI" open; fi
fi

cat <<MSG

Agni Bot is installed.
  data:      $AGNI_HOME (database, logs, scratch)
  keys:      put provider keys in $AGNI_HOME/config.env, then restart: agni service install
  status:    agni service status
  uninstall: agni service uninstall   (data stays in $AGNI_HOME)
  pair again: agni open
MSG
