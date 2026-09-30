---
title: "ADR 0047: The module contract v1"
summary: The frozen module API 1 for Vyre 0.2. It covers module.json with per-tool reach and outward marks, the ctx a module gets, the capability manifest every agent reads, added modules running in a sandboxed host, the install card, and the kit that lets an agent write a module that works the first time.
audience: builders, agents
owner: platform
status: proposed
---

# ADR 0047: The module contract v1

Status: proposed, 30 Sep 2026 · Workstream: platform · Finalizes [ADR 0033](0033-hackable-vyre.md)
section 1 and section 5 for Vyre 0.2. Binds to the 0.2 charter's rules (security without friction,
asking is approving, agents can do everything the person can) and PLAN.md's contracts P5, P8, P14,
P17, P20 and C25.

## Context

The person's ask (30 Sep): "finalize that module contract thing so I can have other agents start
writing modules that can be seamlessly integrated."

ADR 0033 set the direction: one manifest schema, an API version, a ctx surface and a kit. Some of it
is on main: `packages/module-sdk` (schema, checker, types) and `vyre module new/check/add`. The rest
is still marked planned. Four gaps stop an outside agent today:

1. **The manifest doesn't say who may call a tool.** The loader's `callers`, `internal` and the
   floor's `PERSON_ONLY` set live in code. A module can't be previewed before it runs, and the
   assistant's tool map lies (plans/assistant.md 1: tools that say "any caller" refuse inside).
2. **Nothing marks a tool that acts as the person outside.** The Gate only catches sends it
   recognises by name (P7 found `merge_pull_request` and eight others missing).
3. **A module added from outside runs inside vyred**, where `node:fs` and `node:child_process` step
   around every ctx check. ADR 0033 said so and deferred the fix. The 0.2 charter doesn't allow
   that: an added module can't be allowed to bypass the Gate or the floor.
4. **0.2 adds shared paths every module needs:** memory writes through iq (P8), spend through
   `core/spend`, push through `core/push`'s one budget (W4), vault-routed API calls (P5) and the
   P17 provenance match. None of them has a ctx member yet.

## Decision

### 1. What a module is

A module is a folder: `module.json`, an entry file exporting `default { start(ctx) }`, and
anything else it ships. It talks to the rest of Vyre only through `ctx`. It never imports a Vyre
file, reads another module's data or opens its own network or process.

There are two kinds, set by where the folder lives, never by the manifest:

| Kind | Where | Runs | ctx |
|---|---|---|---|
| **Built in** | the repo's `core/`, `local/`, `modules/` | inside vyred | v1, plus members marked internal |
| **Added** | `<home>/modules/<name>/`, put there by `vyre module add` or `modules.add` | in the **module host**, a sandboxed child (section 5) | v1 only |

A module written against v1 runs the same way in either place. Every ctx member that crosses
into vyred returns a promise. The store is a local SQLite handle in both kinds, so nothing
depends on being in the same process.

### 2. module.json v1

The schema is `packages/module-sdk/manifest.schema.json`. Its `$id` becomes
`https://vyre.run/schema/module-1.json`. It is frozen for API 1: a new key only arrives through
the deprecation rules (section 8). `x-` keys are free.

