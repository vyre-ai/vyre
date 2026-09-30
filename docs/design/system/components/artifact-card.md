---
title: Artifact card
summary: A thumbnail of a doc, report, page, dashboard, diagram, deck or app an agent made, opening a version-barred panel beside chat (or a full-screen sheet on the phone), with a diff between versions and a share sheet.
audience: builders
owner: app-design
status: draft
---

# Artifact card

An agent made something durable (a document, a report, a page, a dashboard, a diagram, a deck, a
small app) and it lives on the box, versioned, private by default. This card is how it shows in
chat; the panel it opens is the full viewer. Agreed with the artifacts team (AR1-AR8, CHAT.md,
30 Sep) and cohesion-2; the panel/diff/list-row reuse below was agreed there first and is
restated here as part of the one chat-components contract. New 30 Sep.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | none | not built |
| App | none | not built |
| Capsule | none | not built |

## Anatomy: chat card

A compact row-card, height 56, padding 10 12, radius `--radius-card` (12), fill `--panel`, 1 px
`--rule`:

1. **Icon**, 32: a kind glyph (doc, report, page, dashboard, diagram, deck) on `--hover`, radius 8
   - never a live-rendered thumbnail in chat (that's the panel's job; the row stays cheap).
2. **Title and meta**, a column: title (base 600, `--text`, one line, ellipsis) - "kind · vN ·
   made by <agent> · <relative time>" (meta, `--label`).
3. **Actions**, right: **Open** (outline, opens the panel) and **Share** (ghost, opens the share
   sheet, AR3/AR8) side by side.

## Anatomy: panel (artifacts-options.html section 3, Option A, confirmed)

`panel:<name>` (ADR 0033's slot grammar), 340 wide by default; a page or deck kind may widen to
50% of the window with one control (`docs/design/system/layout.md`'s named exception, committed
9c8479f5) - every other kind stays at 340.

1. **Version bar**, 44 tall, padding 0 16: the title, then right-aligned a version toggle (pill
   buttons per version, `v1` `v2` ..., the current one filled `--text`/`--bg`, others outline),
   **Changes** (ghost, toggles the diff view below) and **Share** (ghost).
2. **Content**, by kind:
   - doc / report: Vyre's own Markdown renderer, in the design system (type scale, no custom CSS
     from the artifact itself).
   - diagram: Mermaid or inline SVG, same renderer as everywhere else diagrams appear.
   - dashboard: a chart spec drawn with the dataviz palette (the project's existing chart
     conventions, not a new one).
   - page / app: HTML inside a sandboxed iframe, `sandbox="allow-scripts"` with no
     `allow-same-origin`, matching ADR 0033's `/m/<module>/` rule exactly (confirmed 06:38,
     CHAT.md) - the raw content URL also carries its own restrictive CSP so even a top-level open
     runs at an opaque origin.
3. **Changes view** (when toggled): `diff.md`'s unified diff between the selected version and the
   one before it - added on the bone wash, removed struck... no, per `diff.md`'s own rule, removed
   on the neutral wash with no strikethrough. Exactly `diff.md`, not a second diff renderer.

## Anatomy: Artifacts tab (per project)

A `list-row.md` list: title, kind/creator/date meta, a visibility chip (chip.md's Tag: "Public ·
29 days" in a neutral, "Only you" otherwise - never an accent, matching every
other neutral-chip rule in this system) right-aligned. Sits beside Threads/Brief/Files/Memory as
its own tab (artifacts-options.html section 3).

## Variants

- **Chat card, phone**: same anatomy, full width, Open leads to the full-screen sheet instead of
  a panel.
- **Panel, phone**: full-screen sheet (ADR 0033's `panel:<name>` phone rule), version bar becomes
  a bottom bar (Versions / Changes / Share, per the confirmed mockup) rather than top-of-panel,
  since the phone's safe-area top is precious and the title needs the space instead.
- **Capsule (compact)**: not drawn at all in the panel/rows/footer shell - "Open in the Deck" only,
  same rule as every other rich-content card here (`pr-review.md`, `email-thread.md`,
  `calendar.md`'s compose forms).

## Sizes

Chat card 56 tall. Panel 340 default / 50% widened (page, deck only). Version pills 28 tall, 8
horizontal padding.

## States

- **Open** as above.
- **Loading** (panel content still rendering): a skeleton block matching the content kind's rough
  shape (text lines for doc/report, a blank canvas for diagram/dashboard).
- **Diff loading**: the version bar's Changes button shows a spinner in place, content stays on
  the current version until the diff is ready.
- **Shared**: the chat card's meta line gains the visibility chip too, so a shared artifact reads
  the same in chat as it does in the Artifacts tab.
- **Error** (page/app failed to render in the sandbox): "This page didn't load" with the failed
  mark, `--text`, no further detail leaked from the sandboxed origin (nothing to leak by design).

## Keyboard and touch

Version pills are a `radiogroup`; ← → move between them when focused. Share opens with `S` when
the panel has focus (no conflict - `draft-card.md`'s "D" is Discard, this panel has no Discard).

## Motion

Panel open/close at `--motion-panel` (220), matching every other `panel:<name>`. Version switch
crossfades the content, no slide (a slide would misread as "this is a different artifact," not
"this is the same artifact, an earlier moment").

## Copy

"kind · vN · made by <agent> · <relative time>", "Open", "Share", "Changes", "Public · <n> days",
"Only you". Never "AI-generated" as a label - the "made by <agent>" meta already says who/what
made it, in the same plain register avatar.md's teammate-tag rule uses elsewhere.

## Emission (agreed with artifacts, sessions, native-core - AR1/AR2)

`thread.artifact {thread, artifact, version, kind, title}` (AR2, agreed in CHAT.md) drives the
chat card. The panel reads the artifact's own versions via `artifacts.get`/`artifacts.diff`
(AR1) directly, not through a chat event - opening the panel is a navigation, not a new message.

## What the person's actions do

Open navigates to the panel/sheet, a read action, no Gate involvement. Share opens the share
sheet (AR3/AR8's `artifacts.share`, `outward: post` - held with Touch ID only when an agent
decided to share alone, matching every other outward classification in this contract; runs at
once when the person tapped or asked, per "asking is approving"). Restoring an old version
(`artifacts.restore`, if the panel exposes it - flagged to artifacts as a possible addition, not
yet in AR1's tool list) would be a write to the person's own project, not outward, so no Touch ID.

## What agents can do for the person

An agent creates and updates artifacts on its own (`artifacts_create`/`artifacts_update`, AR4's
harness-brief line) without asking each time - that's the whole point, replacing scattered
one-off publishing with one governed store. It may never share one publicly on its own without
the person's Touch ID (AR1's `artifacts.share` classification), and it may never delete one
without an explicit ask (AR1 lists `delete` as a plain tool, not `outward`, but a destructive
action the person didn't ask for still needs "asking is approving" to actually match a said
intent - flagged to vault/assistant to confirm delete's Gate treatment, since AR1's own table
doesn't mark it held).

## Accessibility

- The chat card is a `button`-like row (`role="link"` semantics: Open is the default action).
- The panel is a `dialog` region (matching every other `panel:<name>`'s existing pattern) labelled
  by the artifact's title.
- The sandboxed iframe carries `title` describing the artifact, so assistive tech announces what
  it's entering even though its content is opaque to the host page.

## Gaps

Everything - new component, no surface has built it. Depends on AR1's tools and AR2's event
landing first (artifacts' own build order).
