# Agni Web

React + TypeScript port of the SwiftUI Mac client in `apps/mac`. The views,
intents, connection behavior, and design tokens follow the native app; this is
a port, not a redesign.

## Run

From the repository root:

```sh
bun install
bun run daemon start
bun run open                # opens the browser already paired (one-time code, 10 min)
bun run web                 # Vite on http://127.0.0.1:5173 (proxies to the daemon on 8787)
```

Outside development the daemon serves this app at `http://127.0.0.1:8787`.
Pairing uses a one-time code (`ABCD-EFGH`); `agni open` fills it in. The browser
then holds an HttpOnly, SameSite=Strict cookie, so the token is no longer kept
in `localStorage`. Enter the daemon address and the code if you are not using
`agni open`.

The pairing form checks `GET /health` before opening the socket, so a daemon on
a different origin must send CORS headers; the server's `/health` does.

## Where things are

| Path | What it is |
| --- | --- |
| `src/state/app-model.ts` | `AppModel` port: pairing, connect/reconnect, frames, intents, health polling, toasts, window chrome. |
| `src/state/use-app-model.tsx` | React context plus `useSyncExternalStore`. |
| `src/components/` | `RootView`, pairing, sidebar, thread, composer, inspector, settings, providers, agents. |
| `src/styles/` | Swift design tokens and the app stylesheet. |
| `test/` | Vitest + Testing Library UI smoke tests. |
| `scripts/ui-smoke.mjs` | Playwright E2E against a real daemon. |

The shared client core lives in `packages/client` (`@agni/client`) and mirrors
`AgniKit`: frame codec, settings, health, transport, connection loop, and the
conversation reducer. `packages/protocol` remains the wire contract.

## Test

```sh
bun run check                               # all typechecks + client/web + server tests
bun run --filter @agni/web test             # UI smoke tests
bun run --filter @agni/web smoke:ui         # browser E2E (see below)
```

`smoke:ui` needs a running daemon, a running Vite dev server, and a one-time
token:

```sh
AGNI_URL=127.0.0.1:8788 AGNI_TOKEN=agni_… bun run --filter @agni/web smoke:ui
```

It pairs a fresh browser profile, completes first-run onboarding, sends a
message, waits for the streamed mock reply, then exercises the agent switcher,
settings, and connection popover. Screenshots land in `artifacts/web-e2e/`
(gitignored).
