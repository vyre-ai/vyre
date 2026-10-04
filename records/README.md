# records: the language and the Kits

A firm describes its world in a small typed language. People edit it in the Deck, @Engineer writes it, and both produce the same stored form. A definition file is TypeScript against the Vyre SDK, but it is read, never run.

```ts
import { defineKit, defineType, defineField, defineStage, defineTask, defineTemplate, defineRole } from "@vyre/sdk";

export const Matter = defineType({
  name: "matter",
  fields: {
    title: defineField.text({ required: true }),
    client: defineField.ref({ to: "contact" }),
    ssn: defineField.sealed({ class: "us-ssn" }),
    stage: defineStage([
      { name: "Intake", tasks: [defineTask({ title: "Research the client", doer: "teammate:research", how: "assistant", output: { kind: "fields", target: ["practice_area"] } })] },
      "Drafting",
    ]),
  },
});
export default defineKit({ id: "demo", version: 1, includes: [Matter] });
```

- `language/parse.js`: a source-only parser. Imports of anything but the SDK, dynamic import, `require`, `export ... from`, directives, `${}` in a template, spread, arrow functions and every statement form except `const` and `export` are errors with a line number. Limits on size, depth, node count, string length and time; `parseSafely` runs it in a worker with a memory ceiling.
- `language/sdk.js`: the only functions a file may call. Field kinds are the kernel's (`kernel/contracts`): a link to another record is `ref`, a web address is `link`. What the SDK cannot say, the stored form cannot say.
- `language/compile.js`: text to the stored kit (JSON), then cross-checks (references resolve, expressions name real fields, sealed fields stay out of expressions, merge fields and task outputs). `validateStored` judges a stored kit that did not come from text.
- `language/print.js`: the stored kit back to canonical text. `compile(print(kit))` equals `kit`. Comments, layout and constant names are not kept; code that generates definitions has no text form.
- `language/expr.js`: the Expression language (rules, conditions). Parsed and evaluated here, never `eval`.
- Types in a stored kit are the kernel's `TypeDefinition`. Templates, roles, flows, views and code steps are kit-level definitions.
- `kits/estate-planning`: "Estate planning matter". `kit.ts` is the source, `kit.json` the stored form (regenerate with `node language/cli.js compile kits/estate-planning/kit.ts > kits/estate-planning/kit.json`).
- `connectors/stripe`: the Stripe connector (test mode). `flows/run.js`: the minimal flow runner it uses until the platform's step runner lands. `testing/gateway-lite.js`: a stand-in gateway for tests.

## Core types, roles and what is said to a contact

- `core-types.js`: `contact`, `organization`, `communication`, `participant`, `event`, `template`, `playbook`, `team-member`, defined in every Space. A Kit may add fields to a core type by naming it: the language stores the whole type, core fields first, and a different kind on a core field's name is an error.
- A person is one `contact`. Its main `email` and `phone` are unique in the Space (written lower case and E.164); other addresses go in `other_emails` and `other_phones` (lists, not unique, not searched by `findContact`). What a person is to the Space is a role: any type with `role: { link, ended? }` whose required `link` field points at a contact or organization. `records.roles(holder)` and `records.holders({ role, stage? })` answer the two questions; both are checked row by row for the caller.
- `comms/log.js`: `logCommunication` writes one `communication` per connector item (`source_key` unique) and a `participant` per person, matched to contacts by main email or phone; `timelineOf` lists what was said to a contact, newest first. Nothing there sends.
- `records.merge(keep, drop)` joins two contacts that are one person (fills gaps, joins lists, moves every link, one `records.merged` event) and `records.unmerge(merge_id)` undoes it.
- Field switches on any field: `unique`, `hidden` (removed softly, the data is kept), `hidden_from: [roles]`, `computed` (an Expression or a total over the records that link here). `kernel.migrate.sealField` seals a plain field that already has values and scrubs the old ones.
