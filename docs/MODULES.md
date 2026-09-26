# Writing a module

A module is a folder with a `module.json` and an `index.js`. Put it in `~/.vyre/modules/` and
restart vyred. The contract is in section 5 of [`SPEC.md`](SPEC.md); this page is the short way in.

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

```
vyre down && vyre up
vyre call notes.add '{"text":"call the printer people"}'
```

## The rules the loader enforces

- Tool names start with the module name: `notes.add`, never `add`.
- Tables start with the module name and an underscore: `notes_items`.
- A tool must be listed under `does.tools`; an event under `watches.emits`. Anything else fails
  the module at start.
- Event names read `noun.past-verb`: `note.added`, `watcher.fired`.
- Event payloads never carry secrets. The log refuses anything that looks like one.
- Input is checked against the tool's schema before `run` sees it.
- Every call passes through the rules first, whether it came from Claude, the Deck or the CLI.
- If `start` throws, the module is marked failed and the rest keep running. `vyre modules` shows why.

## Tests

Use `test/helpers.js`: `tempHome(t)` gives each test its own `VYRE_HOME`, and `writeModule`
writes a module folder. Never point a test at the real `~/.vyre`.
