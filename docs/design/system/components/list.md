---
title: List
summary: The list container every place uses, with its header, sticky group headers, filter chips, 40 rows at a time and Load 40 more.
audience: builders
owner: app-design
status: draft
---

# List

The daily surface: Needs you, Chats, Agents, the vault, devices, settings groups. A list holds
rows of one family (needs-row, list-row, settings-row, device-row) under a header and group
headers, and keeps the same seven states everywhere. Drawn on the boards "States, every list,
every size" (the reference), "Needs you, phone and desktop" and "Devices, network and VyreDrive".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.rows`, `.section-head` (main, work/pwa) | partial |
| App | `apps/app/src/ui/List.tsx` (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/CapsuleView.swift` results, SectionHeader; `UI/AgentDeskView.swift` WaitingList (work/capsule-pro) | partial |

## Anatomy

1. **Container.** In a pane (desktop list 320 or 360 wide): no box, rows on `--bg` with a 1 px
   `--rule` bottom border each. As a boxed list inside a page: `--panel`, 1 px `--rule`, radius
   `--radius-card` (12), `overflow: hidden`, rows separated by a `--rule` top border (none on the
   first). Phone: a card per section (radius 10) with the section label outside it.
2. **List header** (optional). Height 32, padding 0 16, gap 12, 1 px `--rule` bottom: the title
   (12/600 `--label`) and meta or a sort word right ("Last seen first").
3. **Group header.** Height 32, padding 0 16, gap 8: an optional status mark, the group name
   (12/16, 600, `--label`), and the count right-aligned (12/16, 400, `--label`). Needs you's
   header uses the beacon dot and `--beacon-ink` for the name only ("Needs you", then "5 · oldest
   first"). Phone section label: 17/24 600 `--text`, padding-top 12, the count in 12/16
   `--label` right.
4. **Filter chips** (many items): a row of filter chips under the header, each with its count
   ("All 128", "Asks 71", "Drafts 40"); see the chip spec.
5. **Load more.** A full-width ghost button "Load 40 more" and, beside it, meta `--label`
   "Showing 40 of 128".
6. **Key footer** (desktop, keyboard lists): padding 10 16, `--rule` top border, key-hint chips
   and words in 12/16 `--label` ("J K move · A allow · D deny").

## Sizes

Rows are 44 minimum (36 in a dense list), phone rows 44 minimum with 17/24 titles. Counts are
exact in headers (128); badges cap at "99+".

## States

- **Empty.** Two or three words and the first action right there, inline: "Nothing needs you"
  and "juno will put anything that needs you here."; "No projects yet" with a name field and
  Create. Empty never hides the page's other sections, and Needs you empty has no dot and no
  badge.
- **Loading.** Skeleton rows at the real row height (tile, title bar, one line, meta). A quiet
  spinner in the header; at 10 s one line: "The box is slow to answer · Cancel" (Cancel keeps
  what arrived). The shine stops under reduced motion.
- **Offline.** Content stays; one pill (see the pill spec). Cached 7 days: projects, agents, the
  last 20 threads. Never cached: held items and the vault, which say they need the box.
- **Error.** Plain words, the detail in mono, a way out: "Couldn't load kit's history",
  `ECONNRESET after 15 s`, Retry, Open doctor. The failed mark in `--text-2`; no red.
- **Many items.** Filter chips, sticky group headers, 40 rows at a time, Load 40 more (never an
  endless scroll, so J and K stay predictable). Virtualized above 100 rows.
- **Long names.** Desktop truncates one line with an ellipsis, the full name in the tooltip and
  the detail header. Phone titles wrap to two lines at larger text sizes; the row grows. Paths
  truncate in mono and keep the file name.
- **Decided.** A "Decided today" group with neutral rows (see the needs-row spec).

## Keyboard and touch

J and K (and ↓ ↑) move the selection; Enter opens; Home and End jump. Focus stays in the list
while the detail updates. Phone: one inner scroller per page with `overscroll-behavior: contain`;
the header stays fixed.

## Motion

Group headers stick with `position: sticky; top: 0` on `--bg` (on `--panel` in a boxed list).
Rows arriving live insert without moving the row under the pointer or the selection. A row that
leaves collapses over `--motion-tap`.

## Copy

Group names in sentence case: "Needs you", "Working", "Decided today", "Your devices". "Load 40
more", "Showing 40 of 128". Never "Show earlier", never caps.

## Accessibility

`role="list"` (or `listbox` where selection means something, with `aria-activedescendant`).
Group headers are headings (level 2 or 3) so screen readers can jump between them. Counts are
read with the name ("Needs you, 5"). Skeletons are `aria-hidden`; the header says "Loading".

## Gaps

Deck
- [ ] `.rows` and `.section-head` have no sticky group headers, no filter chips with counts, no
      key footer; long lists page with "Show earlier" only.
- [ ] No skeleton rows (lists show "Loading devices." text); no slow-box line at 10 s.

App (work/mobile)
- [ ] Virtualized above 100 rows (correct); no sticky group headers, no Load 40 more, no chips.

Capsule (work/capsule-pro)
- [ ] SectionHeader is mono 10 caps with tracking; use 12/600 sentence case.
- [ ] The waiting list caps at 9 rows (`Theme.maxRows`) with no count or more.
