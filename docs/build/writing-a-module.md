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
        ctx.store.db.prepare("INSERT INTO notes_items (body, at) VALUES (?, ?)").run(text, Date.now());
        ctx.events.emit("note.added", { text });
        return { saved: true };
      },
    });
    return { async stop() {} };
  },
};
```

## Load it and call it

```
vyre down && vyre up
vyre call notes.add '{"text":"call the printer people"}'
```

The one definition becomes an MCP tool Claude can call (the Harness's `vyre` server lists every
tool) and an HTTP route, `POST /v1/tools/notes.add` on vyred. `vyre call` runs any tool from the
terminal. [Section 5.3](../architecture/spec.md#53-one-tool-three-surfaces) of the Specification
also describes a `vyre notes add` command for tools listed under `shows.cli`; the loader does not
make those commands yet.

A module runs on both a box and a Mac unless its manifest sets `roles` to `["box"]` or
`["local"]`. It starts after everything in its `requires` list.

## The rules the loader enforces

- Tool names start with the module name: `notes.add`, never `add`.
- Tables start with the module name and an underscore: `notes_items`.
- A tool must be listed under `does.tools`; an event under `watches.emits`. Anything else fails
  the module at start.
- Event names read `noun.past-verb`: `note.added`, `watcher.fired`.
- Event payloads never carry secrets. The log refuses anything that looks like one.
- Input is checked against the tool's schema before `run` sees it.
- Every call passes through the rules first, whether it came from Claude, the Deck or the CLI.
- If `start` throws, the module is marked failed and the rest keep running. `vyre modules` shows
  why.

## Test it

Use `test/helpers.js`: `tempHome(t)` gives each test its own `VYRE_HOME`, and `writeModule`
writes a module folder. Never point a test at the real `~/.vyre`.

## Where to go next

- [Module contract](module-contract.md): every manifest key and everything on `ctx`.
- [Tools and events](tools-and-events.md): naming, schemas and who may call what.
- [Modules reference](../reference/modules.md): the modules Vyre ships.
