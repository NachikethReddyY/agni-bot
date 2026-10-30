# Harness review

An offline loop that improves the bot's harness (its tools, prompt and
lane settings) from evidence, with the owner deciding every change. It
borrows one idea from Harness² (google-research/harness2): keep lessons
backed by evidence, and use them to refine the harness for future tasks.

## What we took, and what we left

Harness² improves a harness at two levels:

- **Per task:** it reruns the same task under several proposed harness
  edits, compares the runs, and keeps the best one. **Not used here.**
  Rerunning an owner's turn would repeat real actions such as mail sends.
  It would also multiply cost on free-tier providers and slow the turn,
  and AGENTS.md treats a slower quick question as a bug.
- **Across tasks:** it keeps lessons supported by evidence and applies them
  to the next task. **Used here**, as a nightly background job that never
  runs on the turn path.

## What is built

`apps/server/src/jobs/harness-review.ts`, job kind `harness.review`. It is
enqueued at startup and runs daily at 04:00.

1. **Reading usage.** `toolUsage` reads the last 14 days of the `turns` and
   `tool_calls` tables. For each tool it counts:
   - the turns that used it;
   - how many of those turns unlocked it with `load_tools` first;
   - its calls and its failures.

   It also counts the turns that timed out.
2. **Proposing.** `proposeFromUsage` turns those counts into proposals. It
   needs at least 30 turns of evidence:

   | Kind | When |
   | --- | --- |
   | `promote_core` | A deferred tool is used in at least 15% of turns. Each of those turns pays an extra step to load it. |
   | `demote_core` | A core tool was never used in the window. |
   | `tool_failing` | A tool failed at least 30% of its calls, with at least 10 calls. |
   | `turn_timeouts` | At least 10% of turns timed out. |
3. **Storing.** `saveProposals` writes to `harness_proposals` (migration 42):
   - There is one row per kind and subject.
   - A pending row gets fresh evidence on each run.
   - A row the owner approved or rejected is never changed or raised again.

## Safety

- **Counts only.** The review reads tool names, ok flags and stop reasons.
  It never reads message text or tool-result text. Mail, web pages and
  peer agents therefore cannot write a "lesson" into the harness, which
  would let a prompt injection persist.
- **No invented tools.** A model can call a tool name that does not exist.
  A name that is not a registered tool and never succeeded cannot become
  a proposal.
- **The owner decides.** Nothing the review writes changes the live
  harness.

## Not built yet

- **Approval and apply.** There is no UI for proposals yet. Once one
  exists, an approved `promote_core` or `demote_core` should change the
  core set that `deferredTools` uses (`CORE_TOOLS` in
  `apps/server/src/tools/task-registry.ts`). The other kinds are lessons
  for the owner, not automatic edits.
- **Probing before offering.** Before a proposal is shown, run the evals
  (`bun run eval`) with the change applied. Offer it only if they still
  pass.
- **Stale proposals.** A pending proposal whose evidence has gone away
  stays pending until the owner acts on it.
- **Per-bot core sets.** The core set is global today. The evidence could
  be split by `turns.agent_id` once bots differ enough to need it.
