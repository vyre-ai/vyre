# deck-design

Branch: work/deck-design · Worktree: ../vyre-deck-design · Owner session: deck-design

Scope (lead, 2026-09-27): design lead for the desktop Deck and the visual system the Capsule, phone
and docs share. The user found the Deck rudimentary: the new-agent form reads as a database form,
"No projects yet" is a dead end, the Vault add panel is plain, and Chat is an empty page.

## Done

- Two directions as high-fidelity 1440x900 mockups, dark and paper, for Now, Chat, Agents (list and
  new agent), Projects (empty state and inline create), Vault (list and add) and Settings. Published
  as a private design canvas (link sent to the lead). Sources: docs/design/deck-directions/
  (vyre.css holds the role tokens and every shared part; one .dc.html per screen, *-light files
  import the dark one with theme t-light).
  - A Instrument: TOKENS as written, finished. Named 240px rail, hairline lists, mono caps buttons.
  - B Studio: 72px icon rail, command bar always on screen, cards, sentence-case buttons, Chat side
    panel with plan, changed files, memory and the agent.
- Shared decisions (agreed with phone-design and the lead): removed diff lines use an ash wash,
  never coral; beacon only means needs you; a gate is a beacon-wash block with a dot, no border or
  side stripe; gate buttons are Allow once / Always in <project> / Deny (phone may add "with Face
  ID"); the reply author is the acting agent (kit) or the onboarding assistant name (juno), "Vyre"
  only when neither is known, and the user is "you"; every empty state has its action inline.

## Doing

- Waiting for the user to pick A or B (or a mix).

## Next

1. Write docs/design/deck.md (tokens, components, patterns, motion) for the chosen direction.
2. Hand it to pwa (implements the Deck) and chat. chat asked for visuals for: New session sheet
   (project / box folder / no folder; Vyre or an agent; first message), box folder browser, browser
   terminal frame (xterm), beautified session view (tool cards, diffs, file previews, todos,
   collapsed thinking, cost and time footer per turn, raw-view toggle), question card (multi-select,
   Other, side-by-side previews) and permission card. Draw these in the chosen direction.

## Needs from others

- User (via lead): pick A, B or a named mix.
- phone-design: confirm the shared parts (radii, chat item anatomy, empty-state pattern).

## Changed contracts

None.
