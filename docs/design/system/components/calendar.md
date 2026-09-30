---
title: Calendar invite and event card
summary: A held outbound invite (title, time zone-aware time, people with availability, location or video, edit in place, Send) as a draft-card.md variant, and a read-only event card for an existing meeting.
audience: builders
owner: app-design
status: draft
---

# Calendar invite and event card

An agent drafts a meeting invite, or shows you one that already exists. The invite is a
`draft-card.md` variant (it's a held outbound thing, same Gate rules); the event card is a plain
read view, closer to `result-card.md`'s Card view. New 30 Sep, the user's chat-components ask.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Capsule | none (compact form only, see Variants) | not built |

## Anatomy: invite (draft-card.md variant)

Same shell and field-row anatomy as `draft-card.md`, with calendar-specific fields and one new
part:

1. **Header**: "Invite to send", same as a draft's "Draft to send" label.
2. **Field rows**: Title, When (see Time below), People (see Availability below), Where (a place
   name or "Video call" with the provider's icon), Message (optional, same prose rules as an
   email's body).
3. **Time**: shown in the viewer's own time zone always, with the organizer's zone in `--label`
   beside it when they differ ("10:00–10:30 PT · 13:00 organizer's time"). Editing the time opens
   a plain time/date field, no separate zone picker - the zone follows the device.
4. **Availability**: each invited person's row (People) carries a small status mark
   (status-mark.md's shapes, repurposed: hollow-dot "free", filled dot "busy", crossed-circle
   "no answer yet" - never a colour, the mark and a word) to the right of their name, resolved
   from the connector's own free/busy read where available; absent entirely when the connector
   can't answer (never a guess).
5. **Footer**: **Send invite** `⌘⏎` (primary), the presence line (presence-line.md, same proof
   rules as any other send), **Discard** (ghost) - identical footer shape to `draft-card.md`.

## Anatomy: event card (read-only)

1. **Header**, 44 tall: calendar icon, the event title (base 600, `--text`), right the date in
   meta `--label`.
2. **Time and place**, base, `--text-2`: "10:00–10:30 PT · Video call" with the join link as a
   ghost button when the event is starting within 15 minutes, otherwise plain text.
3. **People row**: avatars (avatar.md, 20, stacked with -8 overlap) up to 5, then "+3" (meta,
   `--label`); tapping expands the full list with availability marks as in the invite.
4. **Footer** (only when the event needs a response): **Accept**, **Tentative**, **Decline**
   (three outline buttons, equal width) - this is the one place this card accepts input; everything
   else is read-only.

## Variants

- **Invite, desktop / phone**: follows `draft-card.md`'s own desktop/phone variants exactly (field
  hover-to-edit on desktop, `ph-card` fields on phone).
- **Invite, Capsule (compact)**: title, time, first 2 attendees' names - "Open in the Deck" only,
  same rule as every other compose-shaped card here.
- **Event card, Capsule (compact)**: title, time, join link if imminent - no people row.
- **Recurring**: the header gains a small repeat icon (12, `--label`) beside the date; editing or
  responding asks "This event" or "All events" (a two-option inline choice, not a full sheet).

## Sizes

Shared with `draft-card.md` (buttons 32/54/44, key column 64) and `avatar.md` (20/24/32/40 scale -
the people row's 20 and the overlap stacking are the one new pattern here, flagged the same way
`pr-review.md`'s comment avatars are).

## States

Invite: identical state set to `draft-card.md` (Field default/Hover/Editing, Edited, Covered/
Lapsed, Busy, Sent, Discarded, Failed, Offline) - no new states, just calendar fields.

Event card: **Responding** (a button keeps its width, spinner, "Accepting"); **Responded**
("You accepted" replaces the footer, with "Change" as a quiet steplink); **Past** (the footer
never shows on a past event, join link never shows).

## Emission (agreed with sessions, native-core, vault)

Invite: a `draft-card.md`-style held-outbound emission - `outward: post` in the Gate's
classification (an invite reaches other people, same as an email), so P17's proof-then-act rule
applies exactly as it does for any other send. Event card: a `renderer:<tool>` slot result (no
Gate involvement, it's a read), `render: {kind: "calendar_event", title, start, end, tz, location,
attendees: [{name, status}], needsResponse}`.

## What the person's actions do

Send invite calls the connector's create-event tool (vendor-hosted Workspace/Microsoft MCP, per
charter minimum 9), held until proof exactly as `draft-card.md` describes. Accept/Tentative/
Decline on an event card call the connector's respond-to-event tool; per "asking is approving",
this is a real answer to a real invite the person is reading, so no Touch ID - same reasoning as
`pr-review.md`'s Approve and merge.

## What agents can do for the person

An agent may draft an invite and check availability on its own; it may never send one without the
Gate's proof step, and it may never accept/decline an invitation on the person's behalf - a
calendar response is a personal commitment, not a delegable action, so this card's Accept/
Tentative/Decline row has no agent-initiated path, same principle as `pr-review.md`'s "no
self-approval."

## Accessibility

- Availability marks carry their word ("free", "busy", "no answer yet"), never colour alone.
- The stacked avatar row is `aria-hidden`; the expanded list is the real, readable content.
- Time is always announced in the viewer's own zone; the organizer's zone (when shown) is a
  secondary, labelled value.

## Gaps

Everything - new component, no surface has built it. Depends on the connector's create-event and
free/busy read shapes (vault's hosted-MCP work) landing first.
