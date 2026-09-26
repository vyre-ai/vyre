# phone-design

Branch: work/phone-design · Worktree: ../vyre-phone-design · Owner session: phone-design

## Done
- docs/design/phone.md: the phone design. The user's pick (2026-09-27): Direction B's shell (no
  tab bar, swiped pages, the floating Capsule) with Direction A's screens (Chat, Find, Agents,
  the approval sheet), and A's grouped Needs you list with swipe and a detail sheet with Open
  session. Native presence is a device key (ADR 0018). Colour roles use the Deck's names.
- Red ban: attention is violet through the --beacon-* variables; errors and destructive actions
  carry no colour.
- Contrast: all 15 mockup artboards rendered in both themes, 1,048 text, placeholder and icon
  checks, all at WCAG AA. The mockups are a private design canvas owned by the user (ask the lead).
- Handed to pwa and mobile. The three contracts (anchors, questions, Always in <project>) landed
  on work/chat 10604b9; phone.md section 15 names the fields.

## Doing
- Waiting on deck-design's reduced system (2 families, neutrals, lime, one attention colour, no
  gold, no red) to apply it to phone.md and the canvas.

## Next
1. Apply deck-design's reduced set exactly: drop gold (From memory blocks become neutral unless
   they say otherwise), cut the type sizes to their scale, re-run the contrast pass, republish
   the canvas, tell the integrator the head.
2. The attention colour pick is still pending with the user: violet (current), honey or teal.
   It is a one-line swap per theme of the three --beacon-* values.
3. Review pwa and mobile builds against phone.md as screenshots arrive.

## Needs from others
- chat: the diff summary (detail.changes on Edit/Write asks; changes + totals on held pushes),
  queued for their next session.
- deck-design: shared chat items (gate card without a left rule, neutral deletions, author names).

## Changed contracts
- None.
