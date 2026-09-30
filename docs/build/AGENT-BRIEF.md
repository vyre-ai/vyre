---
title: The agent brief for writing a module
summary: The exact instructions to hand an AI agent that has never seen Vyre, so the module it writes installs and works the first time. Rules, steps, the manifest and ctx cheat sheets, a worked example and every refusal with its fix.
audience: agents, builders
owner: platform
status: stable
---

# Writing a Vyre module: the brief

You are writing a module for Vyre. Read this whole page before you write a line. Everything you may
use is here, in `packages/module-sdk/index.d.ts`, and in the complete example at
`examples/modules/bakery` in the Vyre repository.

## What a module is

A module is a folder: `module.json`, an entry file (`index.js`) whose default export has
`start(ctx)`, and anything else it ships. It talks to the rest of Vyre only through `ctx`.

## The golden rules

1. **Only `ctx`.** Every way out of the module is a `ctx` member: another module's tool
   (`ctx.call`), the network (`ctx.fetch`), a vendor API with a key (`ctx.vault.request`), memory,
   push, spend, the Gate. An added module runs in a sandboxed host where nothing else works.
2. **Never import a Vyre file.** No `../core/...`, no path outside your folder. Import only your
   own files and safe Node built ins (`node:crypto`, `node:path`, `node:url`, `node:fs` inside
   `ctx.paths.data`).
3. **No process, socket or thread of your own.** Never import `node:child_process`, `node:net`,
   `node:http`, `node:https`, `node:dgram`, `node:worker_threads` or `node:cluster`, with or
   without the `node:` prefix.
4. **Every tool says who may call it.** Each entry under `does.tools` is an object with `name`,
   `summary` and `reach`. A tool that acts as the person outside (sends, posts, pays, deletes
   somewhere else) also says `outward`.
5. **Never ask for presence.** No `presence` on a tool, no Touch ID, no prompt of your own. Use
   `reach: "asked"` for anything that changes settings, deletes local data or reshapes an agent.
   Use `outward` for anything that acts as the person outside; the Gate handles it.
6. **Nothing polls faster than 60 seconds.** Listen to events first. A timer you start, you clear
   in `stop()`.
7. **Migrations are forward only.** `ctx.store.migrate([...])` takes an ordered list. Add a step
   to change a table; never edit or remove a step that has run. Tables start with your module's
   name and an underscore.
8. **Each ctx door has one declaration.** `ctx.call` needs the tool in `needs.tools`,
   `ctx.gate.request` needs `gate.request` there, `ctx.vault.request` a `needs.credentials` id,
   `ctx.connections.call` a `needs.connections` provider, `ctx.fetch` a `needs.network` host,
   `ctx.memory.write` its kind in `teaches.memory`, `ctx.ask` and `ctx.spend` a `needs.spend` cap,
   and `ctx.push.offer` its kind in `shows.notices`. `ctx.undo.record` needs nothing. A call
   without its declaration throws an error with code `undeclared`. The install card is built from
   these declarations, so declare only what you use.
9. **Plain words and the sample world.** Summaries are one lowercase line. No em dash, no section
   sign. Example people and businesses are only alex, Harlow Legal, Northwind Bakery, juno and
   kit, and example hosts end in `.example`.

## The steps

1. **Make the folder.** `vyre module new <name> --dir <parent>` writes `module.json`, `index.js`,
   `<name>.test.js`, `README.md`, `AGENTS.md` (this brief) and `jsconfig.json`. It already
   passes every check. The name is lowercase letters, digits and dashes, 2 to 41 long.
2. **Edit `module.json`.** Declare every tool (with `reach`, and `outward` where it applies),
   every event you emit, every event you listen to, every setting, and everything you need.
3. **Write the tools** in `index.js`. Each one gets `description`, a JSON Schema `input`, at least
   one entry in `examples`, and `run(input, meta)`.