```json
{
  "$schema": "https://vyre.run/schema/module-1.json",
  "name": "bakery",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "Northwind Bakery's orders, the daily target and the flour order.",
  "roles": ["box"],
  "requires": { "memory": ">=0.1.0" },
  "does": {
    "tools": [
      { "name": "bakery.orders", "summary": "list today's orders" },
      { "name": "bakery.add", "summary": "record an order" },
      { "name": "bakery.target", "summary": "change the daily target", "reach": "asked" },
      { "name": "bakery.flour", "summary": "order flour from the supplier", "outward": "pay" }
    ],
    "commands": [{ "verb": "orders", "tool": "bakery.orders", "summary": "today's orders" }],
    "watchers": ["watchers/big-order.json"]
  },
  "watches": { "emits": ["bakery.order-added"], "on": ["memory.written"] },
  "shows": { "deck": ["now:bakery.today"], "capsule": { "bakery.orders": { "title": "Orders" } } },
  "settings": [{ "key": "bakery.target", "label": "Daily target", "type": "int", "default": 40,
                 "levels": ["account"], "apply": "live" }],
  "needs": {
    "tools": ["memory.write", "push.offer"],
    "credentials": [{ "id": "supplier", "kind": "api-credential", "provider": "flourco",
                      "purpose": "place flour orders" }],
    "network": ["api.flourco.example"],
    "spend": { "dailyUsd": 0.5 }
  },
  "teaches": {
    "tips": [{ "id": "orders", "text": "Ask \"how many orders today?\" in any chat.",
               "surfaces": ["chat"], "level": "first-use", "trigger": "never-used", "since": "0.1.0" }]
  }
}
```

**Identity and placement**

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | `^[a-z][a-z0-9-]{1,40}$`. It prefixes every tool, event, setting and table. |
| `version` | yes | semver of the module itself |
| `apiVersion` | yes for added modules | the module API major, `1`. Built in modules get a grace default of 1. |
| `description` | added: yes | one plain sentence, shown on the install card |
| `main` | no | entry file, default `index.js`, inside the folder |
| `roles` | no | where it runs, default `["box"]` for added modules. `box` is the server, Linux or Mac. `local` is any device's local node. `mac` and `windows` narrow `local` to one OS. In 0.2 only the Mac has a local node (C1, C1w), so `windows` loads nowhere yet, and `vyre module check` says so. |
| `requires` | no | modules that must be running first: a list of names, or `{ name: range }` |
| `replaces` | no | its own name, to stand in for the built in module of that name (ADR 0033 section 3). An added module can never replace the floor list (section 6). |

**`does`: what it offers**

| Key | Meaning |
|---|---|
| `does.tools` | Its tools. Each is a string (built in grace form, `reach` defaults to `anyone`) or an object `{ name, summary?, reach?, outward?, cost? }`. Added modules must use the object form. |
| `does.commands` | CLI verbs `{ verb, tool, summary, args? }`: `vyre <module> <verb>` |
| `does.providers` | ACP session drivers (ADR 0030, P4). Built in only in 0.2, because a driver spawns processes and the host forbids that. |
| `does.watchers` | Watcher preset files the module ships (relative paths). The shape is watchers' own (plans/watchers.md 3.1c). The write-a-watcher skill offers them. A preset only describes, it never runs code of its own. |
| `does.hooks` | harness points `brief`, `enrich`, `pretool`, `stop`, each served by one of its tools. `pretool` only tightens. |
| `does.apps` | Capsule @App adapters, as tools |
| `does.connections`, `does.suggest` | the tools answering the connections list and suggest (ADR 0033) |

**Per-tool reach: who may call it** (the charter's "agents can do everything the person can")

| `reach` | The person on their own surface | An agent (any ACP provider, a teammate, the assistant) | Another module |
|---|---|---|---|
| `anyone` (default) | yes | yes | yes, if listed in its `needs.tools` |
| `asked` | yes | only when the person's own turn asked for it (P17 provenance), never on its own initiative | no |
| `person` | yes | no, and the agent is told to ask the person | no |
| `modules` | no (hidden) | no (hidden) | yes |
| `hook` | webhook route only | no | no |

- `asked` is the default choice for anything that changes settings, deletes local data or reshapes
  an agent. It asks the person nothing: the check is vyred's P17 match against the person's own
  words in their own turn (C25). A miss comes back as `{ error: { code: "not_asked" } }`. The
  agent then tells the person what it would do, and the person's reply is the ask.
- `person` is reserved. An added module may not use it (`vyre module check` refuses it with a line
  pointing at `asked`). The kernel keeps the floor's short list (`threads.answer`, `gate.revise`,
  `gate.reject` and the rest of `PERSON_ONLY`) as `person`.
