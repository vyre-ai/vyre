# records-2

Branch: work/records-contacts (off work/records 2174df808) · Worktree: ../vyre-records-contacts · Owner session: records-2

Scope: the contacts block of team/0.3/DESIGN-contacts-comms.md that sits on the records layer: core people types on both stores, the Kit-extends-core merge, the role marker and its two queries, the link index, communication to contact many to many, participant matching, and the conformance cases for all of it. NOT mine (records keeps them): the daemon proof, real-Twenty runs, key rotation, the worker-off measurement, soft remove of a field, sealing an existing field, hidden_from, computed, the `links` kind, group-by and merge. The "Log communications" Flow is the sessions team's.

## Done

- Contract commit (only kernel/contracts/fields.d.ts and store.d.ts): `TypeDefinition.role`, `FieldDefinition.to` as a list, `FieldDefinition.normal`, `describe().indexed`. Asks (a), (g), (h).
- `records/contacts/types.js`: contact (`full_name` first, so the Estate kit's contact merges as it is), organization, contact-point, communication, communication-party. Added to `CORE_TYPES`.
- `kernel/store/normal.js` and `values.js`: the normal form of an address and the `normal` and link `to` checks, shared by every store.
- `kernel/store/memory.js` (and so the SQLite store): a lookup index on every link and unique field, used by `eq` and `in` (alone or inside a top-level `and`); `describe().indexed`; `rowsExamined()` for the proof.
- `records/contacts/merge.js`: `extendType`, `mergeKitTypes`; wired into `host.installKit` and into the language's `checkKit`.
- `records/contacts/roles.js`: `roleLinkField`, `checkRoleType`, `roleTypes`, `rolesOf`, `holders`. The SDK takes `role` on `defineType` and a list for a link's `to`.
- `records/contacts/points.js`: `addPoint`, `findPoint`, `matchParticipants`. `records/contacts/comms.js`: `attachContact`, `communicationsOf`, `contactsOf`, `findBySource`.
- Cases: `records/contacts/suite.js`, run by `records/contacts/contacts.test.js` (SQLite, memory) and `stores/twenty/contacts.test.js` (Twenty over its fake).

## Doing

- Reporting to records and the lead.

## Next

- Rebase or merge on records' head when it moves; re-run the suite on testbox before records merges.
- The host's `contacts` object is `host.contacts`; platform's assembly builds the same with `createContacts({ space, records: kernel.gateway.records, types })` and calls `mergeKitTypes` where it installs a Kit.

## Needs from others

- platform: cherry-pick or redo the contract commit (asks a, g, h) in team/0.2/CHAT.md. Until then the types in the store carry `role`, `normal` and list `to` that the contract does not name yet.
- records: the Twenty link index. Twenty has no metadata call that adds a plain index (I found none and did not run against a real Twenty), so on Twenty `describe().indexed` is true only for unique fields (a Postgres unique index) and a link filter is pushed down to Postgres. If a plain index is added in provisioning, flip `indexed` for link fields in `stores/twenty/store.js` describe and the suite needs no change.
- records: a real-Twenty run of stores/twenty/contacts.test.js. Names I chose that real Twenty might refuse: `is_primary`, `is_verified`, `value`, `kind`, `direction`, `source`, `thread`, `about`, `key`, `communication`, `contact`.
- platform (finding): a Twenty datetime survives the gateway's check of what the store returned only in `Date.toISOString()` form. The Twenty store now refuses any other form as `invalid`; the built-in store still accepts them. A contract rule that a datetime is written in that form on every store would make them agree.

## Changed contracts

- kernel/contracts/fields.d.ts, store.d.ts (the one labelled commit). Nothing in kernel/gateway.
