---
title: Records
summary: The typed rows a Space keeps (contacts, projects, tasks, anything it defines), with fields, links, sealed values, views and CSV or Excel import and export.
audience: builders, agents
owner: docs
status: stable
---

# Records

## What it is
A record is one row of a type a Space defines: a contact, a project, a task, a note. The type says which fields it has, how they link to other records and how they are shown.
The kernel keeps the rows and judges every read and write. The `records` module (core/records-tools) is the app's way in, one tool per call.

## What a person sees
- **Records** screen (`/u/records/<type>`): the rows of one type as a **List**, **Board**, **Calendar** or **Dashboard**, with a search box, filter chips, **New view**, **Pin to sidebar**, **Import** and, on the web, **Export CSV**. A phone has no CSV export in 0.5.
- A **record page** shows fields in their groups, **Add a field**, the records linked to it, a timeline and, when Documents has templates, **Make document** and **Send for signature** (see [documents-and-signing](./documents-and-signing.md)).
- **Customize** (Settings, page title **Objects**, "Objects, fields and groups"): **Add a type**, **Add a field**, groups, stages. A Space adds as many types as its business needs and joins them with Link fields. Field kinds on offer are Text, Number, Money, Date, Choice, Stage, Person or agent, Link, File, Address, Phone, Email, Rich text, Rating and Sealed.
- An object page has **Copy all as a list**, which copies each field with its template token such as `{contact.name}`. A Link field has no token of its own. It shows the nested form `{object.link.field}`, so a matter can print its client's phone as `{matter.client.phone}`. A token reaches up to three links deep (`insertList` in apps/app/ui/flows/template.js), and a link to several records reads as their names joined by commas. Flows and Documents use the same tokens.
- **Import** takes a CSV or an `.xlsx` file (a sheet picker when there is more than one) or pasted rows, matches columns to fields, checks every row, and adds rows one by one through the same create a form uses. A row that matches an existing record is skipped or added anyway, as the person picks.
- A sealed field shows a placeholder, never the value. Revealing it is a separate act on the person's own screen.
- In the chat composer, `#` puts a record, a whole object (`type/<object>`) or a template's projects in front of the AI.

## How it works
**Data.** Types are `TypeDefinition` rows: `fields`, `stages`, `stage_sets`, `views`, `rules`, `groups`, and `role` for types such as a prospect or client that point at a contact or organization (kernel/contracts/fields.d.ts). Every Space has the core types in records/core-types.js (`contact`, `organization`, `contact_point`, `communication`, `task`, `project`, `event`, `template`, `playbook`, `team-member`, `skill`, `chat-record`, `file-share`, `project-template`). A Kit (records/kits: `base`, `law-firm`, `estate-planning`) adds more, and a person adds their own in Customize.

**Fields.** Kinds are text, rich_text, number, money, boolean, date, datetime, choice, multi_choice, rating, url, link, actor, file, address, phones, emails, urls, stage and sealed. Switches on any field: `required`, `unique`, `hidden` (data kept), `hidden_from` (roles that never see it), `visible_if`, `required_if`, `computed` (an expression, or a total over records that link here), `group`.

**Links.** A `link` field with `to` points at one record type. `many` makes it a list, and the gateway adds a named inverse field on the target (kernel/gateway/links.js). Links chain: a task links to a matter, the matter to a client, the client to an organization. `records.linked` lists what points at a record. `records.roles` and `records.holders` answer what a contact is to the Space and who holds a role. A computed field can total the records that link here, such as the fees of every matter of a client.

**Views.** A type stores its own views (`ViewDef`): a `name`, a `type` of list, board, calendar, page or dashboard, then `columns`, `groupBy` (a board groups by a choice or stage field), `dateField` (a calendar), a `filter` expression and a `sort`. The app reads them, and its own table only fills in for a type that has none.

**Stages and stage sets.** A type's `stages` are its default stages. A `stage_sets` entry is `{ name, when, stages }`: while the expression `when` holds for a record, the record follows that set. The first set that holds wins, and the type's `stages` apply when none does (`stagesFor` in lib/expr/conditions.js, used by kernel/flows/stages.js). One type can therefore carry a personal-injury track and an estate-planning track, chosen by a field on each record. The stage field's options are every stage name across the sets.

