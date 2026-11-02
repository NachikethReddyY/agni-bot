# Status — Jarvis & Firecrawl

All set. Here's the plain-English version:

## Jarvis (health-check agent)
- Created and scheduled to run daily at 8:00 AM.
- It can run health checks (bash), look things up (web search), and email you the report (mail send).
- Chat with it directly in its own DM.

## Firecrawl (your self-hosted web scraper)
- Running. The container stack is up and answering on port 3002.
- Your app is configured to use it (`AGNI_FIRECRAWL_URL` is set in `.env`).
- Web search and deep research now route through your own container instead of the public API.

## One thing to do
If the server was already running before the `.env` change, restart it once so it picks up the Firecrawl URL. After that, everything works automatically.
