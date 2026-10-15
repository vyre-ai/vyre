---
title: File picks
summary: Several files for a form: one removable chip each, a search of the Space's Files, and a value from an earlier step that stands for a file.
audience: builders
owner: app-design
status: draft
---

# File picks

A form field that takes up to ten files. Each pick is a [chip token](chip-token.md) with a file icon (or the mention icon when it is a value from an earlier step), and the x on the chip takes it off.
Under the chips are two quiet buttons: **Add a file** opens a list under the field with a search box and up to eight rows of file names (each row is a [list row](list-row.md) with the
folder as its second line), and **Insert a value** opens a [menu](popover.md) of the values earlier steps made. A file already picked is not offered twice, and the buttons stop at the limit.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/FilePicks.tsx` | built |

## What it keeps

The component shows what is picked and hands back the list. What a pick is kept as (a path of Files, or the engine's token for a value) is the caller's: the Flow editor's email step keeps
paths and tokens in the step's `attachments` (`apps/app/ui/flows/AttachmentsField.tsx`).

## States

Looking (while the search answers), nothing found (says whether the box is empty or a name matched nothing), full (both buttons disabled), none picked (no chips, only the buttons).

## Words

The label says what the files are for ("Files to attach"). The help line says the limit and what happens at the end, in plain words.
