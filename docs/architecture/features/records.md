---
title: Records
summary: The typed rows a Space keeps (contacts, matters, tasks, anything it defines), with fields, links, sealed values, views and CSV or Excel import and export.
audience: builders, agents
owner: docs
status: stable
---

# Records

## What it is
A record is one row of a type a Space defines: a contact, a matter, a task, a note. The type says which fields it has, how they link to other records and how they are shown.
The kernel keeps the rows and judges every read and write; the `records` module (core/records-tools) is the app's way in, one tool per call.

## What a person sees
- **Records** screen (`/u/records/<type>`): the rows of one type as a **List**, **Board**, **Calendar** or **Dashboard**, with a search box, filter chips, **New view**, **Pin to sidebar**, **Import** and, on the web, **Export CSV**. A phone has no CSV export yet.
- A **record page** shows fields in their groups, **Add a field**, the records linked to it, a timeline and, when Documents has templates, **Make document** and **Send for signature** (see [documents-and-signing](./documents-and-signing.md)).
- **Customize** (Settings, page title **Objects**, "Objects, fields and groups"): **Add a type**, **Add a field**, groups, stages. Field kinds on offer are Text, Number, Money, Date, Choice, Stage, Person or agent, Link, File, Address, Phone, Email, Rich text, Rating and Sealed. An object page has **Copy all as a list**, which copies each field with its template token such as `{contact.name}`.
- **Import** takes a CSV or an `.xlsx` file (a sheet picker when there is more than one) or pasted rows, matches columns to fields, checks every row, and adds rows one by one through the same create a form uses. A row that matches an existing record is skipped or added anyway, as the person picks.
- A sealed field shows a placeholder, never the value. Revealing it is a separate act on the person's own screen.
- In the chat composer, `#` puts a record, a whole object (`type/<object>`) or a template's projects in front of the AI.

## How it works
**Data.** Types are `TypeDefinition` rows: `fields`, `stages`, `stage_sets`, `views`, `rules`, `groups`, and `role` for types such as a prospect or client that point at a contact or organization (kernel/contracts/fields.d.ts). Every Space has the core types in records/core-types.js (`contact`, `organization`, `contact_point`, `communication`, `task`, `project`, `event`, `template`, `playbook`, `team-member`, `skill`, `chat-record`, `file-share`, `project-template`). A Kit (records/kits: `base`, `law-firm`, `estate-planning`) adds more; a person adds their own in Customize.

**Fields.** Kinds are text, rich_text, number, money, boolean, date, datetime, choice, multi_choice, rating, url, link, actor, file, address, phones, emails, urls, stage and sealed. Switches on any field: `required`, `unique`, `hidden` (data kept), `hidden_from` (roles that never see it), `visible_if`, `required_if`, `computed` (an expression, or a total over records that link here), `group`.

**Links.** A `link` field with `to` points at one record type; `many` makes it a list; the gateway adds a named inverse field on the target (kernel/gateway/links.js). `records.linked` lists what points at a record, `records.roles` and `records.holders` answer what a contact is to the Space and who holds a role.

**Sealed fields.** A sealed field holds a reference, not the value. `records.seal-put` sends the value to the sealing process and the record keeps only the reference. `records.reveal` shows it once on the person's screen and needs fresh presence; the chain must be one person. A model sees `{ sealed, present, valid_format }` only (lib/sealed.js). `records.reference` renders a record for the AI with sealed parts as `{{field:<urn>#<name>}}`; the kernel resolves such a token only inside an outward tool call, under the asking person's chain, and the call is held for approval (kernel/core/fields.js).

**Tools** (core/records-tools/module.json): `records.types`, `records.define`, `records.list`, `records.get`, `records.create`, `records.update`, `records.reference`, `records.linked`, `records.roles`, `records.holders`, `records.events`, `records.sees-as`, `records.seal-put`, `records.reveal`, `records.forget`, `records.forget.propose`, `records.kits.library`, `records.kits.get`, `records.me`, `records.actors`. An update carries `base_version`; a stale one is refused as `version_conflict`. A list can include the Bin (`include_deleted`). The kernel's own bookkeeping types (Flows, Kits, goals, previews) are left out of `records.types` unless `system: true` is asked for (lib/record-types.js).

**Checks on every call.** The tool opens a door (lib/gateway-door.js) that builds the caller's own chain in the Space the call names; the kernel then checks the action (records.read, `records.create`, `records.update`, records.remove, records.restore, `records.define`, events.read), the role, `hidden_from`, sealed fields and rules. Types a module keeps (`skill`, `chat-record`, `goal` and others in KEEPERS, kernel/gateway/records.js) are open only to that module and to owners and admins. A team member's calls reach the team's server through `records.serve`, `records.serve-create` and `records.serve-update`, which refuse any other caller and strip keys a member may not send.

**Forget.** `records.forget` destroys a record, its history and its sealed values. It needs presence, so only a person runs it; an agent proposes with `records.forget.propose`, which makes a task for the person.

**Events.** records.merged is logged when two contacts are joined. Reads of the log go through `records.events`.

## Where the code lives
- `core/records-tools/` the module: one tool per Store call, member door, dev seed.
- `kernel/gateway/records.js` the record calls, actions, KEEPERS; `kernel/gateway/links.js` links and inverses; `kernel/gateway/sealing.js` seal calls.
- `kernel/contracts/fields.d.ts` field kinds and type definitions.
- `kernel/core/fields.js` the `{{field:...}}` placeholder resolver.
- `lib/sealed.js`, `lib/record-types.js`, `lib/record-cards.js` model view of sealed values, system types, context cards.
- `records/` core types, language (`records/language`), Kits (`records/kits`), connectors, comms log.
- `core/switchboard/record-tags.js` the `#` tag in the composer.
- `apps/app/screens/records/` Records screen, import sheet, views, export; `apps/app/screens/customize/` Objects and fields; `apps/app/ui/setup/fieldtokens.js` field tokens.

## How agents use it
Models call `records.list`, `records.get`, `records.create`, `records.update`, `records.linked`, `records.reference` and the read tools, as the person they work for, within that person's grants. Sealed values never reach them. `records.reveal`, `records.seal-put` and `records.forget` are the person's own acts; an agent proposes a forget instead. `records.define` changes types and the kernel decides who may. See agent doc "records" and sealed-and-secrets (agent doc "sealed-and-secrets").

## Limits today
- A member can read every row of a type the Space defined itself, even one linked to a project the member is not on. Per-record privacy for custom types is planned for 0.5.1. Keep sensitive rows in a built-in type.
- CSV export is a web feature; a phone does not offer it yet.
- Import in the app only adds rows; it offers Skip it or Add anyway for repeats, not Update it.

## Related
- [documents-and-signing](./documents-and-signing.md), [files](./files.md), [flows](./flows.md), [tasks-and-needs-you](./tasks-and-needs-you.md), [kernel](./kernel.md), [gate](./gate.md), [vault](./vault.md)
- [map](../map.md), [overview](../overview.md)
- agent doc "records", [docs/reference/tools.md](../../reference/tools.md), [docs/known-gaps.md](../../known-gaps.md)
