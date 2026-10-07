---
title: Writing a module
summary: Build a working Vyre module in two files, and the rules the loader holds it to.
audience: builders, agents
owner: docs
status: stable
---

# Writing a module

A module is a folder with a `module.json` and an `index.js`. Put it in `~/.vyre/modules/` and
restart vyred. The full contract is Section 5 of the
[Specification](../architecture/spec.md#5-the-module-contract) and the
[module contract](module-contract.md) page; this page is the short way in.
[Build your first module](first-module.md) is the step-by-step tutorial.

## Start from vyre module new

```
vyre module new notes
```

It writes `~/.vyre/modules/notes/` with a `module.json`, an `index.js` that registers one tool
(`notes.hello`) and emits one event (`notes.said`), a test, a `package.json` and a README. The
files pass `vyre module check` and their own `node --test` as they are. It refuses a name one of
Vyre's own modules has, a name vyred already runs, and a folder that is already there.
`--dir <parent>` makes it somewhere else; `vyre module add <folder>` puts it in the home later.

## A complete module

`~/.vyre/modules/notes/module.json`

```json
{
  "name": "notes",
  "version": "0.1.0",
  "does":    { "tools": ["notes.add"] },
  "watches": { "emits": ["note.added"] }
}
```

`~/.vyre/modules/notes/index.js`

```js
// @ts-check
export default {
  async start(ctx) {
    ctx.store.migrate(["CREATE TABLE notes_items (id INTEGER PRIMARY KEY, body TEXT, at INTEGER)"]);
    ctx.tool("notes.add", {
      description: "Save a note.",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      run: async ({ text }) => {
        const r = ctx.store.db.prepare("INSERT INTO notes_items (body, at) VALUES (?, ?)").run(text, Date.now());
        const id = Number(r.lastInsertRowid);
        ctx.events.emit("note.added", { id });
        return { id };
      },
    });
    return { async stop() {} };
  },
};
```

## Load it and call it

```
vyre down && vyre up
vyre modules
vyre call notes.add '{"text":"call the printer people"}'
```

`vyre modules` lists `notes` as `running`, or `failed` or `invalid` with the reason.
`vyre module check ~/.vyre/modules/notes` finds most of those reasons before a restart: the manifest against the
schema and the loader's rules, and the entry file parsing. The call prints what `run` returned:

```output
{
  "id": 1
}
```

The one definition becomes an MCP tool Claude can call (the Harness's `vyre` server lists every
tool) and an HTTP route, `POST /v1/tools/notes.add` on vyred. `vyre call` runs any tool from the
terminal. [Section 5.3](../architecture/spec.md#53-one-tool-three-surfaces) of the Specification
also describes a `vyre notes add` command for tools listed under `shows.cli`; the loader does not <!-- terms: ignore -->
make those commands yet.

A module runs on both a box and a Mac unless its manifest sets `roles` to `["box"]` or
`["local"]`. It starts after everything in its `requires` list.

## The rules the loader enforces

- Tool names start with the module name: `notes.add`, never `add`.
- Tables start with the module name and an underscore: `notes_items`. `ctx.store.migrate`
  refuses any other `CREATE TABLE`.
- A tool must be listed under `does.tools`, and an event under `watches.emits`. Registering an
  unlisted tool in `start` throws, which fails the module. Emitting an unlisted event throws at
  the moment you emit it, so the tool call that emitted it fails.
- Event names read `noun.past-verb`: `note.added`, `watcher.fired`.
- Event payloads never carry secrets, and the log refuses anything that looks like one. Leave
  out what the user typed, too: every module and the Vyre app can read the log. That is why
  `note.added` above carries the note's id, not its text.
- Input is checked against the tool's schema before `run` sees it.
- If `start` throws, the module is marked failed and the rest keep running. `vyre modules` shows
  why.

## Test it

To try a change without touching your real `~/.vyre`, run a throwaway vyred in a temporary
home. Export `VYRE_HOME` so every command in the shell uses it:

```
export VYRE_HOME=$(mktemp -d)
mkdir -p "$VYRE_HOME/modules" && cp -R ~/.vyre/modules/notes "$VYRE_HOME/modules/"
vyre up --json
vyre call notes.add '{"text":"call the printer people"}'
vyre down
unset VYRE_HOME
```

`--json` keeps `vyre up` on a Mac from asking where your box runs. A temporary home never
raises a Touch ID or keychain dialog.

Inside the Vyre repository, tests use `test/helpers.js`: `tempHome(t)` gives each test its own
`VYRE_HOME` and removes it after, and `writeModule(root, name, manifest, source)` writes a module
folder. A test that loads the module above (its `index.js` saved as a fixture) and calls its
tool:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome, writeModule } from "./helpers.js";

const SOURCE = fs.readFileSync(new URL("./fixtures/notes/index.js", import.meta.url), "utf8");

test("notes.add saves a note and refuses one with no text", async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "notes",
    { does: { tools: ["notes.add"] }, watches: { emits: ["note.added"] } }, SOURCE);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await call("notes.add", { text: "call the printer people" }, { root });
  assert.deepEqual(r, { data: { id: 1 } });
  assert.equal((await call("notes.add", {}, { root })).error.code, "bad_input");
});
```

See [Testing](../contributing/testing.md) for the rest of the helpers.

## Add a module from somewhere else

```
vyre module add ./notes
vyre module add https://github.com/<user>/<repo>
```

It checks the module, shows its tools, events and what it needs (vault items, hosts,
credentials), asks you to confirm (or takes `--yes`), copies it into `~/.vyre/modules/<name>/`
and restarts vyred. A module runs inside vyred with Vyre's own access, so add only code you trust.
Replacing one of Vyre's own modules needs `"replaces"` with its name in `module.json` and `--yes`.

## Where to go next

- [Module contract](module-contract.md): every manifest key and everything on `ctx`.
- [Tools and events](tools-and-events.md): naming, schemas and who may call what.
- [Modules reference](../reference/modules.md): the modules Vyre ships.
