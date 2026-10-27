# Docs index

Status of every doc in the repo, so an AI agent knows what to trust. Statuses
were set on 2026-10-26 by reading the code, and updated after the owner's
decisions that day. Where a doc and the code disagree, the code wins for
behaviour and the doc is stale.

Read in this order first:

1. [`../AGENTS.md`](../AGENTS.md): what Agni Bot is, terminology, hard rules, traps.
2. [`architecture.md`](architecture.md): the two-minute system map.
3. [`blueprint-v3.html`](blueprint-v3.html): the canonical plan, for product intent.
4. [`protocol.md`](protocol.md): the wire contract (protocol v2).

## Status key

- **CURRENT**: matches the code as checked.
- **PARTLY STALE**: mostly right, with named claims that are out of date.
- **STALE**: superseded or contradicted by code. Do not use as current status.
- **PLAN**: a design or plan. Not a statement of what is built.
- **NOT AUDITED**: not checked against code in this pass. Treat with caution.
- **LEGACY**: moved to `../legacy/`. Not product docs. Do not use as product facts.

## Repo-level docs

| Path | Status | Notes |
| --- | --- | --- |
| `AGENTS.md` | CURRENT | Root guide for AI agents. |
| `README.md` | CURRENT | Intro with bot framing and license note. Seven evals. Data paths match `~/.agni/`, except `providers.json`. |
| `extensions/README.md` | CURRENT | Placeholder. The extension loader is not built. |
| `.deepsec/README.md`, `.deepsec/AGENTS.md` | NOT PRODUCT | Security-scan workspace for the repo, not product docs. |
| `thoughts.md` | PARTLY STALE | Mac pairing notes. Some items may be out of date. |
| `legacy/notes/status.md` | LEGACY | Personal ops note (Jarvis health agent, Firecrawl). |

## docs/

| Path | Status | Notes |
| --- | --- | --- |
| `architecture.md` | CURRENT | Rewritten 2026-10-26. |
| `blueprint-v3.html` | PARTLY STALE | Canonical plan. Framing corrected 2026-10-26. Section 10 has a Status column (2026-10-26) that says what is built. The plan rows are unchanged history. |
| `protocol.md` | CURRENT | Protocol v2. Verified against `packages/protocol` in part; re-check frame details there. |
| `plugins.md` | CURRENT | Rewritten 2026-10-26. Built vs planned is in its status table. |
| `remaining-work.md` | CURRENT | Reported current by audit. Not line-checked. |
| `agni-context-memory-spec.md` | CURRENT | Context and memory spec. Reported current by audit. |
| `research-context-management.md` | CURRENT | Research brief for context management. |
| `p2-plan.md` | STALE | Historical P2 plan. A status banner was added 2026-10-26; tools are now registered. |
| `issues-to-fix.md` | PARTLY STALE | Issue list. Entries need checking against code before action. |
| `routines-plan.md` | PLAN | Built on feat/agnibot-routines (not merged yet). Plan for the build; sections 0-9 describe the build as it was made. |
| `ui-design.md` | CURRENT | Web UI rules. |
| `ui-mocks.html` | PARTLY STALE | Mocks. One bot is labelled "Agni Instant". "Instant" is a lane name, not a bot name. |
| `gmail-plan.html`, `plugins-plan.html`, `google-oauth-setup.html` | PLAN | Plans and setup notes. Check the code before quoting them. |
| `homepage.html` | NOT AUDITED | |
| `legacy/docs/audit-context-memory-spec.md` | STALE / LEGACY | Superseded by `remaining-work.md`. Moved to `legacy/` 2026-10-26. |
| `legacy/docs/research/motorcyclist-safety/*.md` | LEGACY | Singapore road-safety research. Unrelated to the product. |

## Other locations

| Path | Status | Notes |
| --- | --- | --- |
| `apps/web/README.md` | CURRENT | Run and smoke commands match the scripts. Its "port of the Mac client" line is still accurate. |
| `apps/mac/README.md` | CURRENT | Corrected to protocol v2 on 2026-10-26. |
| `apps/mac/DESIGN.md` | NOT AUDITED | Design notes. |
| `apps/app/README.md` | PLAN | Tauri client. No app code exists yet. |
| `apps/landing/index.html` | CURRENT | Rebuilt 2026-10-26: thread-led hero, bot roster, speed ledger, quickstart. Public repo and deploy links removed. Connections list matches the code. |
| `apps/public/index.html`, `apps/public/privacy.html` | NOT AUDITED | Privacy page names integrations (Google, Granola, Notion). Those exist in the catalog. The page should not imply Slack or Discord. |
| `legacy/agni-report.html`, `legacy/artifacts/*.html` | LEGACY | Old generated review artifacts. Not canon. |

## Known gaps

- No doc covers the `tools/audit/` peer-memory audit script.
- `providers.json` still defaults to `data/` in the working directory, while the
  other state files default to `~/.agni/`. See `AGENTS.md`.
- A local `.env` that still sets `AGNI_DB_PATH=data/...` keeps the old DB location.
