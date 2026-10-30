# Agni Bot

A self-hosted messaging app where you talk to your own named AI bots. Each bot
has its own name, role and memory. Source-available; see the repository.

## Install

Needs [Bun](https://bun.sh) 1.3+ on macOS or Linux.

```bash
npm i -g agni-bot      # or: bun add -g agni-bot
agni setup
```

`agni setup` creates `~/.agni`, registers a login service (launchd on macOS,
systemd --user on Linux) so the server starts at login and restarts if it
crashes, and opens the web app in your browser already paired.

Add a model provider key (Groq, Cerebras, NVIDIA NIM, Gemini, OpenRouter or a
local LM Studio) in the app's settings or in `~/.agni/config.env`.

## Everyday commands

```bash
agni open                 # pair another browser (prints a one-time code too)
agni service status       # is it running?
agni service uninstall    # stop and remove the login service (data stays)
agni daemon logs --follow # watch the log
```

Upgrade: `npm i -g agni-bot@latest && agni setup`.

Everything Agni keeps lives in `~/.agni` (set `AGNI_HOME` to move it).
Remote access: `tailscale serve --bg 8787`, then set
`AGNI_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` in `~/.agni/config.env`.
