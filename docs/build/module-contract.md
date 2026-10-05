---
title: The module contract
summary: The exact shape of a Vyre module, module.json with its five verbs and the entry file's ctx, and every rule the loader enforces, taken from the code.
audience: builders, agents
owner: docs
status: stable
---

# The module contract

A module is a folder with a `module.json` and an entry file. The loader in `core/modules/index.js` reads the manifest, checks it, orders modules by what they require, and calls `start(ctx)`. This page is the contract as the code enforces it, from Section 5 of the [spec](../architecture/spec.md). For the why, see [modules](../concepts/modules.md). For a walk-through, see [writing a module](writing-a-module.md).

## The folder

```
~/.vyre/modules/invoices/
  module.json
  index.js          # or whatever "main" names
```

## module.json

```json
{
  "name": "invoices",
  "version": "0.1.0",
  "description": "Invoices for Harlow Legal, filed from the billing inbox.",
  "roles": ["box"],
  "requires": ["projects"],
  "main": "index.js",
  "does":    { "tools": ["invoices.list", "invoices.file"] },
  "watches": { "emits": ["invoice.filed"] },
  "shows":   { "deck": [], "capsule": [], "cli": [], "streams": [] },
  "needs":   { "vault": ["billing-inbox"] },
  "teaches": { "memory": ["invoice.item"] }
}
```

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | the module's name; every tool and table starts with it |
| `version` | yes | semver, such as `0.1.0` |
| `description` | no | one line, shown in listings |
| `roles` | no | `box`, `local` or both; both when omitted. See [the box and the Mac](../concepts/box-and-mac.md) |
| `requires` | no | modules that must be running before this one starts |
| `main` | no | the entry file, default `index.js` |
| `apiVersion` | no | the module API major it is written for; `1` today. The loader checks it from phase 1 of [ADR 0033](../adr/0033-hackable-vyre.md) |

The published schema, with every key module API 1 adds, is
`packages/module-sdk/manifest.schema.json`. `checkManifest()` in `packages/module-sdk/manifest.js`
gives the same answer with no dependencies, and a test holds every manifest in the repo to it.

### The five verbs

| Verb | Key | Meaning |
|---|---|---|
| `does` | `tools` | the tools this module registers with `ctx.tool` |
| `watches` | `emits` | the event types it emits with `ctx.events.emit` |
| `shows` | `deck`, `capsule`, `cli`, `streams` | where it appears; `streams` names the WebSocket streams it registers with `ctx.upgrade` |
| `needs` | `vault` | vault items it fetches with `ctx.vault.fetch` |
| `teaches` | `memory` | kinds of fact it hands the curator with `ctx.memory.teach` |

The loader does not act on `shows`. Surfaces read it through `GET /v1/modules`: the Capsule reads `shows.capsule` (`results:<tool>` and `action:<tool>` keys). The Vyre app lists modules in Settings but does not read `shows.deck` yet, and `vyre <module> <tool>` from `shows.cli` is not built; both come with the slots in ADR 0033.

## What the loader checks

When the manifest is read. A module that fails any of these is `invalid` and never starts:

- `name` matches `^[a-z][a-z0-9-]{1,40}$`: lowercase letters, digits and dashes, 2 to 41 characters, starting with a letter.
- `version` starts with `<major>.<minor>.<patch>`.
- `roles`, when present, is a list of `box` and `local` only.
- `requires`, when present, is a list.
- Each of `does`, `watches`, `shows`, `needs`, `teaches`, when present, is an object (not a list).
- Every name in `does.tools` looks like `module.verb` (`^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$`) and starts with the module's own name and a dot: `invoices.list`, never `list` or `billing.list`.
- Every name in `watches.emits` looks like `noun.past-verb` (`^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$`): `invoice.filed`. Event types do not have to start with the module's name.

When modules are ordered and started:

- A module whose `requires` names a module that is missing, failed or not running fails with the reason.
- A cycle in `requires` fails every module on it.
- A second module with a name already loaded is `invalid` and ignored. Vyre's own folders load first.
- The entry file must `export default { start(ctx) }`. If `start` throws, the module is `failed`, and its tools, streams and routes are removed.

