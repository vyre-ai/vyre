---
title: Build your first module
summary: A step-by-step tutorial that builds a bake log for Northwind Bakery, with two tools, an event, a declared setting and a test, then switches it off.
audience: builders, agents
owner: platform
status: draft
---

# Build your first module

alex runs Northwind Bakery and wants juno to keep a log of every batch that comes out of the
oven. In this tutorial you build that as a Vyre module called `bake`. It has two tools,
`bake.log` and `bake.today`, one event, `bake.logged`, and one setting, `bake.unit`. You load it,
call it from the terminal, test it with `node:test`, and switch it off.

It takes about 15 minutes. You need Vyre installed and Node 22.5 or later. This page is the
tutorial; [Writing a module](writing-a-module.md) is the short reference, and the
[module contract](module-contract.md) lists every manifest key and everything on `ctx`.

## 1. Work in a throwaway home

Build against a temporary Vyre home, so nothing you try touches your real `~/.vyre`. Export
`VYRE_HOME` and every `vyre` command in this shell uses it:

```console
$ export VYRE_HOME=$(mktemp -d)
$ mkdir -p "$VYRE_HOME/modules/bake"
$ cd "$VYRE_HOME/modules/bake"
```

A temporary home never raises a Touch ID or keychain dialog. When the module works, step 9 puts
it in your real home.

## 2. Pick a name

The name in `module.json` is the module's name, and the loader holds everything to it:

- Every tool starts with the name and a dot: `bake.log`, never `log` or `bakery.log`.
- Every table starts with the name and an underscore: `bake_batches`. A dash in the name becomes
  an underscore.
- Every setting key starts with the name and a dot: `bake.unit`.

That is why this module is named `bake` and not `bake-log`: a module named `bake-log` would have
to call its tool `bake-log.log`. The name is lowercase letters, digits and dashes, 2 to 41
characters, starting with a letter.

## 3. Write module.json

Save this as `module.json` in the folder:

```json
{
  "name": "bake",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "A log of every batch Northwind Bakery bakes.",
  "roles": ["box", "local"],
  "does":    { "tools": ["bake.log", "bake.today"] },
  "watches": { "emits": ["bake.logged"] },
  "settings": [
    {
      "key": "bake.unit",
      "label": "Unit",
      "help": "What a batch is counted in.",
      "type": "enum",
      "enum": ["loaves", "trays", "dozens"],
      "default": "loaves",
      "levels": ["account"],
      "apply": "live"
    }
  ]
}
```

- `does.tools` lists every tool the module registers. Registering one that is not listed fails
  the module.
- `watches.emits` lists every event it emits. Emitting one that is not listed throws.
- `roles` says where it runs: on the box, on the Mac, or both. Both is the default.
- `settings` declares `bake.unit` in the settings registry's shape.

> [!NOTE] Coming in phase 1
> Today the loader accepts `apiVersion` and `settings` but does not act on them. From phase 1 of
> [ADR 0033](../adr/0033-hackable-vyre.md), the loader checks `apiVersion` and refuses a module
> that asks for a newer module API, and each setting gets a row in the Deck's Settings. Declaring
> both now means the module needs no change when that lands.

Also save a `package.json` beside it, so Node reads `index.js` as an ES module on every version
Vyre supports:

```json
{ "type": "module", "private": true }
```

### Check the manifest against the schema

The schema is `packages/module-sdk/manifest.schema.json` in the Vyre repository, and
`checkManifest()` in `packages/module-sdk/manifest.js` checks a manifest against it with no
dependencies. From a checkout of the repository at `<vyre>`:

```console
$ node --input-type=module -e '
import fs from "node:fs";
import { checkManifest } from "<vyre>/packages/module-sdk/manifest.js";
const problems = checkManifest(JSON.parse(fs.readFileSync("module.json", "utf8")));
console.log(problems.length ? problems.join("\n") : "module.json is valid");'
```

```output
module.json is valid
```

A problem prints as one line, such as `tool "log" must start with "bake."`.

> [!NOTE] Coming in phase 1
> `vyre module check <path>` runs the same check from the CLI. Not built yet. <!-- terms: ignore -->

## 4. Write index.js

Save this as `index.js`:

