---
title: Field rows
summary: The fields of a type as rows, each with one line that says everything set on it.
audience: builders
owner: app-design
status: draft
---

# Field rows

A flush card of Rows. Title is the field's name. The line under it is `fieldSummary`: "Choice, 6 options, required", "Link to Client", "Text, unique, hidden from 1 role". The end holds one chip (Sealed, Hidden or Required, in that order of weight) and, when the list can be ordered, up and down buttons. A press opens the field in the field editor; the open one is `selected`.

Implementing file: `apps/app/ui/setup/FieldRows.tsx`. Status: draft, gallery only.
