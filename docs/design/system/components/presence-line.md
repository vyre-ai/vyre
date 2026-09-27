---
title: Presence line
summary: The quiet line under Send that says a Face ID or Touch ID proof covers sends and until when, the lapsed "Send with Face ID" state, and the sign-in sheet for a new device.
audience: builders
owner: app-design
status: draft
---

# Presence line

One proof covers sends for 30 minutes, and the screen says so. The presence line sits under or
beside the Send button of every held draft (and vault release), so you always know whether the
next send asks for Face ID. When the proof has lapsed, the button you press runs it; there is no
wall. Drawn on "Presence, sign in once, prove it rarely" and "Needs you, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/need-sheet.js` coverLine, `deck/chat/gate-item.js`, `deck/js/person.js` (work/pwa); `deck/views/memory-presence.js` | partial |
| App | `apps/app/src/state/needs-model.ts` (logic only, work/mobile) | not built |
| Capsule | `local/capsule/native/Sources/UI/PresenceView.swift` (work/capsule-pro) | partial |

## Anatomy

**Covered.** Meta size, `--label`, one line in the draft card footer (desktop) or under Send
(phone, base `--text-2`, may wrap to two lines): "Face ID confirmed 12 min ago · covers sends
until 15:02". The minutes come from presence.since; the end time is presence.since plus 30 min.
Send is plain "Send".

**Lapsed.** The primary becomes "Send with Face ID" with the faceid icon (16 desktop, 20 phone)
before the label. Under it, base `--text-2`: "Last Face ID 34 min ago · this one covers sends for
30 min". Secondary and Discard are unchanged.

**After the proof.** In place, no new screen: the draft collapses to a row with the check glyph,
"Sent to Sam" (read), Undo (ghost 28) and the countdown "4 s" (meta `--label`). The send commits
through the outbox on the frame the proof returns.

**Sign-in sheet** (a new device; the box answers 401 person_session_required). A phone sheet
(radius 14 top, grabber, scrim) or a desktop centred card:
1. Icon tile (40, `--hover`, radius 10) with the faceid icon.
2. "Sign in on this device" (title 600) and "Vyre needs to know it's you on this iPhone. Once,
   for 30 days." (read, `--text-2`).
3. The action that asked: "Then kit's ask to run git push origin q3-report goes through." (base
   `--text-2`, the command in mono).
4. "This unlocks here" (base `--text-2`) and three check rows: "Answer asks and questions",
   "Approve held sends", "Take over a computer"; a clock row "Sends and vault secrets still ask for
   Face ID, once per 30 min."
5. **Sign in with Face ID** (primary, 54) and **Add a passkey with a code from your Mac**
   (secondary, 44), then "No passkey here yet? Run vyre presence code on the Mac, type it, then
   sign in with the new passkey." (base `--text-2`).
6. Footer, meta `--label`: "The passkey stays on this iPhone. vyre.harlow.ts.net as alex."

## Variants

The proof word follows the device: "Face ID" (iPhone), "Touch ID" (Mac), "fingerprint" (Android),
"your passkey" (a browser without biometrics). The Capsule uses "Touch ID" and its own glyph.

## Sizes

Desktop: meta 12/16, inline in a 32 footer. Phone: base 13/18 under a 54 button, 8 gap.

## States

- **Covered**, **lapsed**, **proving** (the button keeps its width with the spinner and "Checking
  Face ID"), **sent** with Undo, **refused** (the proof was cancelled: the line reads "Face ID was
  cancelled. Nothing was sent." and the button returns), **not required** (the action needs no
  proof: no line at all).
- The label is right on first paint: coverage is read from the cached item, never fetched after.
- A lapse (403 presence_required) never opens a sheet; only 401 person_session_required does, once,
  on the first person action, naming it; after sign-in the action resumes and nothing is typed twice.

## Keyboard and touch

`⌘⏎` on a lapsed Send starts the proof. The sheet's primary takes Enter; Esc or a swipe down
closes it and the action stays unsent.

## Motion

The line text swaps in place; no reflow (the line's space is reserved in both states). Sheet at
`--motion-sheet` (280). Undo lasts `--motion-undo` (4 s).

## Copy

Exact strings above. Proofs are asked only to pair, release a vault secret, or send, post, pay or
delete outside. Never for answering, allowing an ask, take over or revoking; never "Authenticate",
"Verify your identity", "Session expired".

## Accessibility

- The line is `aria-live="polite"`; it is text, never only an icon.
- "Send with Face ID" names the proof in its accessible label.
- The sheet is a `dialog` with `aria-labelledby` on its title; focus starts on the primary.

## Gaps

Deck (work/pwa, work/chat)
- [ ] Wording "Face ID covers sends until 14:32, confirmed 6 min ago"; spec: "Face ID confirmed
      12 min ago · covers sends until 15:02".
- [ ] No "Last Face ID 34 min ago" line in the lapsed state.
- [ ] The sign-in sheet's primary reads "Sign in with your passkey"; spec: "Sign in with Face ID"
      plus the code path button and the unlock list.
- [ ] work/chat gate card has no presence line.

App (work/mobile)
- [ ] Not built: coverage is computed, nothing is drawn; sends go to the Deck or the Capsule.

Capsule (work/capsule-pro)
- [ ] PresenceView is only the proof prompt ("Confirm it's you", "Touch ID to approve exactly
      this."); there is no covered line under Send and no lapsed "Send with Touch ID" label.
