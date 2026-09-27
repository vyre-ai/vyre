# phone-design

Branch: work/phone-design · Worktree: ../vyre-phone-design · Owner session: phone-design

## Done
- Expo pivot (lead, 2026-09-27): phone.md now specs one Expo app for iOS, Android and web
  (mobile leads ADR 0027). Tokens are plain values for one tokens.ts (section 2). Borrowed from
  Paseo's app: page-swipe thresholds, inverted transcript with follow and Jump to latest,
  paced streaming reveal, collapsed tool runs, keyboard by transform and flick-to-dismiss,
  15 s answer timeout, long-press menu, reconnect pill, offline cache, push rules, expo-haptics.
  Not borrowed: its 2 s host checks (breaks light by default) and its missing presence check.
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
  gold, no red) to apply it to phone.md and the canvas. Not landed on work/deck-design as of
  1b37bda (their Next 1 is still open).
- Done this session: honey dropped (the user does not like it; violet recommended, teal the
  alternative). The no-nag rule is in phone.md section 5 "When Face ID shows": a proof only for
  pairing, vault secrets and outbound send/post/pay, one proof lasts about 30 minutes, ordinary
  asks are one tap with no glyph.

## Next
1. Apply deck-design's reduced set when they send it (first job after their restart; their notes
   at deck-design 24c3f31). Working answers: From memory goes neutral (--hover fill, --text-2, a
   memory icon, no gold); --match stays as lime's wash; sizes collapse to 12/13/15/20/28 (phone
   22/26 to 20 or 28, 17/16 to 15). Agreed with deck-design (f0c9738): the phone adds +2 on 15
   and 20 (17 for messages and row titles, 22 for page labels); 12, 13 and 28 stay shared. Then re-run the contrast pass (scratchpad phone-render/
   build.py, rebuilt if the scratchpad is gone), republish the canvas, tell the integrator.
2. The attention colour pick is still pending with the user: violet (current) or teal. Honey is
   out. It is a one-line swap per theme of the three --beacon-* values.
3. Review pwa and mobile builds against phone.md as screenshots arrive.

## Needs from others
- pwa (core/push, ADR 0011) owns the box-side push rule in phone.md section 11, with the planner
  exception (alarms and timers always push and ring). Lead told pwa 2026-09-27.
- e2e: `presence: {required, covered}` landed on work/e2e 5b30ed3 (pushed, not merged). phone.md
  section 5 designs the three states from it. Asked e2e to add `presence.since` for the
  "confirmed 12 min ago" line (2026-09-27); lapse is 403 presence_required, handled in place.
- chat: the diff summary (detail.changes on Edit/Write asks; changes + totals on held pushes),
  queued for their next session.
- deck-design: shared chat items (gate card without a left rule, neutral deletions, author names).

## Changed contracts
- None.
