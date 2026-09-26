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
- Shared decisions in both: removed diff lines use an ash wash, never coral (coral means needs you);
  replies are labelled Vyre with the agent as a tag; every empty state has its action inline.

## Doing

- Waiting for the user to pick A or B (or a mix).

## Next

1. Write docs/design/deck.md (tokens, components, patterns, motion) for the chosen direction.
2. Hand it to pwa (implements the Deck) and chat.

## Needs from others

- User (via lead): pick A, B or a named mix.
- phone-design: confirm the shared parts (radii, chat item anatomy, empty-state pattern).

## Changed contracts

None.
