---
title: Choice list
summary: A short list of cards where one is chosen: Create a space or Join a space, run here or on the server.
audience: builders
owner: app-design
status: draft
---

# Choice list

Two to four cards, one chosen. Not a [segmented control](form-controls.md) (those are for a view or a filter), because each choice needs a sentence.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/ChoiceList.tsx` (@vyre/ui) | built |

## Anatomy

Each card: an [icon tile](avatar.md) 40, a title (strong), one muted line, and at the right a check that appears on the chosen card. Chosen: accent border and wash. Not chosen: surface-2 with an edge. The list is a radio group; each card is a radio with a selected state, so colour is never the only signal. Press springs the card down to 0.985.

## Behaviour

`value` empty means nothing chosen; the screen keeps its primary disabled until there is a choice.

## Gaps

- [ ] No keyboard arrow movement between cards beyond Tab.

