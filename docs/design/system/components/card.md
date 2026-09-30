---
title: Card
summary: The one surface for grouped content, a panel with a hairline, with an optional 44 header and a footer that holds the actions.
audience: builders
owner: app-design
status: draft
---

# Card

A card is `--panel` plus a hairline. It holds a held draft, an ask, a plan, a group of rows on the
phone, a settings group, a network summary. Nothing inside a card gets its own box, except code.
Drawn on nearly every board; the reference cards are the draft in "Needs you, phone and desktop",
the decided card in "States, every list, every size", the Network card in "Devices, network
and VyreDrive", and the Connections card on the Connections board (below).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/views/now.css` `.np-card` (work/pwa), `deck/css/views/planner.css` `.pl-card` (main), `deck/chat/chat.css` `.gate-card` (work/chat) | partial |
| App | `apps/app/src/session/Rows.tsx` AskCard, `apps/app/src/vault/views.tsx` TrustCard (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/AgentDeskView.swift` HeldCardView, `UI/PresenceView.swift` (work/capsule-pro) | partial |

## Anatomy

1. **Body.** Fill `--panel`, 1 px `--rule` border, radius `--radius-card` (12 desktop) or
   `--radius-card-phone` (10 phone), `overflow: hidden`. Content padding 0 16 (desktop), 0 14
   (phone); rows inside separate with a 1 px `--rule` top border, never with gaps or inner boxes.
2. **Header** (optional). Height 44, padding 0 16, gap 8, flex row: an optional status mark or 16
   icon, the label (12/16, 600, `--label`; for a held item the beacon dot and the label in
   `--beacon-ink`, "Draft to send"), and meta right-aligned (12/16 `--label`, "Gate · outbound
   email"). No bottom border; the first content row carries the rule.
3. **Footer** (optional). Padding 12 16, gap 8, 1 px `--rule` top border. Holds the buttons: one
   primary first (left), then secondary or outline, a presence or hint line in meta `--label`,
   and ghost actions pushed right (`margin-left: auto`, "Discard D").
4. **Code** inside a card is the only inner box: `--code-bg`, radius 8, padding 8 12, JetBrains
   Mono 13/18, margin 0 12 12.

## Variants

- **Content card.** Header, fields or rows, footer (the draft, the ask, merge failed).
- **Row card** (phone). No header or footer; a stack of rows (needs-row, list-row, settings-row)
  with a section label above it outside the card.
- **Choice tile.** Same body at radius 10, padding 12, transparent fill; selected adds `--focus`
  border plus a 1 px `--focus` ring. Used for install paths and attention colour.
- **Connections card** (Settings, Vault, Connections). The account-row (account-row.md) grown into
  a card when the row needs to show what it's granted, not just be picked. No header rule; three
  parts:
  1. A row at the top, padding 14 16: the provider tile (account-row.md's, 32 here), the account
     and its meta line (label · provider), then trailing the row's normal state (Default, Last
     used, or the fix button when it needs one) right-aligned.
  2. **Granted to**, padding 0 16 12, wrapped: the label `--label`, then one filter chip
     (chip.md) per surface that can use this connection (Capsule, Chat, Agents, Phone: the
     vault's real surfaces, never a made-up list), each with the surface's 12 icon leading.
     Revoking (On to Off) is one tap, always, for every surface. Granting (Off to On) is one tap
     with the undo toast for Capsule, Chat and Phone; the Agents chip asks Touch ID or a passkey
     first (chip.md States, Asking), since that hands a credential to an autonomous session, the
     same no-nag line as pairing and send/post/pay. A row that needs a fix (see account-row.md
     States) skips this part and the footer: just the top row and its Sign in.
  3. **Footer**, `--rule` top border, padding 12 16: "Wrong account?" (steplink, opens the
     credential sheet to pick a different one for this need) on the left, "Connected 3 Jan" in
     `--label` on the right. Never a Revoke or Disconnect here: that lives on the individual
     grant chip turned off, or the row's More menu.

Colour is never the card's: no violet, bone or wash on the body or border. A card that needs you
shows it only through the dot and label in its header. On the Connections card the only colour is
the grant chips' own bone "on" state (chip.md); the card itself stays neutral even when nothing
is granted.

## Sizes

Width fills its column (detail capped at 820, settings detail at 720). Min height is content.
Phone cards run edge to edge within the 16 gutter.

## States

- **Default.** As above.
- **Hover.** None on the card; rows inside have their own hover.
- **Focus within.** No card ring; the focused control inside shows its own `--focus` outline.
- **Busy.** The primary in the footer keeps its width with a spinner and a verb ("Sending").
- **Decided.** The header swaps the beacon dot and label for a neutral 16 glyph in `--text-2`
  and the decision in 13/600 `--text` ("Allowed once by you · 14:22"); the footer drops to the
  follow-ups (Open session, Always in Harlow Legal).
- **Loading.** A skeleton card: header height kept, two to four `--hover` bars 10 tall, radius 4.
- **Error.** Plain words in the body, the detail in mono, a way out (Retry, Open doctor).

## Keyboard and touch

The card is not focusable. Key hints for its actions sit inside their buttons (key-hint chip). On
the phone the footer's buttons are 44 (54 for the one primary in a sheet).

## Motion

None on the card. Content changes in place; a card that leaves collapses its height over
`--motion-tap`.

## Copy

Header labels are sentence case, 12/600, never mono or caps: "Draft to send", "Permission",
"Network", "Tests failed after the merge".

## Accessibility

A card with a header is a `section` labelled by its header text (`aria-labelledby`). The beacon
dot has the label beside it, so needs-you is never colour alone.

## Gaps

Deck
- [ ] No shared card class: `.np-card`, `.pl-card`, `.gate-card`, `.cv-tool` each define their
      own radius (8, 10, `--r-3`) and padding; make one `.card` with `--radius-card`.
- [ ] Held cards on main draw body rules in `--beacon-rule`: violet as a border, remove.

App (work/mobile)
- [ ] AskCard and TrustCard are inline styles; extract one Card with header and footer slots.

Capsule (work/capsule-pro)
- [ ] HeldCardView uses hand-typed sizes and a caps mono label; use `Tokens.Radius.card` and the
      12/600 sentence-case label.

native-core
- [ ] Settings, Vault, Connections has no card yet. The Connections board (above) is drawn but
      not built; account-row.md's own Gaps names the same page.