At run time, each of these throws inside the module:

- `ctx.tool(name)` for a name not in `does.tools`, a name another module already registered, or a definition without a `run` function.
- `ctx.events.emit(type)` or `ctx.events.prune(type)` for a type not in `watches.emits`.
- `ctx.vault.fetch(name)` for an item not in `needs.vault`. An entry starting `per-` (`per-watcher`, `per-agent`, `per-sender`) declares a module that fetches on behalf of things it runs; it must check each one's own declaration.
- `ctx.memory.teach(kind)` for a kind not in `teaches.memory`.
- `ctx.upgrade(name)` for a stream not in `shows.streams`.
- `ctx.route(name)` for a name that is not lowercase letters, digits and dashes, or a route already taken.
- `ctx.store.migrate` for a `CREATE TABLE` whose table does not start with the module name (dashes become underscores) and an underscore: `invoices_items`, `hands_desktop_screens`.

## The entry file

```js
// @ts-check
export default {
  async start(ctx) {
    ctx.store.migrate([
      "CREATE TABLE invoices_items (id INTEGER PRIMARY KEY, number TEXT UNIQUE, total REAL, at INTEGER)",
    ]);
    ctx.tool("invoices.list", {
      description: "Invoices filed so far, newest first.",
      input: { type: "object", properties: { limit: { type: "integer" } } },
      run: async ({ limit = 20 }) => ctx.store.db.prepare("SELECT * FROM invoices_items ORDER BY at DESC LIMIT ?").all(limit),
    });
    return { async stop() {} };
  },
};
```

`start` returns a handle. vyred calls its `stop()` on shutdown, in reverse start order. Close timers, listeners and sockets there.

### What ctx holds

| Member | What it is |
|---|---|
| `ctx.name` | the module's name |
| `ctx.config` | the loaded `~/.vyre/config.json`, with defaults |
| `ctx.paths` | the paths under `VYRE_HOME`: `root`, `config`, `db`, `vault`, `modules`, `watchers`, `logs`, `models`, `certs`, `names`, `env`, `sessions`, `socket`, `pid` |
| `ctx.store.db` | the `node:sqlite` connection to `vyre.db`. Reads may join any table; write only your own. Nothing stops a write to another module's table, so this is a rule you keep, not one the loader checks |
| `ctx.store.migrate(steps)` | run numbered SQL migrations, once each, recorded per module |
| `ctx.log(msg, extra?)` | a line in vyred's log, prefixed with the module name |
| `ctx.events` | `emit`, `on`, `since`, `latestId`, `prune`. `latestId()` is the id a read is current to, so a view that loads through a tool can follow the stream from it with no gap. See [tools and events](tools-and-events.md) |
| `ctx.tool(name, def)` | register a tool. See below |
| `ctx.call(tool, input)` | call another module's tool as `module:<name>` |
| `ctx.remote(tool, input)` | on a Mac, call a tool on the paired box; `{ error: { code: "box_unreachable" } }` or `no_link` when it cannot |
| `ctx.vault.fetch(name, { field? })` | one vault item's value, if declared and granted |
| `ctx.memory.teach(kind, fact)` | hand a fact to the curator; a no-op when Memory is not running |
| `ctx.upgrade(name, handler)` | a WebSocket at `/v1/streams/<module>/<name>` |
| `ctx.route(name, fn)` | a raw HTTP route at `/v1/<module>/<name>` on vyred's socket |
| `ctx.handler(policy)` | vyred's router, for a module that opens a listener of its own (`names`, `onboard`) |
| `ctx.upgrader(policy)` | vyred's WebSocket router for such a listener, so streams (Glass) work over it too |

> [!GAP]
> Projects and threads are read through `ctx.call("projects.list", {})` and the other `projects.*` and `threads.*` tools (spec Section 5.2).

Never import another module's files. `ctx.call` is the only way one module uses another.

## A tool definition

