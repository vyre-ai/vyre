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
| `shows.deck` | slots in the web app on the Deck, Windows and the phone: `now:<tool>`, `renderer:<tool>`, `slash:<name>`, `settings`, `view:<name>`, `panel:<name>` |
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
