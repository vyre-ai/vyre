# phone-design

Branch: work/phone-design · Worktree: ../vyre-phone-design · Owner session: phone-design

## Done
- Reduced system (deck-design e1428b1, cut at fe7e8e0) applied to phone.md (352c985) and the
  canvas. New private canvas on this account (the old one is on the previous account):
  https://claude.ai/artifact/3SthmzgeUYv6o8bbaBNhD6, only the 10 Picked boards (A and B dropped).
  Contrast: 338 checks, both themes, 0 below AA. Source backup: <team-dir>/design-backup/phone/.
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
- Nothing in flight. Waiting on paseo-research (team/research/paseo-ui.md) for the one-app batch:
  one design for web, Mac desktop and phone plus a design sheet, with deck-design as one team.

## Next
1. When paseo-research reports: work with deck-design on one system and screens that adapt
   across sizes (lead, 2026-09-27).
2. The attention colour stays violet unless the user picks teal: one line per theme.
3. Review the Expo app (mobile, ADR 0027) against phone.md as screenshots arrive.

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
