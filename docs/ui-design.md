# The web UI, built for a phone

The web app was a desktop app that happened to fit in a browser window. It is
now a phone app that grows into a desktop one. This is the reasoning behind
the current shape, and the rules to keep when changing it.

## The reference

The design language comes from **Grok Bot (iOS, Aug 2026)** — 117 screenshots
of a phone app whose whole premise is the same as Agni's: a roster of always-on
agents you talk to in one continuous thread each. What we took from it:

| Reference trait | What we did |
| --- | --- |
| Near-black night mode, surfaces a shade apart | Refreshed the token ramp to a true near-black (`--canvas: #0d0d0f`) with `--surface`, `--surface-raised`, `--incoming-bubble` as the only lit layers. Ember stays the only warm colour — Agni's identity. |
| Narrow rail of agent marks down the left | The roster is one panel: every agent with its tag and the last thing it said, pinned ones first. Search and "new agent" sit at the top of it. |
| The agent's name in a centred pill at the top | The header identity is a pill (mark + name) centred over the column. It is a button: it opens the agent's profile. |
| A side panel for the agent you are talking to | The pill opens a profile panel: the big mark, the name, the tag, Details / Activity tabs, and what other agents may see of its work. |
| A floating banner the thread scrolls under | The header is a veil, not a bar: no rule, a blur that diffuses the text passing under it, and a fade so there is no line where it ends. A working agent shows a dot on its mark instead of a "Writing…" label. |
| One field that searches everything, grouped by kind | Cmd-K opens search: agents first, then the messages of the open thread, each result taking you to it. |
| A "+" to make a bot | The roster's "+" opens a sheet — name, tag, what it should do — and the daemon creates it the same way the `create_agent` chat tool does. |
| Floating capsule composer: `+` · field · mic/arrow | Kept the capsule, moved it to the bottom of the thumb zone, made the mic a quiet ghost icon instead of a filled button, and the send arrow a solid circle. |
| Rounded everything: 16–24px radii | Bubbles 20px, composer 26px, cards 14–16px, icon buttons circular. |
| Roster as a list with avatars and status dots | The roster is a slide-in drawer on a phone and a panel on a desktop: 36px avatars, state dot, unread dot, a tag chip and the last thing each agent said. |
| Header: back · agent · one action | Header is a floating veil: menu button, the agent pill, round share and monitor buttons. |
| Quick replies as a bordered list of labelled choices | `say`-backed forms render as a single card of `A`/`B`/`C` rows with hairline separators, not a row of anonymous buttons. |
| Green switches in grouped settings rows | Settings gained a "This browser" group with three switches that really do something: notifications, typing indicator, tool activity. |
| Grouped inset settings rows, sheets from the bottom | Settings is a full-screen page on a phone: title, back, a scrollable row of pill tabs. Dialogs are bottom sheets. |
| Attachments you can open | Tapping an image opens a preview sheet with the file, its size, and a download. |
| Tiny centred day stamps | Day dividers stay centred and small; nothing else centres but the thread's own seams. |
| The whole room takes the agent's colour | Every agent's colour is a theme: your bubbles carry it, the assistant's answers take a whisper of it, the top of the column glows with it, and the working dot on its mark is it. The colours are tuned for a near-black room: accents are lifted until they read, and bubbles are pushed down until white text on them still does. |

We did **not** take the blue accent. Ember is Agni's.

## The rules

1. **One bubble per answer.** The narration a model writes between tool calls
   never reaches the client; a channel turn buffers the answer and emits it as
   a single `token` frame. See `docs/protocol.md`.
2. **Bubbles hug their text.** Assistant bubbles shrink to their content;
   the user bubble caps at 86% of the column on a phone.
3. **The column fills the space.** The transcript and the composer use the
   full width of the chat column, with a `clamp()` gutter. There is no narrow
   measure in the middle of a wide screen.
4. **Nothing smaller than 44px under a thumb.** Touch targets, 16px inputs (so
   iOS does not zoom on focus), safe-area padding top and bottom.
5. **The phone layout is the base layout.** Under 720px there is one column, a
   drawer instead of a sidebar, a sheet instead of a third column, and sheets
   instead of centred dialogs.
6. **A switch that does nothing is a lie.** Every toggle in Settings changes
   behaviour the moment it is flipped.
7. **The agent's colour is the theme.** It is applied as CSS custom
   properties on the app root (`apps/web/src/theme.ts`), so one rule can move
   a surface. Dark mode is the constraint: an accent is lifted until it reads
   on near-black, and a bubble is pushed down until white text on it clears
   4.5:1. The tests hold that line.
8. **A pin is a pin.** The agents you favourite go into the grid at the top
   of the roster — one centred, two side by side, always centred — each with
   a star in the corner of its mark. Hovering highlights that bot and
   nothing else.
9. **A question waits; typing does not.** The `ask` tool puts a question
   with options to the owner. They answer by choosing, or by typing — which
   dismisses the question and steers the work with their words. The
   `draft_email` tool puts a composed email up with Send email and Discard;
   it sends nothing by itself.

## Where the code lives

- `apps/web/src/styles/tokens.css` — colour, type, radius, motion, phone
  tokens (`--touch-target`, `--composer-radius`, `--safe-top`).
- `apps/web/src/styles/app.css` — layout, the phone block, and the desktop
  block that gives the roster its panel.
- `apps/web/src/state/app-model.ts` — `isSidebarPresented` (the drawer),
  `isAgentProfilePresented` (the profile panel), and `preferences`.
- `apps/web/src/state/preferences.ts` — the browser-local switches and the
  pinned agents.
- `apps/web/src/components/SidebarView.tsx` — the roster: the list, the
  pinned-first order, and the "new agent" sheet.
- `apps/web/src/components/AgentProfileView.tsx` — the profile panel: name,
  tag, visibility, activity.
- `apps/web/src/components/AgentSwitcherView.tsx` — Cmd-K search over agents
  and messages.
