---
title: Records
summary: What a record is, how types, fields, stages and links work, how to address a record, and how sealed fields appear.
audience: agents
owner: docs
status: stable
tokens: 700
when: You read, create or change a contact, matter, task, note, file or other record, or need to link one record to another.
---

# Records

A record is every thing a firm keeps: a contact, a matter, a task, a note, a file, a chat. Its type says which fields it has. The definitions of a business (types, rules, Flows, views, roles) are records too.

## Address

A record is addressed by a URN: `vyre://<space>/<type>/<id>`. Use the URN, not a name, when you refer to a record. A name can change; the URN does not.

## The tools

Use `records.list` (a type, a filter, a limit, a cursor), `records.get`, `records.create`, `records.update`, `records.linked` (what points at a record) and `records.reference` (a record as data for you, sealed parts as placeholders). `records.types` says which types exist and their fields. Ask `work.tools` for the generated per-type tools you may use.

## Types and kits

<!-- agent:records:start -->

Field kinds: `text`, `rich_text`, `number`, `money`, `boolean`, `date`, `datetime`, `choice`, `multi_choice`, `rating`, `url`, `link`, `actor`, `file`, `address`, `phones`, `emails`, `urls`, `stage`, `sealed`.

Kits that ship, and the record types each adds:
- `base`: contact, lead, appointment, client, subscriber, project.
- `estate-planning`: contact, matter.
- `law-firm`: lead, appointment, client, project.

<!-- agent:records:end -->

A Kit is a package of types, Flows and views. You do not install one directly: you propose it, a person approves.

## Fields

- A field has a type (text, number, date, choice, link, and so on) and may be required.
- A link field points at another record. Follow it with `records.get` on the URN.
- A sealed field shows `{{field:<urn>#<name>}}`. Never ask for its value (read `sealed-and-secrets.md`).
- A restricted field you may not read is also shown as a placeholder or left out. The record is still yours to use.

## Stages

A type with stages moves a record through them. Use the stage tool, not an update of the field: a stage can refuse a move (open tasks, a rule that failed) and the refusal tells you what to do.

## Changing records

- Change only what the person asked. State what you changed.
- An update that races another returns `version_conflict`. Read again, then decide.
- A delete may be held (an outward act). A deleted record sits in the Bin and can be restored by a person.
- Every change writes an event with your chain on it, so it can be shown and undone.
