---
title: Layout and navigation
summary: The breakpoints, the three shapes of the one app, the rail and the phone shell, Lumen, and where every place lives on each surface.
audience: builders
owner: app-design
status: draft
---

# Layout and navigation

One tree, three shapes. Layout reads the window, never the platform: an iPad and a narrow desktop
window follow the same rules, and a phone turned sideways stays a phone. The one query, in CSS:
`(max-width: 719px), (max-height: 500px) and (pointer: coarse)`. Components also check their own
container, so the composer and cards fit inside a split pane.

## Breakpoints

| Width | Shape |
|---|---|
| under 720, or a short touch screen (height 500 or less with a coarse pointer: a phone in landscape) | The phone shell: pages you swipe, the floating Lumen, the Places sheet, pushed screens |
| 720 to 1099 | The rail and a list; the detail replaces the list below 900 and sits beside it from 900 |
| 1100 to 1399 | Rail 72, list 320 (resizable 240 to 480), detail capped at 820 for reading |
| 1400 and up | Adds the side panel (340): plan and todos, changed files, the agent's computer |

The list hides before the detail drops under 480. Settings content caps at 720.

**Panel width, one named exception (30 Sep, artifacts team's AR3 ask).** `panel:<name>` (ADR
0033's slot grammar) stays fixed at 340 by default - todos, changed files, a teammate's thread,
every ordinary use. An artifact panel showing a page or a deck (the two kinds that genuinely don't
fit at 340: a rendered HTML page, a slide) may offer one widen control that steps the panel to 50%
of the window's width and back, never a freeform drag-resize and never a remembered arbitrary
width. Every other artifact kind (doc, report, diagram, dashboard) and every other panel use stays
at 340 - this is a control on the artifact panel's own chrome (next to the version bar), not a
general capability every `panel:<name>` gains. On the phone the panel is already a full-screen
sheet, so the control doesn't apply there.

## Desktop and tablet

- [Rail](components/rail.md): 72 px of icons with 12 px labels. Order: Now, Chat, Agents,
  Projects, Planner, Memory, Vault; at the bottom Devices, Settings and the person's avatar. Now
  carries the violet count. A "Modules" section may sit under Vault with at most three pinned views
  (ADR 0033); everything else is reached through ⌘K.
- [Top bar](components/top-bar.md): 56 tall. Page title left, the ⌘K command bar in the middle
  ("Jump to anything, or ask juno"), the page's one primary action and its key on the right. Pages do
  not repeat a big title under it.
- Two shells only: list and detail (Now, Agents, Projects, Planner, Memory, Vault, Devices,
  Settings) and the workspace (Chat: session list, transcript, side panel, terminal). A third shape
  needs a design review.
- Sheets open from the right over the list (create flows) or centred (confirmations). Menus are
  [popovers](components/popover.md).

## Phone

- [Phone shell](components/phone-shell.md): a 48 px header with the mark, the page labels Now,
  Chats and Agents (22/28, the current one in --text), and the avatar, which opens the Places sheet
  (Projects, Planner, Memory, Vault, Devices, Settings; long-press a tile to pin it as a fourth
  page).
- Pages swipe as a CSS scroll-snap strip (native snapping on the scrolling thread): a swipe commits
  past a third of the width or at 500 pt/s. Lists scroll vertically inside each page.
- The floating Lumen sits 12 from each side above the safe area, 56 tall: "Ask juno, find, or
  run". Tap or drag up for Find; hold the mic to dictate (the words land in the field, never sent on
  their own). A pushed chat hides it and shows its composer.
- Pushed screens slide in from the right with a back chevron and the edge swipe.
- The app opens on the page it was on, except that it opens on Now whenever something needs you.
- One fixed shell at 100dvh; only inner lists scroll, with overscroll contained. The keyboard moves
  the composer by transform through a visualViewport inset, so nothing jumps.

## The Mac Lumen

[capsule-mac](components/capsule-mac.md): a native Swift panel, 680 wide, opened with Control
twice. It carries the same Needs rows (cut to one detail line), the ask field ("Ask juno, @ to
target, or run"), streaming replies and key hints, from the same tokens. Touch ID covers sends for
30 minutes. The menu-bar mark's dot turns violet while something needs you.

## Where each place lives

| Place | Phone | Desktop | Lumen | CLI |
|---|---|---|---|---|
| Now, Needs you | Page 1, opens here when anything waits | Rail: Now, with the count | The waiting list | `vyre needs` <!-- terms: ignore --> |
| Chat, sessions | Page 2; a session pushes in | Rail: Chat, the workspace shell | Ask, @ to target | `vyre open kit` <!-- terms: ignore --> |
| Agents, Glass | Page 3; Glass pushes in | Rail: Agents, the computer in the detail | "glass kit" | `vyre agents` <!-- terms: ignore --> |
| Find, commands | Lumen, pulled up | ⌘K anywhere | Itself | `vyre <anything>` <!-- terms: ignore --> |
| Projects, Memory | Places sheet | Rail | @ completion | `vyre projects` <!-- terms: ignore --> |
| Planner | Today on Now; Places sheet | Rail | "alarm 7am" | `vyre planner` <!-- terms: ignore --> |
| Drive, files | Places sheet | Rail | # file chips, @ | `vyre drive` <!-- terms: ignore --> |
| Vault | Places sheet | Rail | "code northwind" | `vyre vault` <!-- terms: ignore --> |
| Devices, Settings | Places sheet | Rail, bottom | Menu | `vyre devices` <!-- terms: ignore --> |

## Keys (desktop)

| Key | Does |
|---|---|
| ⌘K | Jump to anything, run a command |
| ⌘1 to ⌘9 | Rail places |
| J, K | Next, previous item |
| ⏎ | Open |
| A, D | Allow once; deny or discard |
| ⌘⏎ | Send, save, submit, start building |
| N | The page's primary action |
| / | Filter this list (in a composer: commands) |
| ⌘L | Focus the composer |
| ⇧Tab | Cycle the session mode |
| Esc | Close; in a session, stop now. Esc Esc rewinds |

Buttons show their key inside them; a list shows a one-line key hint.