4. **Write the tests** in `<name>.test.js` with the SDK's harness (`testModule`), one per tool,
   plus the refusals: an outward tool held for an agent, an asked tool refused without an ask.
5. **Check until clean.** Run `vyre module check .`, then `vyre module test .` (conformance, then
   your tests). Fix every line it prints, and run both again. Do not stop at one failure.
6. **Add it.** `vyre module add <folder>` shows the person an install card built from your
   manifest. Their tap turns it on.

## Versions: what stays working

- `"vyre": "1"` names the module contract you write for. Write `"1.2"` only when you use something
  added in contract 1.2; a Vyre that has only 1.0 then says so plainly and never runs your code.
- Inside contract 1, Vyre only adds. Nothing you use is removed, renamed or narrowed, and a default
  never changes what your module does. A module written for 1.0 keeps working on every 1.x Vyre.
- A key Vyre doesn't know is ignored when it loads, and `vyre module check` shows it as a warning:
  a typo, or a key from a newer contract. Warnings never fail a check or a test.
- Check for a newer ctx member with `ctx.api.has("<feature>")` and work without it when you can.
  `ctx.api.version` is the contract this Vyre speaks, like `"1.0"`.
- Something deprecated keeps working, with a warning, for at least two Vyre releases or six
  months. `vyre module upgrade .` rewrites what it safely can (for example `apiVersion` to
  `"vyre"`, string tool entries to objects, `ctx.memory.teach` to `ctx.memory.write`), lists what
  it left for you, and runs the checks. `--dry-run` shows the changes and writes nothing.
- When contract 2 arrives, a `"vyre": "1"` module keeps running beside it for at least 12 months.

