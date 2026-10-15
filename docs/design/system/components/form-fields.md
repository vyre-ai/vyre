---
title: Form fields
summary: The questions of an ask card's form, one control each: text, a number, a day, one of a list, a yes or no, a file in Vyre Files.
audience: builders
owner: app-design
status: draft
---

# Form fields

The questions an author puts on an Ask step in a Flow (`form`, kernel/flows/schema.js), drawn on the ask card above its Yes and No. One component, so every card with questions asks them the same way. Built on the [form controls](form-controls.md).

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/FormFields.tsx`: a control per question | built |
| App | `apps/app/ui/components/form-fields-model.js`: blank answers, what is missing, what is handed in | built |

## Anatomy

One control per question, stacked: a text box, a number box, the date picker, a list to choose from, a switch for yes or no, or a box for a file's path in Vyre Files. A required question says "(required)" in its label. Nothing else is drawn: the card keeps its title, its sentence and its buttons.

## Answers

The answers are held by the card. Yes hands in the answered questions (a yes or no as true or false, the rest as typed); the engine reads a number or a day from the text and checks every answer against the form again before the Flow goes on. A required question left empty marks itself ("Answer this to go on.") when Yes is pressed and the answer is not handed in.

## States

Empty, filled, a required question missing (the error line and border), disabled.
