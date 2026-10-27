# Routines

A routine is a recurring background job owned by one bot. It runs on a cron
schedule in a timezone, and before each run it checks its preflight:

- `http`: fetches the URL and compares the ETag, or a hash of the body.
- `sql`: runs one read-only `SELECT` on the Agni Bot database and hashes the rows.
- `none`: always counts as changed.

When the preflight shows no change, the run is recorded as `skipped_no_delta`
and the bot is not called. Otherwise the bot runs the routine's prompt with a
read-only tool set and reports into a background session in its conversation.
Five failures in a row pause the routine and notify the owner.

## Tools

- `routine_create`: name, prompt, cron, timezone, optional preflight, misfire,
  maxTokens, maxExecutionMs.
- `routine_list`: this bot's routines, next run, last outcome.
- `routine_pause`: pause or resume one routine.
- `routine_delete`: delete one routine and its run history.

A routine cannot be created from a turn that started from another bot's message.

## Defaults and limits

| Setting | Default | Limit |
| --- | --- | --- |
| Schedule | required | a cron with a valid timezone; at least 5 minutes between runs |
| Misfire | `run_once` | `skip` drops a run that is more than one period late |
| `maxTokens` | 16,000 | 1 to 16,000 (the task loop's own cap) |
| `maxExecutionMs` | 120,000 | 1 to 600,000 |
| `allowedDomains` | empty | web tools refuse every host; `routine_create` always leaves it empty |
| Preflight | `none` | `sql` must be one read-only `SELECT`, with no `;` |

A routine run can use only the read-only tools: memory and transcript search,
links, tasks, grep, glob, read_file, web search and fetch, mail search and read,
recall_fact, and skills. It cannot send mail, run bash, write files, hand off to
another bot, or change jobs or routines.

## Not built

Crystallization, webhook triggers, Telegram, Discord and Slack delivery, shell
preflight, USD budgets, and a kernel sandbox.
