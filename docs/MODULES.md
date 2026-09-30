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
  "apiVersion": 1,
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
| `apiVersion` | `1`. Required for a module you add. |
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

| Member | Use it to | Declare it in |
|---|---|---|
| `ctx.tool(name, { description, input, examples, run })` | register a tool. `run(input, meta)` returns JSON or throws `{ code, message }`. | `does.tools` |
| `ctx.call(tool, input)` | use another module's tool. It answers `{ data }` or `{ error }`. | `needs.tools` |
| `ctx.events.emit / on / since / latestId` | emit and follow events | `watches.emits`, `watches.on` |
| `ctx.store.db`, `ctx.store.migrate(steps)` | your own SQLite tables, with migrations that only go forward | |
| `ctx.paths.data` | your own folder, the one place you write files | |
| `ctx.settings.get / set / on` | your own settings | `settings` |
| `ctx.vault.request(id, { method, url, ... })` | call a vendor API with a credential you never see | `needs.credentials` |
| `ctx.connections.call(provider, tool, input)` | use a connected vendor MCP server (Google, Notion, Slack...) | `needs.connections` |
| `ctx.fetch(url, init)` | GET or HEAD from a public host, with no credentials and no body. To send data, use `ctx.vault.request` or an `outward` tool. | `needs.network` |
| `ctx.gate.request({ kind, via, to, content, why })` | propose a send through another module's sender | `needs.tools: ["gate.request"]` |
| `ctx.memory.write({ kind, project, text, subject?, source_ref? })` | write memory, shown with your module as its source and quoted as data | `teaches.memory` |
| `ctx.ask(prompt, { purpose, maxUsd })` | a one-shot model read with no tools, counted against your daily cap | `needs.spend` |
| `ctx.spend.record / check` | count your own paid API use | `needs.spend` |
| `ctx.push.offer({ title, body, kind })` | ask to notify the person. It answers `sent` or `deferred`, under one shared daily budget. | `shows.notices` |
| `ctx.undo.record({ tool, input, inverse })` | give an action you took an Undo | |
| `ctx.log.info / warn / error / debug` | logs, read with `vyre logs <module>` | |
| `ctx.api.version`, `ctx.api.has(feature)` | find newer features without breaking on older Vyre | |

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
(`modules.capabilities`) from the manifests. Every agent, whatever its provider, sees the new tools
on its next turn: the Vyre MCP server announces the change, and the assistant's list of what it can
do updates with it. An agent is only shown the tools it can actually use.

## Versions

API 1 is frozen for Vyre 0.x. New things arrive as optional keys and as ctx members you test with
`ctx.api.has`. A deprecated key or member keeps working for at least 90 days and two minor releases,
and `vyre doctor` names every module still using it. It is removed only with a new API major, and
Vyre loads the current major and the one before. Every release runs the conformance test on the
example modules and on frozen modules from earlier releases, so a release that would break yours
doesn't ship.

## What's built in only, for now

Session providers (`does.providers`), streams (`shows.streams`), raw HTTP routes and raw vault
values stay with Vyre's own modules in 0.2, because each needs a process, a socket or a secret that
the sandbox withholds. `vyre module check` says so if you use them.
