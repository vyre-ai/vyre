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

- B second pass (27 Sep, after the restart). Palette and stylesheet cut to the reduced set; A boards
  dropped; Now, Chat, Agents, Projects, Vault and Settings redone in dark and paper; new States
  board; system board (Main) and attention board (violet recommended, teal the alternative, honey
  out) redone. All 16 boards pass the render audit (0 contrast, 0 clipped, 0 off-system), and
  every PNG was looked at. docs/design/deck.md written.
- The old canvas (7UkxdntcvSnwG9DB712CCj) is not reachable from this account, so the second
  pass is a NEW canvas: https://claude.ai/artifact/BK59f4Co2EPRzXsoocSzx1 (staged from the
  scratch folder canvas/project/; a copy of its sources is in team/design-backup/source-b2/).

## Doing

- Nothing in flight.

## Next

1. Chat's 5 views in B: New session sheet (project / box folder / no folder; Vyre or an agent;
   first message), box folder browser, xterm frame, beautified session view (tool cards, diffs,
   file previews, todos, collapsed thinking, cost and time per turn, raw-view toggle), question
   card (multi-select, Other, side-by-side previews).
2. After the user confirms violet: the repo-wide coral swap in one commit (deck.css onto
   palette.js and drop the palette test's todo, TOKENS.md, site, core/cli/style.js,
   core/vault/kit.js, local/capsule/app, and gold out of capsule.css, demos.css and
   site/styles.css), then capsule-pro (Theme.swift) and mobile.
3. Hand deck.md to pwa and chat once the lead merges.

## Needs from others

- User (via lead): confirm violet (teal is the alternative). The coral swap waits on it.
- User: share the old canvas with this account, or keep the new one as the canvas of record.
- phone-design: confirm the values sent 27 Sep (below in deck.md).

## Changed contracts

- core/config/palette.js: `ATTENTION` is now `{ violet, teal }` of `{ dark, light }` hexes (was one
  colour with ink, wash and rule), `withAttention(name)` is new, and the recall and beacon-wash roles
  are gone. Nothing outside palette.test.js imported them.