```js
// @ts-check
// bake: a log of every batch Northwind Bakery bakes.

const DAY = 24 * 60 * 60 * 1000;

/** @type {import("@vyre/module-sdk").Module} */
export default {
  async start(ctx) {
    ctx.store.migrate([
      "CREATE TABLE bake_batches (id INTEGER PRIMARY KEY, item TEXT NOT NULL, count INTEGER NOT NULL, unit TEXT NOT NULL, at INTEGER NOT NULL)",
    ]);

    // The unit comes from the bake.unit setting once ctx.settings exists (ADR 0033 phase 1).
    const unit = async () => (ctx.api?.has("settings") ? await ctx.settings.get("bake.unit") : "loaves");

    ctx.tool("bake.log", {
      description: "Log one batch that came out of the oven: what it was and how many.",
      input: {
        type: "object",
        required: ["item", "count"],
        properties: { item: { type: "string" }, count: { type: "integer" } },
      },
      run: async ({ item, count }) => {
        if (count < 1) throw Object.assign(new Error("count must be at least 1"), { code: "bad_count" });
        const u = await unit();
        const r = ctx.store.db
          .prepare("INSERT INTO bake_batches (item, count, unit, at) VALUES (?, ?, ?, ?)")
          .run(item, count, u, Date.now());
        const id = Number(r.lastInsertRowid);
        ctx.events.emit("bake.logged", { id, count });
        return { id, item, count, unit: u };
      },
    });

    ctx.tool("bake.today", {
      description: "Every batch logged in the last 24 hours, newest first, with a total.",
      input: { type: "object", properties: {} },
      run: async () => {
        const batches = ctx.store.db
          .prepare("SELECT id, item, count, unit, at FROM bake_batches WHERE at > ? ORDER BY at DESC, id DESC")
          .all(Date.now() - DAY);
        const total = batches.reduce((n, b) => n + Number(b.count), 0);
        return { batches, total };
      },
    });

    ctx.log("ready");
    return { async stop() {} };
  },
};
```

What each part does:

- `ctx.store.migrate` runs each step once and records it. Never edit a step after you ship it;
  add a new one to the end of the list.
- `ctx.store.db` is the `node:sqlite` connection to `vyre.db`. Write only your own tables.
- `ctx.tool` registers a tool. vyred checks the input against `input` before `run` sees it, so a
  missing `count` never reaches your code. The checker does not read `minimum`, so the tool
  checks `count < 1` itself.
- A thrown error with a `code` of lowercase letters and underscores reaches the caller as that
  code: `bad_count`.
- `ctx.events.emit` writes `bake.logged` to the event log. The payload carries the id and the
  count, not the item alex typed, because every module and the Deck can read the log.
- `ctx.log` writes a line to vyred's log, prefixed `[bake]`.
- `start` returns a handle whose `stop()` vyred calls on shutdown. This module holds no timers
  or sockets, so it has nothing to close.

The `@type` comment gives your editor the types in `packages/module-sdk/index.d.ts` when it can
find the package. Node ignores it.

> [!NOTE] Coming in phase 1
> `ctx.api` and `ctx.settings` do not exist yet, so `unit()` returns `loaves` today. From phase 1,
> `ctx.api.has("settings")` is true and `ctx.settings.get("bake.unit")` returns alex's choice.
> The `?.` keeps the same file working on both.

## 5. Start vyred and see the module

Start vyred in the throwaway home. `--json` keeps `vyre up` on a Mac from asking where your box
runs:

```console
$ vyre up --json
$ vyre modules
```

`vyre modules` lists every module and its state. Find the `bake` line:

```output
  bake                 0.1.0    running
```

If it says `invalid` or `failed`, the reason follows on the same line: a manifest problem, or
the error `start` threw. Fix it and restart (step 7).

Surfaces read the same list over HTTP, `GET /v1/modules` on vyred's socket:

```console
$ curl -s --unix-socket "$VYRE_HOME/vyred.sock" http://vyre/v1/modules
```

The `bake` entry is `{"name":"bake","version":"0.1.0","state":"running"}`. When the home's path
is long, the socket lives in a shared folder instead of the home; `vyre modules` finds it either
way.

`vyre tools` shows the two tools and their descriptions, which is what Claude reads:

```output
  bake.log                     Log one batch that came out of the oven: what it was and how many.
  bake.today                   Every batch logged in the last 24 hours, newest first, with a total.
```

## 6. Call it

```console
$ vyre call bake.log '{"item":"sourdough","count":24}'
```

```output
{
  "id": 1,
  "item": "sourdough",
  "count": 24,
  "unit": "loaves"
}
```

```console
$ vyre call bake.today
```

```output
{
  "batches": [
    {
      "id": 1,
      "item": "sourdough",
      "count": 24,
      "unit": "loaves",
      "at": 1790517976477
    }
  ],
  "total": 24
}
```

A bad call prints the error code and exits non-zero:

```console
$ vyre call bake.log '{"item":"rye"}'
```

```output
  bad_input: input.count is required
  next: vyre tools shows what bake.log takes
```

`{"item":"rye","count":0}` prints `bad_count: count must be at least 1`.

The event is in the log. Read it over the socket:

```console
$ curl -s --unix-socket "$VYRE_HOME/vyred.sock" 'http://vyre/v1/events?type=bake.logged'
```

Each event carries `type`, `source` (`bake`), `at` and your payload, `{"id":1,"count":24}`.

