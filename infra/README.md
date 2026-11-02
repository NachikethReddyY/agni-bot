# infra/

Deployment and operations files for Agni Bot.

- `npm/` - the `agni-bot` npm package: `bun run npm:build` stages it in `dist/npm`, then
  `cd dist/npm && npm publish`. Bump `version` in `npm/package.json` first.
- `install.sh` - one-shot installer (checkout or clone, `bun install`, web build, config, `agni` wrapper, service).
- `env.example` - config template; the installer copies it to `$AGNI_HOME/config.env` (mode 600).
- `launchd/dev.agni.server.plist`, `systemd/agni.service` - reference copies of what `agni service install`
  writes (paths are placeholders; the real ones are generated in `apps/server/src/service.ts`).
- `firecrawl.compose.yml` - self-hosted Firecrawl for the web tools.
- `wrangler.toml` - Cloudflare Workers config for the public pages; deploy with `wrangler` from this folder.

Vercel configs stay at the repo root and under `apps/` because Vercel reads them from the project root.

## Install

    npm i -g agni-bot && agni setup        # setup --no-service: detached daemon instead

Or from source:

    curl -fsSL https://raw.githubusercontent.com/Nachikethreddyy/agni-bot/main/infra/install.sh | bash

Or `bash infra/install.sh` from a checkout. Flags: `--no-service`, `--no-open`. Requires bun
(`curl -fsSL https://bun.sh/install | bash`) and git. State lives in `AGNI_HOME` (default `~/.agni`).

## Service

    agni service install     # launchd (macOS) or systemd --user (Linux); starts at login, restarts on crash
    agni service status
    agni service uninstall   # data stays in AGNI_HOME
    agni open                # mint a pairing code and open the web app (--no-browser to just print)

Stop a detached `agni daemon` first; install refuses while it runs. On a headless Linux box run
`loginctl enable-linger $USER` so the service starts without a login session.

## Remote access

    tailscale serve --bg 8787

Then set `AGNI_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` in `$AGNI_HOME/config.env` and
restart (`agni service install`). `agni open` prints that origin's pairing URL too.

## Firecrawl

    docker compose -f infra/firecrawl.compose.yml up -d