**Sealed fields.** A sealed field holds a reference, not the value. `records.seal-put` sends the value to the sealing process and the record keeps only the reference. `records.reveal` shows it once on the person's screen and needs fresh presence, and the chain must be one person. A model sees `{ sealed, present, valid_format }` only (lib/sealed.js). `records.reference` renders a record for the AI with sealed parts as `{{field:<urn>#<name>}}`. The kernel resolves such a token only inside an outward tool call, under the asking person's chain, and holds the call for approval (kernel/core/fields.js).

**Tools** (core/records-tools/module.json): `records.types`, `records.define`, `records.list`, `records.get`, `records.create`, `records.update`, `records.reference`, `records.linked`, `records.roles`, `records.holders`, `records.events`, `records.sees-as`, `records.seal-put`, `records.reveal`, `records.forget`, `records.forget.propose`, `records.kits.library`, `records.kits.get`, `records.me`, `records.actors`. An update carries `base_version`, and a stale one is refused as `version_conflict`. A list can include the Bin (`include_deleted`). The kernel's own bookkeeping types (Flows, Kits, goals, previews) stay out of `records.types` unless `system: true` is asked for (lib/record-types.js).

**Checks on every call.** The tool opens a door (lib/gateway-door.js) that builds the caller's own chain in the Space the call names. The kernel then checks the action (records.read, `records.create`, `records.update`, records.remove, records.restore, `records.define`, events.read), the role, `hidden_from`, sealed fields and rules. Types a module keeps (`skill`, `chat-record`, `goal` and others in KEEPERS, kernel/gateway/records.js) are open only to that module and to owners and admins. A team member's calls reach the team's server through `records.serve`, `records.serve-create` and `records.serve-update`, which refuse any other caller and strip keys a member may not send.

**Forget.** `records.forget` destroys a record, its history and its sealed values. It needs presence, so only a person runs it. An agent proposes with `records.forget.propose`, which makes a task for the person.

**Events.** records.merged is logged when two contacts are joined. Reads of the log go through `records.events`.

## Where the code lives
- `core/records-tools/` the module: one tool per Store call, member door, dev seed.
- `kernel/gateway/records.js` the record calls, actions, KEEPERS. `kernel/gateway/links.js` links and inverses. `kernel/gateway/sealing.js` seal calls.
- `kernel/contracts/fields.d.ts` field kinds, `ViewDef`, `StageSetDef` and type definitions.
- `kernel/core/fields.js` the `{{field:...}}` placeholder resolver.
- `lib/sealed.js`, `lib/record-types.js`, `lib/record-cards.js` model view of sealed values, system types, context cards.
- `records/` core types, language (`records/language`), Kits (`records/kits`), connectors, comms log.
- `core/switchboard/record-tags.js` the `#` tag in the composer.
- `apps/app/screens/records/` Records screen, import sheet, views, export. `apps/app/screens/customize/` Objects and fields. `apps/app/ui/setup/fieldtokens.js` field tokens, and `apps/app/ui/flows/template.js` the list they come from.

## How agents use it
Models call `records.list`, `records.get`, `records.create`, `records.update`, `records.linked`, `records.reference` and the read tools, as the person they work for, within that person's grants. Sealed values never reach them. `records.reveal`, `records.seal-put` and `records.forget` are the person's own acts, and an agent proposes a forget instead. `records.define` changes types, and the kernel decides who may. See agent doc "records" and sealed-and-secrets (agent doc "sealed-and-secrets").

## Limits and extension points
- In 0.5, a member can read every row of a type the Space defined itself, even one linked to a project the member is not on. 0.6 plans per-record privacy for custom types, write-once fields and totals (R051-06 and R051-07 in the [roadmap](../../roadmap.md)). Until then, keep sensitive rows in a built-in type.
- CSV export runs in the web app. Import adds rows, and a repeat is skipped or added anyway, not updated.
- For behavior a type cannot hold, such as a nightly rollup, a check against an outside list or a new tool on its records, build a custom module. It passes through the same grants and checks as any other. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related
- [documents-and-signing](./documents-and-signing.md), [files](./files.md), [flows](./flows.md), [tasks-and-needs-you](./tasks-and-needs-you.md), [kernel](./kernel.md), [gate](./gate.md), [vault](./vault.md)
- [map](../map.md), [overview](../overview.md)
- agent doc "records", [docs/reference/tools.md](../../reference/tools.md), [docs/known-gaps.md](../../known-gaps.md)
