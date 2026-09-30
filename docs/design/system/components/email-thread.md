---
title: Email thread card
summary: A read view of an email thread an agent found or is discussing, messages collapsed to the newest with sender rows, paired with draft-card.md for composing the reply.
audience: builders
owner: app-design
status: draft
---

# Email thread card

An agent surfaces an email thread ("the renewal reminder from your billing system") for you to
read in context, separate from `draft-card.md`'s outbound compose form, which already covers a
draft you're about to send. New 30 Sep, the user's chat-components ask.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Capsule | none (compact form only, see Variants) | not built |

## Anatomy

A neutral card, same shell as every other card here: `--panel`, 1 px `--rule`, radius 12 (phone
10).

1. **Header**, 44 tall, padding 0 16: mail icon (16, `--text-2`), subject (base 600, `--text`),
   right the message count in meta `--label` ("4 messages").
2. **Message rows**, one per message, newest first, padding 10 16, 1 px `--rule` top:
   - sender avatar (avatar.md, 24) and name (base 600, `--text`), timestamp right (meta,
     `--label`);
   - the newest message's body shows in full, base, `--text`, paragraphs 8 apart; every earlier
     message collapses to one line ("Following up on the October numbers...", `--text-2`, base) -
     tapping a collapsed row expands it in place, no navigation;
   - an attachment shows as `draft-card.md`'s file row (icon, name, size in meta).
3. **Footer**, padding 12 16, 1 px `--rule` top: **Reply** (outline) opens `draft-card.md` prefilled
   with this thread's participants and subject ("Re: ..."); **Open in Mail** (ghost) when the
   connector exposes a native link.

## Variants

- **Desktop / phone**: identical structure; the phone caps the newest message at 12 lines with
  "Show all" rather than scrolling the whole card.
- **Capsule (compact)**: subject, sender of the newest message, its first line, "4 messages" -
  "Open in the Deck" is the only action, same rule `pr-review.md`'s compact form uses for anything
  that needs real reading room.
- **Single message**: no thread chrome at all - the one message's sender, body and attachments,
  header reads the subject with no count.

## Sizes

Message rows have no fixed height (content-driven); collapsed rows are one line, 20 tall.

## States

- **Default** as above.
- **Loading**: the header plus 2 skeleton message rows (`--hover`, 10 tall bars).
- **Empty thread found** (a search that matched nothing): "Nothing on this in your inbox" in
  `--text-2`, no card - this is a report line (`result-card.md`'s Text view), not this component.
- **Error**: "Couldn't read this thread" with the failed mark and Retry (ghost), same pattern as
  every other card's error line here.

## Emission (agreed with sessions, native-core, vault - the connector read)

A `renderer:<tool>` slot result (ADR 0033), from whichever connector tool reads mail (the vendor-
hosted Gmail/Workspace MCP, per charter minimum 9 - never a Vyre-run mail client): `render: {kind:
"email_thread", subject, messages: [{from, to, at, body, attachments}]}`. Reading mail is not an
outward action (nothing leaves as the person), so no Gate involvement to display this card -
`draft-card.md`'s own emission and Gate rules cover the Reply action once it opens.

## What the person's actions do

Reply opens the compose form (`draft-card.md`); nothing in this card itself sends anything.

## What agents can do for the person

An agent may read and summarize a thread (a `report`, `result-card.md`'s Text view, referencing
this card) and may draft a reply (`draft-card.md`), but every send still goes through that card's
own held-for-approval state - reading a thread to draft a reply never itself authorizes sending it.

## Accessibility

- The card is a `section` labelled by the subject; messages are a `list`.
- Collapsed/expanded state on a message row is `aria-expanded`.
- Sender avatars are `aria-hidden` (the name beside them carries the information, per avatar.md).

## Gaps

Everything - new component, no surface has built it. Depends on the connector's own read shape
(vault/github's hosted-MCP work) landing first.