## module.json cheat sheet

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
    "commands": [{ "verb": "orders", "tool": "bakery.orders", "summary": "today's orders" }],
    "watchers": ["watchers/big-order.json"]
  },
  "watches": { "emits": ["bakery.order-added"], "on": ["memory.written"] },
  "shows": { "deck": ["now:bakery.today"], "notices": ["target-reached"] },
  "settings": [{ "key": "bakery.target", "label": "Daily target", "type": "int", "default": 40,
                 "levels": ["account"], "apply": "live" }],
  "needs": {
    "credentials": [{ "id": "supplier", "kind": "api-credential", "provider": "flourco", "purpose": "place flour orders" }],
    "network": ["api.flourco.example"],
    "spend": { "dailyUsd": 0.5 }
  },
  "teaches": { "memory": ["note"] }
}
```

| Key | Rule |
|---|---|
| `name` | `^[a-z][a-z0-9-]{1,40}$`. It prefixes every tool, event, setting and table. |
| `vyre`, `description` | Required. The contract you write for (`"1"`), and one plain sentence for the install card. |
| `roles` | `box` (the server), `local` (a device), `mac`. Default `["box"]`. `windows` alone loads nowhere yet. |
| `does.tools[]` | `{ name, summary, reach?, outward?, cost? }`. `name` is `<module>.<verb>`. |
| `reach` | `anyone` (default): the person, agents, modules listing it. `asked`: an agent only when the person's own words asked. `modules`: Vyre's own modules only. `hook`: the webhook route only. Never `person`. |
| `outward` | `send`, `post`, `pay` or `delete`, with reach `anyone` or `asked`. Runs for the person's tap; every other call is held at the Gate. |
| `cost` | `"paid"` when the tool spends money through your own model or API use. |
| `does.commands[]` | `{ verb, tool, summary, args? }` gives `vyre <module> <verb>`. |
| `does.watchers[]` | Relative `.json` preset files. A preset only describes; it runs no code. |
| `watches.emits` | Every event type you emit, `<module>.<past-verb>`. |
| `watches.on` | Every pattern you subscribe to: a type, `noun.*` or `*`. |
| `shows.deck` | Slots: `now:<tool>`, `renderer:<tool>`, `slash:<name>`, `settings`, `view:<name>`, `panel:<name>`. |
| `settings[]` | `{ key: "<module>.<key>", label, type, default, levels, apply }`. |
| `needs.tools` | Every tool you call with `ctx.call`, named one by one (no `module.*`), and `gate.request` if you use `ctx.gate.request`. You reach only tools whose own manifest declares `reach` `anyone` or `asked`; any other answers `not_declared`. <!-- terms: ignore --> |
| `needs.credentials` | Vault items by `id`, `kind`, `provider`, `purpose`. Used only through `ctx.vault.request`. |
| `needs.network` | Public hosts `ctx.fetch` may read from without a key. |
| `needs.connections` | `{ provider, purpose }` for vendor MCP connections. |
| `needs.spend` | `{ dailyUsd }`, your daily cap. Needed for `ctx.ask` and `ctx.spend`. |
| `teaches.memory` | The kinds `ctx.memory.write` writes: `fact`, `note` or both. |
| `shows.notices` | The notice kinds `ctx.push.offer` raises. |
| Built in only | `does.providers`, `shows.streams`, `needs.vault`, `replaces`. An added module can't use them in 0.2. |

## ctx cheat sheet

| Member | Use |
|---|---|
| `ctx.name`, `ctx.version` | Your module's name and version. |
| `ctx.api.version`, `ctx.api.has(feature)` | `1`, and whether an addition inside API 1 is there. |
| `ctx.log.info/warn/error/debug(msg, extra?)` | Logs prefixed with your name. |
| `ctx.tool(name, { description, input, output?, examples, run })` | Register a declared tool. `run(input, meta)` returns JSON or throws an Error with a short lowercase `code`. |
| `meta` | `{ caller, who, agent?, thread?, project?, asked?, gate? }`, set by Vyre, never from input. `gate` is `person`, `asked` or `approved` on an outward tool. |
| `ctx.call(tool, input)` | Another module's tool. Resolves `{ data }` or `{ error: { code, message } }`. Listed in `needs.tools`. |
| `ctx.events.emit(type, payload)` | A declared event. Every module can read it: carry ids, not what a person typed. |
| `ctx.events.on(pattern, fn)` | Subscribe; returns the unsubscribe you call in `stop()`. |
| `ctx.events.since(id, opts)`, `.latestId()` | Read the log from a cursor. |
| `ctx.store.db`, `ctx.store.migrate(steps)` | Your own SQLite (`node:sqlite`), forward-only migrations. |
| `ctx.paths.data` | Your own folder, the only place you may write files. |
| `ctx.settings.get(key)`, `.set(key, value)`, `.on(key, fn)` | Your declared settings. |
| `ctx.vault.request(id, { method, url, headers?, query?, body? })` | A vendor API call with a key you never see. Writes hold at the Gate unless the person asked. |
| `ctx.connections.call(provider, tool, input)` | A tool on a vendor MCP connection you declared. |
| `ctx.fetch(url, init?)` | A GET or HEAD, with no body, to a `needs.network` host. Anything else throws `method_not_allowed`. Private addresses are refused. |
| `ctx.gate.request({ kind, via, to, content, why })` | Propose an outward act through an existing sender. Answers `{ held }` or `{ sent }`. |
| `ctx.memory.write({ kind, project?, text, subject?, source_ref? })` | A memory row. Set `source_ref` so a retry is one row. |
| `ctx.ask(prompt, { purpose, maxUsd? })` | A one-shot model read. `{ text, usd }` or `{ error: { code: "capped" } }`. |
| `ctx.spend.record({ usd, purpose })`, `.check(purpose)` | The cost of your own paid API use. |
| `ctx.push.offer({ title, body, url?, kind })` | Ask to notify the person. `sent` or `deferred`. |
| `ctx.undo.record({ tool, input, inverse })` | The inverse of what you just did, so it can be undone. |
| `ctx.modules.status()` | Read-only rows of every module. |

Anything in `index.d.ts` tagged `@internal` is not for you: `ctx.config`, `ctx.route`,
`ctx.upgrade`, `ctx.provider`, `ctx.vault.fetch` and the rest.

## Worked example: Northwind Bakery

A tool anyone may call, with examples and a coded refusal:

```js
ctx.tool("bakery.add", {
  description: "Record an order: who it is for and how many items",
  input: { type: "object", required: ["customer", "items"], additionalProperties: false,
    properties: { customer: { type: "string", minLength: 1 }, items: { type: "integer", minimum: 1 } } },
  examples: [{ input: { customer: "Harlow Legal", items: 24 } }],
  run: async ({ customer, items }) => {
    const id = Number(insert.run(today(), customer, items, Date.now()).lastInsertRowid);
    ctx.events.emit("bakery.order-added", { id, items, big: items >= 20 });
    if (items >= 20) await ctx.memory.write({ kind: "note", text: `${customer} ordered ${items} items.`, source_ref: `bakery:order:${id}` });
    return { id };
  },
});
```

An outward tool. Vyre only runs it after the person's own words asked for it or they approved it.
A tap on a button your module drew never runs it: Vyre shows its own Gate card instead. The one
supplier write inside the cleared run goes through without a second card:

```js
ctx.tool("bakery.flour", {
  description: "Order flour from the supplier, in kilograms",
  input: { type: "object", required: ["kg"], properties: { kg: { type: "integer", minimum: 1, maximum: 500 } } },
  examples: [{ input: { kg: 25 } }],
  run: async ({ kg }, meta) => {
    const r = await ctx.vault.request("supplier", { method: "POST", url: "https://api.flourco.example/orders", body: { kg } });
    if ("held" in r) return { held: r.held };
    if (r.status >= 400) throw Object.assign(new Error(`the supplier said ${r.status}`), { code: "supplier_refused" });
    return { ordered: true, kg, cleared: meta.gate };
  },
});
```

The migration, and a `stop` that leaves nothing running:

```js
ctx.store.migrate([
  "CREATE TABLE bakery_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, customer TEXT NOT NULL, items INTEGER NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX bakery_orders_day ON bakery_orders (day)",
]);
const off = ctx.events.on("memory.written", e => ctx.log.debug("memory kept a note", { id: e.id }));
return { async stop() { off(); } };
```

The test, on the SDK's harness:

```js
import { testModule } from "@vyre/module-sdk/testing";

