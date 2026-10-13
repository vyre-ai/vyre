---
title: Field editor
summary: One pane to define a field of a Records type: name and kind, options, a relation, rules, conditions and who sees it. Includes the choices editor, relation editor, rule builder and visibility matrix.
audience: builders
owner: records-ux
status: draft
---

# Field editor

The place a person defines one field of a record type (Settings, Customize, a type). It replaces the single "Add a field" sheet, which could set a name and a kind and nothing else. It is a pane: beside the field list on a desk, a sheet on a phone.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/setup/FieldEditor.tsx` and its parts; pure half in `ui/setup/logic.js` | draft, gallery only |

## Anatomy, top to bottom

1. **Name, help text, kind.** Kind is a chip row of the kernel's kinds (sealed and stage are set elsewhere).
2. **Only what the kind needs.** A choice shows the **choices editor** (add, edit in place, move up and down, remove; blank and repeated options are errors). A link shows the **relation editor**: which type, one or many, the name shown on the other type, and two sentences that read the relation from both sides ("Each Asset belongs to one Client. A Client can have many Assets, shown as Assets on the Client.").
3. **Rules.** Required, Must be unique (off and explained for a kind that cannot hold it), Hide for now (data kept).
4. **Only sometimes.** Two **rule builders**: show only when, require only when. A pick of field, compare (is, is not, is filled in) and value, written to the stored Expression (`kind != "Other"`) and read back in words.
5. **Who sees it.** The **visibility matrix**: a switch per role (off writes `hidden_from`), and the Seal from AI switch.
6. Save and Cancel. Errors show after the first Save, under the control they belong to.

## Rules it enforces (all in `logic.js`, tested)

A name is needed and unique among the type's fields. A choice needs at least one option, none empty, none repeated. A link needs an existing target. Unique only on text, number, url, choice, date, datetime. Required and hidden do not go together; required and required-when do not go together. A sealed field stores as kind sealed and keeps no value rules.

## Output

`toDefinition(draft)` returns the kernel `FieldDefinition` (`required`, `unique`, `hidden`, `options`, `to`, `many`, `inverse`, `hidden_from`, `visible_if`, `required_if`); anything off or empty is left out.

## Tokens and parts

No values of its own: Card, Row, Switch, Chip, Field, Segmented, Select, SectionLabel, Button from the library.
