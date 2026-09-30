---
title: File and link preview
summary: A compact row for a file an agent touched or a link it found - icon or thumbnail, name, one meta line, opens in place. Not the full diff, not the full artifact card.
audience: builders
owner: app-design
status: draft
---

# File and link preview

The small, common case: an agent mentions a file it read or wrote, or a link it found, and it
should be tappable without becoming a whole card. This is the row `draft-card.md`'s attachments
and `pr-review.md`'s nothing-yet use underneath them; here it stands alone as its own component
for the plain "here's a file" or "here's a link" moment in chat. New 30 Sep, the user's
chat-components ask.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Lumen | none | not built |

## Anatomy

One row, not a card (no `--panel`, no border) - it sits inline in the agent's own message flow:
height 40, padding 6 10, radius 8, fill `--hover`, gap 10, inline-flex (wraps with text around
it, never forces its own line unless the surrounding text does).

1. **Icon or thumbnail**, 24: a file-kind icon (`--text-2`) for a file with no preview; a 24x24
   cropped image thumbnail for an image file or a link with an OG image; a small favicon for a
   plain link with no image.
2. **Name**, base 600, `--text`, one line, ellipsis: the filename or the link's title (never the
   raw URL as the primary label - the URL is the meta line).
3. **Meta**, base, `--text-2`, one line: a file's size and kind ("2.1 MB · PDF") or a link's
   domain ("docs.example.com").

## Variants

- **File** (as above): tapping opens the file - locally if the surface can (Lumen opens it
  natively; the Deck downloads or opens a viewer for common types), else offers Download.
- **Link**: tapping opens the link in a new tab/window; the row carries no favicon-fetch privacy
  leak of its own (the box fetches the favicon/OG image server-side, never the person's own
  browser reaching an arbitrary third party on render - same principle artifacts' AR3 sandboxed-
  frame rule protects, applied to a simpler case).
- **Multiple, inline**: several previews from one message wrap as a row of chips at this same
  height, gap 8 between them, rather than stacking - this is what a "here are the 3 files I
  changed" summary line looks like before `diff.md`'s Multi-file card is opened for the real diff.
- **Broken / removed**: the icon becomes a plain "missing file" glyph (`--label`), name stays,
  meta reads "No longer available" - never a dead link that silently does nothing on tap.

## Sizes

40 tall fixed. Width is content-driven, capped at 320 with ellipsis past that.

## States

- **Default / Hover** (`--rule` 1px appears on hover, desktop only) / **Focused** (2px `--focus`
  ring) / **Broken** (see Variants).
- **Loading** (a link whose title/image hasn't resolved yet): the icon slot shows a skeleton
  square, name shows the raw URL until the real title resolves, then swaps in place.

## Keyboard and touch

A plain link/button in the tab order; Enter or tap opens it. 44 touch target on the phone even
though the visible row is 40 (padding absorbs the difference, not a taller row).

## Motion

None. The loading-to-resolved swap is instant, not a fade (a fade here would make agent-authored
messages feel like they're still streaming after they're done).

## Copy

Never a raw URL as the visible name when a title is available. "No longer available" for broken.

## Emission (agreed with native-core, sessions)

Inline content within `thread.text` (ADR 0030's existing event), not a separate `renderer:<tool>`
slot - a file/link preview is a rendering hint on a normal text block
(`{kind: "file_preview"|"link_preview", path|url, title?, size?, mime?}` inline in the message),
since it appears mid-sentence in an agent's own prose far more often than as a standalone tool
result. Where an agent's own tool call already returns a file path (a write, a read), native-core
renders this preview automatically for that path - no second call needed.

## What the person's actions do

Opens the file or link. Nothing here is a send/post/pay/delete, so no Gate involvement.

## What agents can do for the person

Nothing beyond making the file/link visible - this component has no write path of its own.

## Accessibility

- A real `a` or `button`, never a `div` with a click handler; `aria-label` combines the name and
  meta ("Report.pdf, 2.1 MB, PDF").
- Broken state is announced via the visible text change itself, no separate live region.

## Gaps

Everything - new component, no surface has built it.
