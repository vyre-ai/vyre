---
title: Control row
summary: One setting with a switch at the end, or with a segmented choice under its text; used where a list of settings is edited as you go.
audience: builders
owner: app-design
status: draft
---

# Control row

The Roles editor's row: a title, one line under it and one control. It saves as you go, like the
settings row, and has no reset slot (a role's setting has no inherited value). A switch is for a
yes or no ("Mail"). A choice is for up to four words ("None", "Read", "Edit") and sits under the
text, full width, so it never crowds a phone.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/ControlRow.tsx`, exported from `@vyre/ui` | built |
| Deck, Lumen | not used | |

## Anatomy

**Switch row.** A dense row (56): title (medium 16/22), one 14/18 line in `--label`, the switch
(44 by 26) at the end. The label of the switch is the title.

**Choice row.** Padding 16 by 12, gap 8: title and line, then the segmented control filled to the
width (equal segments, 40 high on a phone, 36 wider). Children, if any, sit under the control (the
chips of fields a data rule can hide).

## States

- **Default.** Control shows the current value.
- **Locked** (a built-in role): the switch is disabled in `--label` ink; the segmented control
  ignores presses. The screen says why in a banner above the section, once, never per row.
- **Saving.** Optimistic: the control shows the new value on the frame of the change. A refusal
  flips it back and a toast gives the reason.

## Keyboard and touch

Space toggles a focused switch; arrow keys move a segmented choice. Every control is a 44 target
on a phone.

## Copy

Titles are plain verbs or nouns ("Change work", "Mail"). Lines say what it lets the role do, in
one sentence.

## Gaps

- [ ] No "Saved" confirmation in a reserved slot (see the settings row spec).