```js
ctx.tool("invoices.file", {
  description: "File one invoice into its project.",
  input: { type: "object", required: ["number", "total"],
           properties: { number: { type: "string" }, total: { type: "number" } } },
  callers: ["cli", "local", "deck", "module"],   // optional allowlist of caller kinds
  presence: false,                              // true, or { summary: async input => "..." }
  run: async (input, { caller, thread, agent, peer, presence }) => { /* ... */ },
});
```

| Field | Meaning |
|---|---|
| `description` | what the tool does; Claude reads this |
| `input` | a JSON schema. The loader checks `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`), `required`, `enum`, nested `properties` and `items`. Anything subtler, check in `run` |
| `run` | `async (input, meta)`. Return any JSON value; it becomes `{ data }`. Throw to fail |
| `callers` | caller kinds that may use it: `cli`, `local`, `deck`, `capsule`, `mcp`, `module` and others. Omitted means any. Others get `denied` and do not see it in listings. The owner's Vyre app on a box arrives as the `deck` caller kind, so a tool open to `deck` is open to the app; an agent's node and a guest are not |
| `internal` | only other modules may call it, and it is left out of every listing |
| `hook` | the tool answers only the webhook route and no other caller. The route `POST /v1/<module>/<name>/hook` calls the tool `<module>.hook` with `{ name, token, body }` as the caller `hook`, so name the tool `<module>.hook`. The tool checks the token itself |
| `presence` | the call needs a person present. See [presence](../concepts/presence.md) |

`meta` holds what vyred verified, not what the input claims: `caller` (a label), `thread` and `agent` (only when proved with a key the Switchboard or the SessionStart hook gave out), `peer` (the network node a listener identified), and `presence` (`{ method, keyId }` after a proof). A thread or agent named in the input is only a claim.

A thrown error with a `code` of lowercase letters, digits and underscores (such as `conflict`) reaches the caller as that code; anything else is `failed`. An `err.detail` object is passed along.

## One tool, three surfaces

A tool is defined once and reaches every caller through one function, `Registry.call`:

- **Claude**, through the Harness MCP server `vyre`. Dots become underscores: `invoices.list` is `invoices_list`, which Claude Code shows as `mcp__vyre__invoices_list` (or `mcp__plugin_vyre_vyre__invoices_list` when installed as a plugin). Tools named `harness.*` are not offered. Inside an agent that is not the assistant, `threads.*` and `agents.*` are not offered either. See [the MCP hub](mcp-hub.md).
- **Surfaces**, over HTTP: `POST /v1/tools/invoices.list` on vyred's socket, or on the box's network listener. `GET /v1/tools` lists what the caller may use.
- **The terminal**: `vyre call invoices.list '{"limit":5}'`. `vyre tools` lists every tool.

The spec also promises a generated `vyre <module> <tool>` command for modules that list it under `shows.cli`. Not built yet: CLI commands are files in `core/cli/commands/`.

Every call runs these checks, in order:

| Check | Error code | HTTP status |
|---|---|---|
| the tool exists (and is not `internal` for a non-module caller, nor a `hook` tool outside the webhook route) | `no_such_tool` | 404 |
| the caller's kind is in `callers` | `denied` | 403 |
| a guest from another network is not calling a presence tool | `denied` | 403 |
| the input matches the schema | `bad_input` | 400 |
| the floor's rules allow it, for any caller but you at the CLI, `local`, the Vyre app or the Capsule (see [the security floor](../concepts/floor.md#where-the-floor-lives)) | `denied` | 403 |
| a person proved presence, for a presence tool and a caller that is not a module | `presence_required` | 403 |
| a Touch ID proof was asked for where Vyre may raise no dialog (under tests, or a home other than `~/.vyre`) | `no_dialog` | 403 |
| `run` succeeds | the thrown code, or `failed` | 500 |

Responses are `{ "data": ... }` or `{ "error": { "code", "message" } }`.

## Next

- [Tools and events](tools-and-events.md): a worked example.
- [Writing a module](writing-a-module.md): tests and installing.
- [Tools](../reference/tools.md) and [events](../reference/events.md): everything the built-in modules offer.