- **Presence (Touch ID) is never a module's to declare.** It stays on C25's list only: pairing,
  revealing a vault secret, and a send, post or pay the person didn't ask for. `presence: true` on
  an added module's tool is refused. This is the charter's rule that anything adding a prompt is
  cut.

**`outward`: acting as the person outside.** `outward: "send" | "post" | "pay" | "delete"` marks a
tool that reaches the world as the person: an email, a message, a payment, a remote deletion. The
registry, not the module, routes every call to such a tool:

1. From the person's own surface (they tapped it), it runs. Their tap is the ask (C25), and the
   Gate log records it.
2. From anyone else (an agent, a teammate's duty, a watcher, another module), the registry files it
   at the Gate as `gate.request { kind, via: "<tool>", content: input }`. The Gate's P17 match
   runs it at once when the person's own words asked for exactly this, standing permissions
   included. Otherwise the caller gets `{ held: id }` and the person approves with Touch ID later.
3. The tool's `run` only ever executes after step 1 or an approved step 2. Its `meta.gate` says
   which. On approval the Gate calls it as `module:gate` with the approved content, which the
   person may have edited.

This replaces `does.senders` (ADR 0033): an outward tool is its own sender. `gate.offer` stays
for built in senders during one release.

An added module has no other way to act as the person (section 5): it never holds the person's
credentials. `cost: "paid"` marks a tool that spends money through the module's own model or
API use. The capability manifest shows it, and core/spend meters it (section 3).

**`watches`**: `emits` are the event types it may emit (`noun.past-verb`, prefixed by its own
name or a noun it owns). `on` holds the patterns it may subscribe to (a type, `noun.*` or `*`).
Both are enforced for added modules. Reserved families (`sync.*`, `gate.*`, `presence.*`,
`vault.*`, `turn.said`) can't be emitted by anyone but their owner.

**`shows`: UI slots.** Declarative first. A module supplies data and never styles.

| Key | Surface | Slots |
|---|---|---|
| `shows.deck` | the web app, which is the Deck, the Windows shell and the phone alike (PLAN 1) | `now:<tool>`, `renderer:<tool>`, `slash:<name>`, `settings`, `view:<name>`, `panel:<name>` (ADR 0033 section 2 and app-design's slot rules). The phone lays out the same slots in its Places sheet. |
| `shows.capsule` | the Capsule on a Mac | `{ "<tool>": { title, input?, hide? } }` results and actions |
| `shows.streams` | any | WebSocket streams, built in only in 0.2 |
| `shows.notices` | every surface | notice kinds it raises |
| CLI | the terminal | through `does.commands`, since `shows.cli` is deprecated |

`view` and `panel` from an added module are code. They load only in the sandboxed iframe at
`/m/<module>/` (ADR 0033 decision 3), and every call they make is `module:<name>`, never the
person.

**`settings`**: its keys in the hub's `Def` shape (ADR 0035), every key prefixed with its name.
Added modules keep values only in the hub's table or their own tools.

**`needs`: what it asks for.** This block is the install card (section 6).

| Key | Meaning | Enforced |
|---|---|---|
| `needs.tools` | tools it calls with `ctx.call` (`module.verb` or `module.*`) | yes, for added modules |
| `needs.credentials` | vault items by id, kind and purpose (ADR 0028). An added module uses them only through `ctx.vault.request`, never as raw values. | the grant decides |
| `needs.connections` | vendor-hosted MCP connections it reads through, `{ provider, purpose }`, with the hub's `{ projects, agents, modules }` grant (P5, P20) | yes |
| `needs.network` | public hosts `ctx.fetch` may reach without credentials | yes, in the host |
| `needs.spend` | `{ dailyUsd }`, its default daily cap on core/spend | yes |
| `needs.vault` | raw item names. Built in only in 0.2 (`per-<thing>` included). | yes |

**`teaches`**: `memory` (fact kinds it writes), `prompt` (prompt layers, listed and switchable in
the hub) and `tips`.

**There is no hand-written `capabilities` key.** A module's capabilities are computed from `does`,
`needs` and `shows`, so the install card and the capability manifest can't disagree with what the
loader enforces. A hand-written list could lie.

### 3. The ctx a module gets

`packages/module-sdk/index.d.ts` is the reference. Everything below is API 1. Members marked
*built in* are internal for added modules and absent in the host.

| Member | What it does | Goes through |
|---|---|---|
| `ctx.name`, `ctx.version` | identity | |
| `ctx.api.version`, `ctx.api.has(feature)` | `1`, and feature tests for additions inside the major | |
| `ctx.log.info/warn/error/debug(msg, extra?)` | module-prefixed logs, `vyre logs <module>` | |
| `ctx.tool(name, { description, input, output?, examples?, run })` | registers a declared tool. `run(input, meta)` returns JSON or throws an error with a `code`. `meta` holds `{ caller, who: "person"\|"agent"\|"module"\|"hook", agent?, thread?, project?, asked?, gate? }`, all set by vyred and never from input. | the registry |
| `ctx.call(tool, input)` | another module's tool: `{ data }` or `{ error: { code, message } }` | the registry and the floor, as `module:<name>`, held to `needs.tools` |
| `ctx.events.emit(type, payload)`, `.on(pattern, fn)`, `.since(id, opts)`, `.latestId()` | events | the event log, held to `watches` |
| `ctx.store.db`, `ctx.store.migrate(steps)` | its own SQLite tables. Migrations are forward-only, ordered and run once. An added module's database is its own file in its data folder. A built in module's tables are prefixed in vyre.db. | |
| `ctx.paths.data` | its own folder, `<home>/data/<module>/`, the only place it may write | |
| `ctx.settings.get(key)`, `.set(key, value)`, `.on(key, fn)` | its own declared keys, resolved project over account over default. `set` writes only plain keys, never one with `confirm` or `security`. | the hub |
| `ctx.vault.request(credentialId, { method, url, headers?, query?, body? })` | a vendor API call carrying a granted credential the module never sees. Reads run at once. Writes (send, spend, delete, by vault's classification table) hold at the Gate unless P17 covers them. The response is scrubbed. | vault P5 |
| `ctx.connections.call(provider, tool, input)` | a tool on a vendor-hosted MCP connection it was granted. Writes hold at the Gate, as for every MCP call. | the MCP hub |
| `ctx.fetch(url, init?)` | an uncredentialed request to a `needs.network` host. It refuses private, loopback, link-local, CGNAT, tailnet and metadata addresses, after DNS and on every redirect. | the host (P5's resolver) |
| `ctx.gate.request({ kind, via, to, content, why })` | propose an outward act through an existing sender (the mail module, say). It answers `{ held: id }` or `{ sent }` on a P17 match. | the Gate |
| `ctx.memory.write({ kind: "fact"\|"note", project, text, subject?, source_ref? })` | a memory row. vyred sets `from: "module:<name>"`, and `untrusted: true` is forced for added modules. It dedupes by `source_ref`. | iq's `memory.write` (P8) |
| `ctx.ask(prompt, { purpose, maxUsd?, model? })` | a one-shot model read with no tools. It returns `{ text, usd }`, or `{ error: { code: "capped" } }` at the cap. | sessions' `threads.quick`, billed on core/spend as `module:<name>/<purpose>` |
| `ctx.spend.record({ usd, purpose, estimated? })`, `ctx.spend.check(purpose)` | cost of its own paid API use | core/spend |
| `ctx.push.offer({ title, body, url?, kind })` | ask to notify the person. It answers `sent` or `deferred` (to the glance). | core/push's one daily budget and quiet hours (W4) |
| `ctx.undo.record({ tool, input, inverse })` | declares the inverse of an action it just took, for P14's shared log. Only a declared inverse is ever replayed. | core acted-log |
| `ctx.modules.status()` | read-only rows of every module | |
| *built in:* `ctx.config`, `ctx.paths`, `ctx.vault.fetch`, `ctx.route`, `ctx.upgrade`, `ctx.provider`, `ctx.remote`, `ctx.handler`, `ctx.upgrader`, `ctx.call(..., { as })`, `ctx.events.prune`, `ctx.declaredSettings`, `ctx.declaredTips` | as today | |

`ctx.memory.teach` stays as an alias of `ctx.memory.write({ kind: "fact" })` for one release
(section 8).

**Rules every module keeps**, checked by the conformance test (section 7):

- `start(ctx)` returns within 2 s (slow work goes after it returns). It returns `{ stop() }`, and
  `stop` finishes within 5 s, leaving no timer or handle open.
- Nothing polls faster than 60 s, and nothing runs while nobody needs it (SPEC principle 8).
  Events come before timers.
- Tool input is JSON Schema, and every tool gives at least one `examples` entry the conformance
  test calls.
- Errors are `{ code, message }` with a short lowercase code. User-facing text uses plain words
  and the sample world only.
- Nothing is shown that doesn't work: a slot whose tool fails is hidden, not drawn broken.

### 4. The capability manifest

A new kernel tool, `modules.capabilities { caller?, area? }`, answers what this caller may use,
built only from the registry:

```
{ rev, modules: [{ name, version, summary, kind: "built-in"|"added",
    tools: [{ name, summary, reach, outward?, cost?, needsAsk: bool }],
    connections: [...], slots: [...] }] }
```

- `reach` is declared statically, so the listing is exact: a tool an agent can't reach isn't
  listed for that agent, and an `asked` tool is listed with `needsAsk: true`. This closes the
  assistant's spike S2, where a map lied about tools that refuse inside.
- `rev` changes on `modules.changed` (a module added, removed, turned on or off, or updated) and on
  `mcp.server.changed`. It never runs on a timer.
- **Every agent learns it the moment a module lands.** The one `vyre` MCP entry every ACP provider
  gets (P1) serves each tool as an MCP tool. On `modules.changed` it sends
  `notifications/tools/list_changed`, and it serves `vyre://capabilities` as an MCP resource. The
  assistant's `assistant.capabilities` and its 1,500-token compact render in the append block read
  this tool (plans/assistant.md 3.4). A "changed since" line reaches running threads on their next
  turn (the assistant's mid-thread note).
- The person sees the same rows in Settings, under Modules and What your agents can do.

### 5. The module host: added modules can't step around ctx

An added module runs in a child process that reuses the **one sandbox** watchers already
specified for custom watcher code (plans/watchers.md 3.1g). It moves into `lib/sandbox` so both
use the same code:

- **Its own uid** on a Linux box, so vault files, the Docker API token and other modules' data
  aren't readable.
- **No network of its own.** It runs in its own network namespace. `ctx.fetch`,
  `ctx.vault.request` and `ctx.connections.call` are the only ways out, and the parent makes them.
- **No raw secret ever enters it.** Credentials are attached by vault in the parent (P5).
- **Node's permission model on top** (`--permission`, reads limited to its folder, writes to its
  data folder, no child processes, workers or addons), as a second barrier and never the only one.
- **One RPC channel** carries the ctx surface to the registry, which checks every call as
  `module:<name>` exactly as it checks a built in module's.

On a **Mac box** there is no network namespace. The host runs as a separate unprivileged macOS
user (vyre-core's split, ADR 0040), with a `sandbox-exec` profile denying network and file access
outside its folders. Spike PL2 decides whether that holds. Until it passes, an added module on a
Mac box runs only when the person's own words ask for it to run as trusted, and the card says why.

`--trusted` (or the person saying "trust it" in their own turn) keeps an added module in process,
like installing an npm package. The card says so in one line. Built in modules are always trusted.

**A module can never bypass the Gate or the floor.** Every path out of the host is a ctx call. Each
one runs through `Registry.call` (rules, caller checks, P17), and every write that acts as the
person passes the Gate: an `outward` tool, `vault.request` writes and MCP writes. The floor's own
modules (config, store, events, modules, presence, daemon, gate, harness rules, vault) can't be
replaced or disabled. An added module can't call `person` tools, approve at the Gate, call as
another label, declare presence, emit reserved events or write trusted memory.

### 6. Adding a module: one card, one tap

`modules.add { source }` (tool) and `vyre module add <source>` (CLI) fetch into a staging folder,
check it, then show the **install card**. The card is the watchers preview card's sibling
(app-design D3). vyred renders it from the checked manifest, never from the module's own words:

```
Northwind bakery  0.1.0   from github.com/alex/bakery  signed by alex (optional)
Does:   list today's orders · record an order · change the daily target (when you ask)
Acts as you:  order flour from the supplier (pay), held unless you asked
Reads from:   api.flourco.example
Uses:  your flourco key (vault) · memory (writes notes) · up to $0.50 a day
Shows: a Now card · `vyre bakery orders`
Runs: on your server, sandboxed
[Turn on]   [Not now]
```

- **One tap turns it on.** That tap is the grant, and it's recorded in `modules.lock.json` with the
  source, version, sha256 of the staged tree and the capability set. No Touch ID, since adding a
  module is not on C25's list. Granting a vault credential to it goes through the vault's existing
  grant, which is a reveal only if the item's own rules say so.
- **When a person asks** ("add the bakery module from github.com/alex/bakery"), an agent may run
  `modules.add`. It's an `asked` tool, and the card shows in the same turn. **When an agent decides
  on its own**, the same card waits in the person's waiting list and nothing runs.
- **Updates** (`vyre module update`, or `modules.update`): the same capabilities means it installs
  quietly and says so in the log. Any widening (a new outward tool, host, credential, connection
  or `asked` tool, or a higher spend cap) shows the card again with only the difference.
- **Signatures, optional.** A public module may ship `module.sig`: a minisign or sigstore
  signature over the tree hash. With one, the card names the signer, and later updates must carry
  the same signer or the card shows again saying the signer changed. Without one, it installs the
  same way. Signing never adds a step.
- `modules.remove` (`asked`) stops it, removes its folder, lock entry, tools, slots and grants, and
  keeps `<home>/data/<module>/` unless `--data` is given. An agent-called remove keeps data.

### 7. The developer kit

| Piece | What it does | Status |
|---|---|---|
| `vyre module new <name>` | scaffolds `module.json` (v1, object tools, `apiVersion`), `index.js`, a test, `AGENTS.md` (the agent brief), README, `jsconfig.json` | on main, template updated to v1 |
| `vyre module check [dir]` | schema, loader rules, reach and outward rules for added modules, entry file parses, static import scan (no `../core`, no `node:child_process`, `node:net`, `node:http(s)`, `node:dgram`, `node:worker_threads`) | on main, rules added |
| `@vyre/module-sdk/testing` | `testModule(dir, opts)`: a fake registry and ctx over a temp home, with fake tools, a fake Gate (records holds), a fake vault.request, a fake spend and a fake push. The module's own tests import it. No daemon. | new |
| `@vyre/module-sdk/conform` | `conformModule(dir)`: the checks every module must pass (below). `vyre module test` runs it, then the module's own tests. | new |
| `vyre module add/remove/list/update/enable/disable` | as in section 6 | add on main, the rest new |
| `examples/modules/bakery` | the complete example, which conformance and CI run | new |
| `docs/build/AGENT-BRIEF.md` | the exact text to hand another AI agent | new |

**Conformance (`conformModule`)**, the modules counterpart of sessions' `conform()`:

1. The manifest passes the schema and `checkManifest` as an added module.
2. The static import scan is clean.
3. `start` returns within 2 s and registers exactly the tools, providers, streams and routes it
   declares, no more and no fewer.
4. Every tool's `examples` validate against its input and run without throwing an uncaught error.
   The result is JSON.
5. Every emitted event is declared. Every `ctx.call` is in `needs.tools`.
6. An `outward` tool called as an agent without an ask produces a Gate hold and doesn't run.
   Called as the person, it runs once.
7. An `asked` tool called as an agent without an ask returns `not_asked`.
8. No timer under 60 s is left armed after `start`.
9. `stop` resolves within 5 s with no handles left.
10. Migrations run twice leave one schema.
11. Tips and user-facing strings contain no em dash, no section sign and no fixture-guard word
    (D2).

**How updates keep added modules working (the ratchet):**

- API 1 is frozen. Additions arrive only as optional keys and new ctx members found with
  `ctx.api.has`.
- `test/module-api-compat.test.js` runs conformance on `examples/modules/*` and on one frozen
  fixture module per released minor (`test/fixtures/modules/api1-0.2/`...). A release that breaks
  one fails CI. Fixtures are never edited, only added.
- Built in modules move onto the same contract as they are touched. `test/boundaries.test.js`
  gains a second frozen list, built in modules still using internal ctx members, and it only
  shrinks (ADR 0033 section 6's kernel thinning).
- `vyre doctor` and `vyre module list` name any module on a deprecated member, and any `replaces`
  module whose original gained tools.

### 8. Versions and deprecation (unchanged from ADR 0033, restated as binding)

- `apiVersion` is an integer that moves only on a breaking change. Vyre loads the current major and
  the one before. A module asking for a newer one isn't loaded, and `vyre module list` says "needs
  Vyre with module API 2; you have 1".
- A key or member is deprecated in a minor release, with a working replacement in the same
  release. It keeps working for at least 90 days and two minor releases. The loader logs it once
  per start and names it in `vyre doctor`. It's removed only when the major moves, listed under
  "Module API" in the changelog.
- Deprecated by this ADR, working through 0.3: string tool entries for added modules (built in
  modules keep them until they are touched), `does.senders` (use `outward`), `shows.cli` (use
  `does.commands`), `ctx.memory.teach` (use `ctx.memory.write`), `presence: true` and
  `callers: [...]` on added modules' tools (use `reach`), and roles meaning only `box` or `local`
  (still valid; `mac` and `windows` are additions).

### 9. What each 0.2 team does so its modules match v1

Every team that adds or changes a module in 0.2:

1. Gives each new tool an object entry with `reach` and, when it acts as the person outside,
   `outward`. Existing string entries may stay until touched.
2. Moves any tool refusing callers inside `run` to a declared `reach`, so the capability manifest
   is exact.
3. Writes memory only through `ctx.memory.write`, spends through `ctx.ask` or `ctx.spend`, and
   pushes only through `ctx.push.offer`.
4. Never gives a module its own approval path. Sends are `outward` tools or `ctx.gate.request`.
5. Runs `vyre module check` on its module folder in CI (test/module-sdk.test.js already holds every
   manifest to the schema).

Team-specific rows are in plans/platform.md section 3 and are posted in CHAT.md for each owner to
confirm.

## Consequences

- An agent that has never seen Vyre gets one brief, one scaffold, one example and one test that
  says pass or fail. Everything it may use is in the types.
- The Gate catches outward acts by declaration and by the only doors out of the host, not by
  guessing tool names.
- Added modules cost a child process each (spike PL1 measures RSS and cold start). Several added
  modules may share one host process per trust level if PL1 shows the cost matters.
- `does.providers`, `ctx.route` and `shows.streams` stay built in only in 0.2. That is said
  plainly in the docs and the check.

## Open

- PL1: host cost (RSS, cold start, RPC latency per `ctx.call`) on a hosted Linux runner.
- PL2: the Mac box host (a separate user plus a sandbox-exec profile) refuses network and outside
  file reads on a hosted macOS runner.
- PL3: the `asked` check against P17 with a `change` intent. It needs vault's and the assistant's
  yes (CHAT.md 06:10).
- Community module list and the public template repo, which wait for the person (ADR 0033 open 1).