The same tool is also an MCP tool in Claude Code, `mcp__vyre__bake_log`, and an HTTP route,
`POST /v1/tools/bake.log`. You wrote it once. See
[one tool, three surfaces](module-contract.md#one-tool-three-surfaces).

## 7. Change it and restart

vyred loads modules when it starts. After any change to `module.json` or `index.js`, restart:

```console
$ vyre down && vyre up --json
$ vyre modules
```

> [!SNAG] vyre modules says vyred is not running
> Right after a restart, vyred can still be shutting down when `vyre up` runs. Run
> `vyre up --json` again.

## 8. Add a test

A test does not need a running vyred. It can call `start` with a stand-in `ctx` that holds only
what the module uses, backed by a real SQLite database in memory. Save this as
`test/bake.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import bake from "../index.js";

// A stand-in for the ctx vyred hands start(): a real SQLite database in memory,
// and tools and events kept in plain collections so the test can look at them.
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const tools = new Map();
  const emitted = [];
  return {
    tools, emitted,
    ctx: {
      name: "bake",
      log: () => {},
      store: { db, migrate: steps => steps.forEach(sql => db.exec(sql)) },
      tool: (name, def) => tools.set(name, def),
      events: { emit: (type, payload) => emitted.push({ type, payload }) },
    },
  };
}

test("bake.log saves a batch and bake.today adds it up", async () => {
  const { ctx, tools, emitted } = fakeCtx();
  const handle = await bake.start(ctx);

  const logged = await tools.get("bake.log").run({ item: "sourdough", count: 24 });
  assert.deepEqual(logged, { id: 1, item: "sourdough", count: 24, unit: "loaves" });
  await tools.get("bake.log").run({ item: "rye", count: 12 });

  const today = await tools.get("bake.today").run({});
  assert.equal(today.total, 36);
  assert.deepEqual(today.batches.map(b => b.item), ["rye", "sourdough"]);

  // The event carries the id and the count, never what alex typed.
  assert.deepEqual(emitted[0], { type: "bake.logged", payload: { id: 1, count: 24 } });
  await handle.stop();
});

test("bake.log refuses a batch of zero", async () => {
  const { ctx, tools } = fakeCtx();
  await bake.start(ctx);
  await assert.rejects(tools.get("bake.log").run({ item: "rye", count: 0 }), { code: "bad_count" });
});
```

Run it from the module folder:

```console
$ node --test
```

```output
✔ bake.log saves a batch and bake.today adds it up
✔ bake.log refuses a batch of zero
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

The stand-in skips what vyred adds around `run`: the input schema check, the manifest checks and
the table prefix check. Steps 5 and 6 cover those against a real vyred. Inside the Vyre
repository, tests start a real vyred in a temp home instead; see
[Writing a module](writing-a-module.md#test-it).

> [!NOTE] Coming in phase 3
> `@vyre/module-sdk/testing` gives a fake registry and a temp home, so a module's own tests run
> the real checks without a daemon. Not built yet. Until then, keep a stand-in `ctx` like the one
> above.

## 9. Switch it off, and on

Switch a module off with `modules.disable` in the home's `config.json`. In the throwaway home
there is no `config.json` yet, so write one, then restart:

```console
$ vyre down
$ echo '{ "modules": { "disable": ["bake"] } }' > "$VYRE_HOME/config.json"
$ vyre up --json
$ vyre modules
```

```output
  bake                 0.1.0    off
```

Its tools are gone: `vyre call bake.today` prints `no_such_tool: no tool bake.today`. Its table
and events stay in `vyre.db`, so switching it back on loses nothing. Take `bake` out of the list
and restart to switch it on.

In a real home, `config.json` holds other settings: add `"disable": ["bake"]` inside its
`modules` object rather than replacing the file. `modules.enable` does the opposite for roles: it
starts a module on a machine its `roles` leave out.

> [!NOTE] Coming in phase 1
> `vyre module disable <name>` and `vyre module enable <name>` write the same list for you, and a <!-- terms: ignore -->
> module that requires a switched-off one shows "off: needs bake" instead of failing. Not built
> yet.

When you are done with the throwaway home:

```console
$ vyre down
$ unset VYRE_HOME
```

## 10. Install it for real

Copy the folder into your own home and restart:

```console
$ cp -R <path-to>/bake ~/.vyre/modules/
$ vyre down && vyre up
```

juno can now call `bake.log` when alex says "log 24 sourdough", and `bake.today` when alex asks
what came out of the oven today.

> [!NOTE] Coming in phase 1 and phase 3
> `vyre module new <name>` (phase 1) scaffolds a module like this one from `templates/module/` <!-- terms: ignore -->
> (phase 3): the manifest, `index.js`, a test and a `jsconfig.json` for autocomplete. Not built
> yet; write the files by hand as above.

## What a module will not do

- It never imports another module's files. `ctx.call` is the only way one module uses another.
- It never writes another module's tables. Reads may join any table.
- It never puts secrets or what a person typed in an event payload.
- A module named like one of Vyre's own is marked `invalid` and ignored. Replacing a first-party
  module comes with `replaces` in phase 1 of [ADR 0033](../adr/0033-hackable-vyre.md).

## Where to go next

- [Writing a module](writing-a-module.md): the short reference and the rules the loader enforces.
- [Module contract](module-contract.md): every manifest key and
  [everything on ctx](module-contract.md#what-ctx-holds).
- [Tools and events](tools-and-events.md): calling other modules and listening for events.
- [ADR 0033](../adr/0033-hackable-vyre.md): what the module API adds, phase by phase.
