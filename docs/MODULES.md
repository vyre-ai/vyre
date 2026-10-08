---
title: Modules (API 1)
summary: The module contract v1 on one page. It covers what a module is, module.json, the ctx it gets, who may call each tool, how it reaches the world, how it is added, and the kit that checks it.
audience: builders, agents
owner: platform
status: stable
---

# Modules (API 1)

Everything in Vyre is a module: memory, the vault, GitHub, the Capsule's actions, and whatever you or
an agent add. This page is the contract a module is written against. The decisions and their reasons
are in [ADR 0047](adr/0047-module-contract-v1.md). If you're an AI agent writing a module, start with
the [agent brief](build/AGENT-BRIEF.md). A complete working module is at
[`examples/modules/bakery`](https://github.com/vyre-ai/vyre/tree/main/examples/modules/bakery).

## In one minute

```
vyre module new bakery        # a folder that already passes every check
# edit module.json and index.js
vyre module check             # the manifest and the code, against API 1
vyre module test              # the conformance test, then your own tests, in a temp home
vyre module add ./bakery      # one card, one tap, and it's on
```

A module is a folder with a `module.json`, an entry file that exports `default { start(ctx) }`, and
anything else it ships. It uses the rest of Vyre only through `ctx`. It never imports a Vyre file,
never opens a network connection or process of its own, and never reads another module's data.

A module you add runs on the server in a sandbox: its own user, no network of its own, and no raw
secrets. Every way out goes through `ctx`, so the floor and the Gate see all of it. Vyre's built in
modules run inside vyred and use the same contract.

## module.json

```json
{
  "$schema": "https://vyre.run/schema/module-1.json",
  "name": "bakery",
  "version": "0.1.0",
  "vyre": "1",
  "description": "Northwind Bakery's orders, the daily target and the flour order.",
  "roles": ["box"],
  "does": {
    "tools": [
      { "name": "bakery.orders", "summary": "list today's orders" },
      { "name": "bakery.target", "summary": "change the daily target", "reach": "asked" },
      { "name": "bakery.flour", "summary": "order flour from the supplier", "outward": "pay" }
    ],
    "commands": [{ "verb": "orders", "tool": "bakery.orders", "summary": "today's orders" }]
  },
  "watches": { "emits": ["bakery.order-added"] },
  "shows": { "deck": ["now:bakery.today"], "notices": ["target-reached"] },
  "settings": [{ "key": "bakery.target", "label": "Daily target", "type": "int", "default": 40,
                 "levels": ["account"], "apply": "live" }],
  "needs": {
    "credentials": [{ "id": "supplier", "kind": "api-credential", "provider": "flourco",
                      "purpose": "place flour orders" }],
    "network": ["api.flourco.example"],
    "spend": { "dailyUsd": 0.5 }
  },
  "teaches": { "memory": ["note"] }
}
```

The schema is [`packages/module-sdk/manifest.schema.json`](https://github.com/vyre-ai/vyre/blob/main/packages/module-sdk/manifest.schema.json).
Point `$schema` at it for editor help. `x-` keys are free for experiments.

| Key | What it says |
|---|---|
| `name` | lowercase letters, digits and dashes. It prefixes every tool, event, setting and table. |
| `version` | the module's own semver |
| `vyre` | the contract version it's written for: `"1"`, or `"1.2"` if it needs something added in 1.2. Required for a module you add. |
| `description` | one plain sentence, shown on the install card |
| `main` | the entry file, default `index.js` |
| `roles` | where it runs: `box` (the server, the default), `local` (a device's own node), `mac` or `windows` (`local` on that OS only; only the Mac has a local node in 0.2) |
| `requires` | modules that must run first: `["memory"]` or `{ "memory": ">=0.1.0" }` |
| `replaces` | its own name, to stand in for a built in module. A module you add can't replace any in 0.2. |
| `does.tools` | its tools, each `{ name, summary?, reach?, outward?, cost? }` |
| `does.commands` | CLI verbs: `vyre <module> <verb>` runs a tool |
| `does.watchers` | watcher preset files it ships, offered when someone asks for a watcher |
| `does.hooks` | harness points (`brief`, `enrich`, `pretool`, `stop`), each served by one of its tools |
| `watches.emits`, `watches.on` | the events it may emit and the patterns it may listen to |
| `shows.deck` | slots in the Vyre app on the web, Windows and the phone: `now:<tool>`, `renderer:<tool>`, `slash:<name>`, `settings`, `view:<name>`, `panel:<name>` |
| `shows.capsule` | results and actions in the Capsule on a Mac |
| `shows.notices` | the notice kinds it raises |
| `settings` | its settings, drawn in Settings and `vyre config` with no UI work |
| `needs.*` | what it asks for (next section). This is what the install card shows. |
| `teaches.memory`, `teaches.prompt`, `teaches.tips` | memory kinds it writes, prompt layers, tips |

## Who may call a tool: `reach`

The person and their agents can do the same things. `reach` says when an agent needs the person to
have asked.

| `reach` | You, on your own screen | Your agents (any provider, teammates, the assistant) | Other modules |
|---|---|---|---|
| `anyone` | yes | yes | yes, if they list it in `needs.tools` |
| `asked` | yes | only when your own words asked for it | no |
| `modules` | hidden | hidden | Vyre's own modules only |
| `hook` | webhook only | no | no |

Say `reach` on every tool. A module you add can only call tools that declared theirs.

`person` exists for Vyre's own short list (answering a session's question, discarding a held draft).
A module you add can't use it: pick `asked`. An agent that calls an `asked` tool unasked gets
`not_asked`, tells you what it would do, and your reply is the ask. Nobody is prompted.

A module never asks for Touch ID. Vyre asks for it only when pairing a device, revealing a vault
secret, or sending something you didn't ask for.

An asked tool of Vyre's own may carry `target`, the name of one internal tool of the same module that answers
`{ to: [...] }`: what this one call acts on, each entry a key of the tool and the thing (a pull request, a recipient).
That answer is what your yes is matched against, so it binds that thing and not the whole tool, so "merge it" about one pull request never lets an agent merge another.

A tool that takes a project names the input field in `projectArg` (a name, or a list of names). The registry then
refuses an agent's call for a project the agent is not granted, with `not_found` (so a refusal never says whether the
project exists), before the tool runs, for every module alike. It asks `projects.reach`, so the owner's revokes count.
`cwdArg` does the same for a folder: it is mapped to its project, and a folder in no project is refused for an agent with an explicit project list. A named project is rewritten to the canonical slug that was authorized.
The tool also gets `meta.reach`, `{ all: true }` or `{ all: false, projects: [slug] }`, to keep a listing inside the
grant when no project is named.

## Acting as you outside: `outward`

Mark a tool `"outward": "send" | "post" | "pay" | "delete"` when it reaches the world as you: an
email, a message, a payment, a remote delete. Vyre routes every call:

- You asked in your own words (a command you typed, or a chat ask): it runs.
- You tapped a button your module drew: Vyre shows its own card with the real amount and
  destination, and your tap on that card runs it. A module's button never pays by itself.
- An agent, a teammate, a watcher or another module called it: if your own words asked for exactly
  this ("order the flour when stock is low"), it runs. Otherwise it waits at the Gate as a card, and
  you approve it with Touch ID.

Your tool's `run` only ever sees an approved call, and `meta.gate` says how it was cleared. A module
you add has no other way to act as you, because it never holds your credentials: `ctx.vault.request`
attaches them outside the sandbox, and a write through it is held at the Gate the same way.

## What a module adds to Flows: `flow`

A module extends Flows with one declaration, `flow`, beside `does` and `watches`. Nothing else makes a tool a Flow step.

```json
"flow": {
  "steps": [
    { "name": "mail.send", "label": "Send an email", "inputs": { "to": "string", "subject": "string", "body": "string" }, "outputs": { "id": "string" }, "outward": true },
    { "name": "mail.find", "label": "Find an email", "inputs": { "query": "string" }, "outputs": { "count": "number" } }
  ],
  "triggers": [
    { "name": "mail.arrived", "label": "An email arrives", "event": "mail.received", "inputs": { "from": "string", "subject": "string" } }
  ]
}
```

A **step** is one of the module's own tools (object form, reach anyone). A Flow's `call` step runs it. An outward step must name an outward tool (`"outward": true` on both), so the Flow holds it for the person's yes exactly as it holds any act that leaves Vyre. `inputs` and `outputs` are field names with a type (`string`, `number`, `boolean`, `object`, `array`) for the Flow editor.
A **trigger** is a named way to start a Flow: an event the module lists in `watches.emits`, or a watcher it hosts. A Flow stores an `event` or `watcher` trigger, the kinds that already exist; the module's name for it only helps the person find it.
Added modules may declare both. The install card shows them.

The Flow runs the tool as the person whose Flow it is: the daemon calls it with that person's session, so `ctx.kernel.chain(meta)` is that person.
The runner does not ask the kernel's action table about a Flow step, so **the tool must gate itself on the person's chain**: read the chain, check the person may read or do this, and refuse
otherwise. For an outward tool the Flow's one approval is spent at the call (once, for exactly that input), and that is the only gate beside the tool's own. For a read tool nothing else gates it.
Every flow step is listed with the guard it relies on in `test/flow-step-guards.json`; a tool with no line there, or a line that names no guard, fails the test, so a tool with no gate of its own does not pass review.
A connection to an outside service is not declared here: a Flow runs it with the one "Call a service" step.

## A module ships a Kit: records, fields and a link to projects

A module that keeps records of its own lists the Kit files it ships in its manifest: `"does": { "kits": ["kit.json"] }`. The file is a Kit in the records language's stored form (write `kit.ts` and compile it with `node records/language/cli.js compile kit.ts > kit.json`) or in the kernel's form. When someone adds the module (`vyre module add`), Vyre proposes each Kit file as a card in Now. Nothing is defined until the owner says yes, and the card lists every type and field.

A module's Kit is held to what a module may add. Its id is the module's name. Every record type is named for the module (`tasker_item` for the module `tasker`), so it cannot redefine a core type or another Kit's. It adds no roles and no teammates, because those are abilities and the person gives abilities, and it makes no project type. List the types in `needs.kernel.records` so the module's code may create and list them, as the person who installed it.

To relate an item to a project, give the type a link to `project`:

```ts
project: defineField.link({ to: "project", label: "Project", inverse: { name: "tasker_items", label: "Items" } }),
```

The item then shows on the project (`records.linked` on the project lists it), and a Flow can start from it like any record.

**An upgrade keeps everything.** A new version of the module and a new version of its Kit replace the old ones. The module's own tables migrate forward with `ctx.store.migrate`, the Space's records stay as they were and keep their links, and the update card says which types changed and what was removed. Keep the tool names, view names and field names a person has pinned or used in a Flow: removing one hides what depends on it. `test/module-kit-upgrade-daemon.test.js` installs a module, makes records linked to a project, upgrades the module and its Kit, and checks all of it is still there.

## What a module gets: `ctx`

Every member that reaches outside the module returns a promise. Types are in
[`packages/module-sdk/index.d.ts`](https://github.com/vyre-ai/vyre/blob/main/packages/module-sdk/index.d.ts).

| Member | Use it to | Declare it in | Available |
|---|---|---|---|
| `ctx.tool(name, { description, input, examples, run })` | register a tool. `run(input, meta)` returns JSON or throws `{ code, message }`. | `does.tools` | now |
| `ctx.call(tool, input)` | use another module's tool. It answers `{ data }` or `{ error }`. | `needs.tools` | now |
| `ctx.events.emit / on / since / latestId` | emit and follow events | `watches.emits`, `watches.on` | now |
| `ctx.store.db`, `ctx.store.migrate(steps)` | your own SQLite tables, with migrations that only go forward | | now |
| `ctx.paths.data` | your own folder, the one place you write files | | now |
| `ctx.settings.get / set / on` | your own settings | `settings` | now |
| `ctx.vault.request(id, { method, url, ... })` | call a vendor API with a credential you never see | `needs.credentials` | when vault.request lands |
| `ctx.connections.call(provider, tool, input)` | use a connected vendor MCP server (Google, Notion, Slack...) | `needs.connections` | now |
| `ctx.fetch(url, init)` | GET or HEAD from a public host, with no credentials and no body. To send data, use `ctx.vault.request` or an `outward` tool. | `needs.network` | when the module host lands |
| `ctx.gate.request({ kind, via, to, content, why })` | propose a send through another module's sender | `needs.tools: ["gate.request"]` | now |
| `ctx.memory.write({ kind, project, text, subject?, source_ref? })` | write memory, shown with your module as its source and quoted as data | `teaches.memory` | when memory.write lands |
| `ctx.ask(prompt, { purpose, maxUsd })` | a one-shot model read with no tools, counted against your daily cap | `needs.spend` | when spend.check lands |
| `ctx.spend.record / check` | count your own paid API use | `needs.spend` | when spend.record lands |
| `ctx.push.offer({ title, body, kind })` | ask to notify the person. It answers `sent` or `deferred`, under one shared daily budget. | `shows.notices` | when push.offer lands |
| `ctx.undo.record({ tool, input, inverse })` | give an action you took an Undo | | when undo.record lands |
| `ctx.log.info / warn / error / debug` | logs, read with `vyre logs <module>` | | now |
| `ctx.api.version`, `ctx.api.has(feature)` | find newer features without breaking on older Vyre | | now |

A call without its declaration throws `undeclared`.

## Relaying a call: who you act for

When your tool calls another tool with `ctx.call`, Vyre records who the call you are handling came from and passes it on as the call's `origin`. You never set it and you cannot forget it: a client cannot send one, and a module cannot overwrite it. So a module that relays a model's call is judged as acting for that model on every tool that cares (`originClass(meta)`, `wantsMacs`, a person-only tool a module reaches only on a person's behalf). The one thing to know is that the origin lives only while your call is running. Work you start for later (a timer, an event you store, a job queue) has no running call and is your own, as if you had made the call yourself. If it should act for the caller, keep `ctx.origin()` next to the stored work and replay it with `ctx.withOrigin(origin, fn)`. `test/module-origin.test.js` shows both.

## House rules

- `start` returns within 2 seconds and returns `{ stop() }`. `stop` finishes within 5 seconds.
- Nothing polls faster than once a minute. Listen to events instead.
- Every tool has an input schema and at least one `examples` entry.
- Errors carry a short lowercase `code`. Words people see are plain, with no em dash.
- Nothing is shown that doesn't work: a slot whose tool fails is hidden.

## Adding, updating and removing

`vyre module add <folder | git URL>` (or asking an agent to add it) checks the module and shows one
card, built by Vyre from the manifest rather than the module's own words:

```
Northwind bakery  0.1.0   from github.com/alex/bakery
Does:   list today's orders · change the daily target (when you ask)
Acts as you:  order flour from the supplier (pay), held unless you asked
Talks to:     api.flourco.example (reads only)
Uses:  your flourco key · memory (writes notes) · up to $0.50 a day
Shows: a Now card · `vyre bakery orders`
Runs: on your server, sandboxed
[Turn on]   [Not now]
```

One tap turns it on. If an agent thought of it on its own, the card waits in your list instead.
Updates run when you ask (or type `vyre module update`). Say "keep bakery updated" once and it updates itself for as long as it asks for nothing new. An update that asks
for nothing new installs with no card, and its row says when the code changed. One that asks for
more shows the card again with only what changed. A module may carry an optional signature: the card names who signed it, and a
later update from a different signer shows the card again.

`vyre module list`, `update`, `disable`, `enable` and `remove` do what they say. `remove` keeps the
module's data unless you pass `--data`.

## Every agent knows it at once

When a module is added, turned on, updated or removed, Vyre rebuilds the capability manifest
(`modules.capabilities`) from the manifests. <!-- terms: ignore --> Every agent, whatever its provider, sees the new tools
on its next turn: the Vyre MCP server announces the change, and the assistant's list of what it can
do updates with it. An agent is only shown the tools it can actually use.

## Versions

Your module keeps working when Vyre updates. The rules:

- **You name the contract.** `"vyre": "1"` in module.json.
- **Inside a major, nothing breaks.** New keys and ctx members are optional. Nothing is removed,
  renamed or retyped. Unknown keys are ignored when a module loads, and `vyre module check` shows
  them as warnings. Use `ctx.api.has("<feature>")` for anything newer than your `vyre` version.
- **Deprecation warns, never fails.** A deprecated key or member keeps working for at least two
  releases or six months, whichever is longer. Until then, `vyre module test`, `vyre doctor` and the
  log warn about it, and nothing fails.
- **A new major keeps yours running.** Vyre 2 will run `"vyre": "1"` modules unchanged through an
  adapter for at least 12 months. `vyre module upgrade` rewrites a module for the new major and
  tests it. It already exists and moves older manifests to today's shape.
- **Every release tests old modules.** Pinned modules for every contract version and every example
  run against every supported version in CI, and a release that breaks one doesn't ship.
- **Too new for this Vyre?** You get a plain message, "bakery needs a newer Vyre (module contract
  1.2); this Vyre has 1.0", and nothing crashes.

## What's built in only, for now

Session providers (`does.providers`), streams (`shows.streams`), raw HTTP routes, raw vault
values and the `#` picker's kinds (`mentions`) stay with Vyre's own modules in 0.2, because each needs a process, a socket or a secret that
the sandbox withholds. `vyre module check` says so if you use them.

## The `#` tag: `mentions`

Typing `#` in a chat opens one picker over everything the person may mention. A built in module
offers a kind of thing with one entry in `mentions`, and `mentions.search` asks every module that
does at once.

```json
"mentions": [{ "kind": "vault", "label": "Vault", "icon": "key", "search": "vault.mentions.search", "resolve": "vault.mentions.resolve" }]
```

`search` and `resolve` are tools of the same module. Search takes `{ q, limit }` and answers
`{ items: [{ id, name, hint?, icon? }] }`: names only, never a value, and it runs as the person who
is typing. Resolve takes `{ id, thread, said }`, runs as sessions or the assistant (never a model), and answers what the tag means for a thread: a `grant` (a use, a
read) and a `context` (a title, a summary), decided from the person's own turn and never from a
model. A kind has one provider; a second module that claims it fails to load.

## Views: your screens, drawn by Vyre

A module describes its screens under `views` and Vyre draws them, in the app (web, Mac, Windows, phone) and in the Capsule, in its own components. Nothing from a module runs in Vyre's window. This is the
Capsule's view language below, promoted to the whole app and extended with a board and a summary; `shows.capsule`'s `view:<id>` entries are the older name for the same declaration, and `views` wins when both name an id.

```json
"views": {
  "board": { "title": "Board", "icon": "tray",
    "board": { "tool": "cards.list", "columns": [{ "id": "todo", "title": "To do" }, "doing", "done"],
      "map": { "rows": "cards", "id": "id", "title": "name", "subtitle": "who", "column": "status" },
      "actions": [{ "id": "move", "title": "Move", "tool": "cards.move", "input": { "id": "{id}", "status": "{column}" } }] } },
  "counts": { "title": "Counts", "summary": { "tool": "cards.count",
    "map": { "cards": [{ "label": "Open", "path": "open" }], "chart": { "kind": "bar", "rows": "byDay", "label": "day", "value": "n" } } } }
}
```

A view is a `list` (with a `detail` and `actions`), a `board`, a `summary` or a `form`. A board groups the rows of its tool into the declared columns by the field `map.column` names; a row whose value is no
declared column goes to a last column, Other. Dropping a card on a column calls the action with the id `move`, with `{column}` filled in (only a declared column; any other leaves the card where it is). A summary reads
counts and one small bar or line chart by dotted path. `map` names fields by plain dotted path, templates fill a fixed set of names, an `outward` action shows its exact words first and sends only with the
preview's own token, and the module's tools run as the module on behalf of the person who opened the view, never as the person. The app asks `views.list`, `views.get` and `views.act`; the Capsule asks
`capsule.commands`, `capsule.view` and `capsule.act`, and shows only the views it can draw (list, detail, form).

A view is also a sidebar screen: the entry is `{ "kind": "module", "module": "cards", "screen": "board" }` with the view's id as `screen`, and `sidebar.get` marks it `view: true`. A view id a new version drops hides
the pin; it never deletes it.

## The Capsule: `view:` entries

A module adds commands to the Capsule by declaring them under `shows.capsule`. The Capsule draws
them natively; nothing from a module runs inside it.

```json
"shows": { "capsule": {
  "view:orders": {
    "title": "Orders", "keywords": ["bakery"], "icon": "tray", "root": true,
    "arg": { "name": "q", "placeholder": "customer" },
    "list": {
      "tool": "bakery.orders", "input": { "q": "{q}", "limit": 20 },
      "map": { "rows": "orders", "id": "ref", "title": "name", "subtitle": "note", "url": "link" },
      "actions": [
        { "id": "open", "title": "Open", "do": { "open": "{url}" } },
        { "id": "reply", "title": "Reply", "form": "reply" }
      ]
    },
    "forms": { "reply": { "title": "Reply to {title}", "fields": [{ "name": "body", "label": "Your reply", "type": "multiline", "required": true }],
      "submit": { "title": "Send", "tool": "bakery.reply", "input": { "ref": "{id}", "body": "{body}" }, "outward": true } } }
  }
} }
```

A view is a `list` (with an optional `detail` and its `actions`) or a `form`. `map` names fields in the
tool's JSON by plain dotted path: no expressions, no code. Templates fill `{q}`, `{id}`, `{title}`,
`{subtitle}`, `{accessory}`, `{url}`, a form's field names, and `{front.app}` and `{front.selection}` only
when the module declares `needs.slots: ["front"]`; any other name is empty. An action ends in `do`
(`open`, `copy`, `say`, `ask` or `push`), a `tool` of the module's own, or a `form`. An added module opens
only https and mailto links (a `vyre:` link can act, so it is Vyre's own), pushes only to its own commands,
and may name only its own tools and the ones in `needs.tools`. Its
tools run as the module, never as you, and its rows say "from" the module. An `outward` action shows the
exact words first, and a second Enter sends; the preview carries a token good for two minutes that the
second call must return. Icons are system symbol names from a fixed list, or
`app:<bundle id>`.

The Capsule reads `capsule.commands` for the list of commands, `capsule.view` for a frame and
`capsule.act` for an action. It sends ids, never tool names. The older `results:<tool>` and
`action:<tool>` keys keep working and appear as one command.
