---
title: Account picker row
summary: The one row for choosing which account does a thing, from vault.connections.list {capability}. Provider tile, account, label, Default or Last used, and its state with the fix inline, in suggestions, Lumen, chat and a send's draft card, with Connect another at the end.
audience: builders
owner: app-design
status: draft
---

# Account picker row

"Send an email" can go out as alex@harlowlegal.com or as alex@northwindbakery.com. Whenever Vyre
needs to know which account does a thing, it lists the accounts that can, from the vault's one
connections list, `vault.connections.list {capability, surface}` (ADR 0028 decision 9b; cohesion's
item 3), and draws each one with this row. It is a list row (list-row.md) with an avatar tile
(avatar.md) and, when a row needs a fix, an inline button that opens the credential sheet
(credential-sheet.md). No surface keeps its own account list. Not drawn on a board yet (see Gaps).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | the draft card's From row (`deck/chat/gate-item.js`, work/chat); the phone sheet `deck/js/need-sheet.js` (work/pwa) | not built |
| App | the draft screen `apps/app/app/need/[id].tsx` (work/mobile) | not built |
| Lumen | a "Send from" group in `local/capsule/native/Sources/UI/CapsuleView.swift` (proposed, work/capsule-pro) | not built |

## Anatomy

A list row, two line, min height 44, padding 6 16, gap 12:

1. **Provider tile.** An avatar place tile, 24 on the desktop (20 in Lumen, 32 on the
   phone), fill `--hover`, with the provider's glyph at 16 in `--text-2`: one monochrome glyph per
   provider (Google, Microsoft, a mail login, Slack). Until a provider has a glyph, the tile shows
   the provider's initial at the tile's text size. Never a logo in its brand colours.
2. **Account.** The account as the provider names it, base size `--text`, one line, ellipsis in
   the middle for a long address ("alex@harlowle…legal.com"): alex@harlowlegal.com. In
   suggestions the matched part is 600.
3. **Meta line.** 12/16 `--label`: the label and the provider, joined with " · ": "Harlow Legal ·
   Google", "Northwind Bakery · Mail login". A row with no label shows the provider only.
4. **Trailing.** One of, in this order of priority:
   - the state's fix, when the row is not ready (see States);
   - **Default**, 12/16 `--text-2`, when the person made this account the default for the
     capability;
   - **Last used**, 12/16 `--label`, on the account used most recently for this capability, when
     no default is set;
   - nothing.
5. **Check** (pickers only). A 16 check in `--focus` on the account chosen now, a 16 spacer on the
   others, as the popover's picker rows.

**Connect another.** The last row of every account list: a tile with the plus icon, "Connect
another account" base `--text`, meta 12/16 `--label` naming what can be added for the capability
("Google, Microsoft or a mail login"). It opens the credential sheet for that capability's need.

## Variants

| Where | How it shows |
|---|---|
| Suggestions (Words lane) | the account kind's row in suggestions.md, with this row's trailing; ⏎ starts from that account |
| Lumen | "send an email" (or any words that name a capability) shows a "Send from" group of these rows at 44, ready rows first; ⏎ opens the draft from that account |
| Chat | an agent that needs an account for a send lists them to the person in a question card whose choices are these rows (radio leading, provider tile after it) |
| A send's draft card | a From field row (draft-card.md) shows the chosen account in mono 13; clicking it opens a picker popover of these rows (a sheet on the phone). With one ready account there is no picker: the row reads the account and nothing opens |
| Settings, Vault, Connections | grown into the Connections card (card.md): this row at the top, then a "Granted to" row of filter chips (chip.md) per surface, then a footer with "Wrong account?" and the connected date |

Order: ready rows by Default, then Last used, then the box's order; then rows that need a fix;
then Connect another.

## Sizes

| | Desktop | Phone | Lumen |
|---|---|---|---|
| Row | 44 (32 dense in a popover) | 56 | 44 |
| Tile | 24 | 32 | 20 |
| Account | 13/18 | 17/24 | 13/18 |
| Meta, trailing | 12/16 | 12/16 | 12/16 |

## States

| State (from the row) | Meta line | Trailing | Can be picked |
|---|---|---|---|
| Ready | label · provider | Default, Last used or nothing | yes |
| Needs sign-in (`needs_credential`, `missing`, `not_granted`) | "Needs sign-in" in `--text-2` | **Sign in**, outline button xs (28, 44 on touch) | no |
| Expired | "Expired 3d ago" in `--text-2` | **Sign in again**, outline button xs | no |
| Pending (an approval the provider is waiting on) | "Waiting for Google" in `--label` | nothing | no |
| Signing in | the row's fix reads "Signing in" with a spinner | | no |

A row that cannot be picked has `--label` account ink and no hover; its fix is the only control on
it. Sign in and Sign in again open the credential sheet with `{module, need, account}` from the
row's needs. When the sheet finishes, the row turns ready in place and is picked if it was the one
asked for. None of these states is violet: an account that needs a fix does not wait on you until
something tries to use it, and then the credential sheet shows.

Hover, focus and active as list-row.md (active in a popover: `--signal-wash`).

## Keyboard and touch

↑ ↓ move, ⏎ picks, Esc closes the picker. On a row that needs a fix, ⏎ opens the credential sheet.
In Lumen, ⌘1 to ⌘9 pick the first nine ready rows (the key hint shows on the first three).
On touch the whole row is the target, except the fix button, which is its own 44 target.

## Motion

None beyond the popover and the sheet. A row that turns ready changes in place with no animation.

## Copy

- "Send from", "Connect another account", "Default", "Last used", "Needs sign-in", "Sign in",
  "Expired 3d ago", "Sign in again", "Waiting for Google", "Signing in".
- The account as written by the provider; the label as the person named it. Never a connection
  id, a token, an auth kind ("oauth") or a tool name.
- A project's screen never shows another client's accounts' labels (copy.md, Names): when the
  capability list mixes clients, rows outside the current project show the address and provider
  only.

## Accessibility

- In a picker: `role="option"` with `aria-selected`; the name is the account, the label and the
  state: "alex@northwindbakery.com, Northwind Bakery, Google, needs sign-in".
- The fix button is a real button named with the account: "Sign in to alex@northwindbakery.com".
- State is always in words, never colour or a mark alone.

## Gaps

Deck (work/chat)
- [ ] The draft card has no From row and no account picker; add it, from
      `vault.connections.list {capability: "send_mail", surface: "chat"}`.

Deck (work/pwa)
- [ ] The phone draft sheet has no From row; the picker opens as a sheet with 56 rows.

App (work/mobile)
- [ ] Nothing built: the From row and the picker sheet on the draft screen.

Lumen (work/capsule-pro)
- [ ] No "Send from" group: read `vault.connections.list {capability, surface: "capsule"}` when
      the words name a capability, with the states, the Sign in fix and Connect another. (The
      "Sends to" row is where a message goes, not which account sends it; it stays.)

native-core
- [ ] Settings, Vault, Connections: build the Connections card (card.md): this row, the grant chips, "Wrong account?". Drawn on the Connections board (Sep 2026); not built.

vault
- [ ] A default per capability (proposed: `vault.connections.update {id, default: capability}`)
      and a last used time on each row, so the markers need no guess.

System (app-design)
- [ ] Monochrome provider glyphs (google, microsoft, mail, slack) and a mail icon in icons.txt;
      the AccountRow board on the canvas.