test("bakery.flour is held for an agent and runs for the person", async t => {
  const h = await testModule(DIR, { vault: { supplier: { status: 201, headers: {}, body: {} } } });
  t.after(() => h.stop());
  assert.deepEqual(await h.call("bakery.flour", { kg: 25 }, { who: "agent" }), { held: "hold-1" });
  assert.equal((await h.call("bakery.flour", { kg: 10 })).data.cleared, "person");
  assert.equal((await h.call("bakery.target", { target: 60 }, { who: "agent" })).error.code, "not_asked");
});
```

`h.call(tool, input, { who, asked })` routes a call as Vyre does: `who` is `person` (default),
`agent`, `module` or `hook`. `h.holds`, `h.calls`, `h.events` and `h.memory` record what happened;
`h.approve(id, content)` approves a hold as the person would.

## Common refusals and their fixes

| The check says | Change |
|---|---|
| `"vyre" is required outside Vyre's own modules` | Add `"vyre": "1"`. |
| `needs a newer Vyre (module contract 1.2); this Vyre has 1.0` | Update Vyre, or write for an older contract: use only what `"vyre": "1"` has. |
| `apiVersion is deprecated` and other warnings | Nothing fails. Run `vyre module upgrade .` to move to the current form. |
| `description is required outside Vyre's own modules` | Add one plain sentence under `description`. |
| `tool "x.y" must be an object like { "name": ... }` | Write the entry as `{ "name": "x.y", "summary": "...", "reach": "anyone" }`. |
| `tool "x" must start with "<name>."` | Prefix every tool with your module's name and a dot. |
| `reach "person" is kept for Vyre's own tools; use "asked"` | Use `"reach": "asked"`. |
| `an outward tool must have reach "anyone" or "asked"` | Drop `modules` or `hook` from an outward tool, or drop `outward`. |
| `does.providers` / `shows.streams` / `needs.vault is built in only in 0.2` | Remove it. Use `needs.credentials` with `ctx.vault.request` instead of `needs.vault`. |
| `roles ["windows"] loads nowhere in 0.2` | Add `"box"` or `"mac"`. |
| `names X, which is not under does.tools` | Declare the tool a command, hook or setting points at. |
| `imports node:child_process; a module has no process, socket or thread of its own` | Use `ctx.fetch`, `ctx.vault.request` or `ctx.call`. |
| `imports ...; a module never imports Vyre's files` | Remove the import and use `ctx`. |
| `imports ..., which is outside the module folder` | Copy what you need into your folder. |
| `ctx.fetch sends GET or HEAD with no body` (`method_not_allowed`) | To send data, webhook URLs included, use an `outward` tool or `ctx.vault.request`. |
| `needs.tools "x.*": an added module names each tool it calls` | List each tool by name. |
| `replaces: an added module can't replace one of Vyre's modules` | Remove `replaces` and pick a name of your own. |
| `not_declared` from `ctx.call` | The tool you called has no declared reach, or is for Vyre's own modules. Use another tool. |
| `X is declared under does.tools, but start did not register it` | Call `ctx.tool("X", ...)` in `start`, or remove the entry. |
| `registered tool X, which its manifest does not declare` | Add X to `does.tools`. |
| `X has no examples` | Give `ctx.tool` `examples: [{ input: {...} }]`. |
| `X examples[0] failed: ...` | Make the example valid for `input`, and make `run` throw only Errors with a `code`. |
| `emitted X, which its manifest does not declare under watches.emits` | Add X to `watches.emits`. |
| `ctx.call X, which needs.tools does not list` | Add X to `needs.tools`. |
| `... (undeclared)`, or an error with code `undeclared` | Declare the door: see golden rule 8's list of which key each ctx member needs. |
| `subscribed to X, which its manifest does not declare under watches.on` | Add X to `watches.on`. |
| `fetched X, which needs.network does not list` | Add the host to `needs.network`. |
| `asked the vault for X, which needs.credentials does not declare` | Add X to `needs.credentials`. |
| `start did not return within 2 s` | Do slow work after `start` returns. |
| `start left a N ms interval running` | Listen to an event, or poll no faster than every 60 s. |
| `... was still running after stop; clear it in stop()` | Clear every timer and unsubscribe every listener in `stop`. |
| `a second start changed the schema` | Never change a migration step that ran; add a new step. |
| `has an em dash` / `has a section sign` | Rewrite with a colon, a comma or two sentences. |
| `names a real person or business` | Use the sample world: alex, Harlow Legal, Northwind Bakery, juno, kit. |

## What a module must never do

- Send data with `ctx.fetch`. It reads only (GET or HEAD, no body). A URL can carry a secret, such
  as a webhook URL, so posting to one goes through an `outward` tool or `ctx.vault.request`, where
  the Gate and the vault see it.
- Import a Vyre file, or anything outside its folder.
- Open a process, socket, server or thread of its own.
- Read or write files outside `ctx.paths.data`, or another module's data.
- Hold, read or print a raw secret. Keys stay in the vault; `ctx.vault.request` attaches them.
- Act as the person outside without `outward` on the tool or `ctx.gate.request`.
- Declare presence, approve at the Gate, call as another caller, or add a prompt of its own.
- Emit a reserved event (`sync.*`, `gate.*`, `presence.*`, `vault.*`, `turn.said`). <!-- terms: ignore -->
- Poll faster than every 60 seconds, or keep running work nobody needs.
- Put a customer's or a person's words into an event.
- Use real people's names, emails or hosts in examples, tests or tips.
