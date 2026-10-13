---
title: Sortable list
summary: A list whose rows are dragged by a grip to change their order (an agent's model plan).
audience: builders
owner: app-design
status: draft
---

# Sortable list

A list of rows of one fixed height whose order matters and is the person's to change: the models an
agent runs on, in the order they are tried. Not for long lists or for sorting by a column (that is
the table).

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/SortableList.tsx` | built |

## Anatomy

A 32 wide grip (the `sort` icon, `--text-3`) at the start of each row, then the caller's row. The row
is one height, 64 by default.

## States

- **Resting.** The row sits in place.
- **Held.** The row lifts: scale 1.015, opacity 0.96, above its neighbours, and follows the finger or
  pointer up and down.
- **Dropped.** The row settles with the fast spatial spring. If it moved by more than half a row, the
  caller is told `onMove(from, to)`; the caller owns the order and redraws.

## Rules

- Dragging is never the only way. The caller keeps Move up and Move down buttons in each row, with
  names, so a keyboard, a screen reader and a switch can reorder.
- The grip is named "Drag to reorder".
- The list never reorders itself and never saves; the caller shows the new order and a Save.
- Reduced motion: the lift and the settle are instant.
