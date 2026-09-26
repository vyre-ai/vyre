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

- The user picked Direction B (Studio): "direction is very right, not quite there yet". Hard
  constraint: only a few fonts and a few colours. The second pass has NOT started; the canvas
  still shows A and B with the full palette (last publish: canvas v10, commit a7e8cc6).
- Reduced system for the second pass (first job after restart):
  - Fonts: 2 families. Instrument Sans for all UI and text; JetBrains Mono only for commands, code
    and IDs. No display sizes. Scale of 5: 12/16, 13/18, 15/22, 20/26, 28/34. Weights 400 and 600.
    Buttons sentence-case sans (B), no mono caps labels except code.
  - Colours: neutrals only (bg, panel, hover, rule, rule-strong, text, text-2, label) in dark and
    paper; ONE accent lime (primary actions, focus, running); ONE attention (violet #B8A4FF dark,
    #5B3FC4 paper, pending the user's pick). Drop recall gold, del-wash hue and every other hue.
    Memory, success and info = neutrals plus an icon. No red anywhere.
  - Phone offset (agreed with phone-design, 0a92c08): +2 on the 15 and 20 steps only (17 for
    messages and row titles, 22 for page labels), for iOS body size and no zoom-on-focus. 12, 13
    and 28 are shared.
  - Meta text on any tint uses text-2 (label is 4.48:1 on paper washes, per phone-design).
  - Add --beacon-badge-ink (#0E0D0C dark, #F4F1EA paper; phone-design found paper ink fails on
    violet) or keep badges as primary-ink on the dot per theme.

## Next

1. Cut vyre.css and core/config/palette.js (+ palette.test.js PAIRS) to the reduced set above.
2. Second pass on B only: stronger hierarchy and spacing, calmer cards (no box in box), command
   bar, Chat side panel, describe-to-create agent flow, empty states with inline actions,
   inline-editable drafts (Send and Discard only). Drop the A boards from the canvas.
3. Add chat's 5 views in B: New session sheet (project / box folder / no folder; Vyre or an
   agent; first message), box folder browser (recent, search, New session here, Open in
   terminal), xterm frame, beautified session view (tool cards, diffs, file previews, todos,
   collapsed thinking, cost and time footer per turn, raw-view toggle), question card
   (multi-select, Other, side-by-side previews) and permission card.
4. Verify: docs/design/deck-directions/render/render.sh (testbox headless Chrome, contrast pass,
   clipping); look at every PNG. Publish from the scratch canvas folder (files under project/),
   never with root = the repo folder (that published a stray root file once).
   Canvas: https://claude.ai/artifact/7UkxdntcvSnwG9DB712CCj
5. Write docs/design/deck.md for B; hand to pwa and chat.
6. Answer phone-design: (a) "from memory" blocks become neutral (hover fill, text-2, a memory
   icon); (b) --match lime wash survives as the accent's wash; (c) map phone sizes onto the 5-step
   scale (22/26 -> 20 or 28, 17/16 -> 15, 13 -> 13, 12 -> 12) or agree a phone offset. Send them
   the commit, role names, values and sizes.
7. After the user picks the attention colour: repo-wide coral swap in one commit (list under
   Doing in the previous revision: deck.css, TOKENS.md, site, core/cli/style.js,
   core/vault/kit.js, local/capsule/app, old boards), then capsule-pro (Theme.swift), mobile.

## Needs from others

- User (via lead): pick A, B or a named mix.
- phone-design: confirm the shared parts (radii, chat item anatomy, empty-state pattern).

## Changed contracts

None.
