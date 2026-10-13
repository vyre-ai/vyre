---
title: Stack
summary: One layout primitive for screens: children in a column or a row with a gap from the space scale.
audience: builders
owner: app-design
status: draft
---

# Stack

Screens carry layout and copy only, no sizes. Stack is the layout: a column (or a row) whose gap is a step of the space scale.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/Stack.tsx` (@vyre/ui) | built |

## Props

`gap` 0 to 6 or 8, meaning `--s-N` (default 3); `row`; `wrap`; `align` start, center, end, stretch; `justify` start, center, end, between; `grow`.

## Rules

- The gap is a name of a space step, never a number of pixels.
- Children may shrink: the Stack has a minimum width of 0 so long text truncates or wraps instead of pushing the page wide.
- It draws nothing: no fill, border or padding. Use a [card](card.md) for a surface.

## Gaps

- [ ] None.

