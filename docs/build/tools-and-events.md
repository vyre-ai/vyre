---
title: Tools and events
summary: How a module offers tools with ctx.tool, uses other modules with ctx.call, and emits and hears events, with a complete worked example you can run.
audience: builders, agents
owner: docs
status: stable
---

# Tools and events

Modules talk to the rest of Vyre in two ways. A **tool** is something a module can be asked to do: Claude, the Deck, the Capsule, the CLI and other modules all call it the same way. An **event** is a fact about something that already happened, written to vyred's event log for anyone to hear. Tools are requests; events are news. This page covers both, from Sections 5 and 6 of the [spec](../architecture/spec.md), and ends with a module you can install and run.

The full contract, including every check the loader makes, is on [the module contract](module-contract.md).

## Offer a tool: ctx.tool

```js
ctx.tool("digest.files", {
  description: "Files one session changed, newest first.",
  input: { type: "object", required: ["session"], properties: { session: { type: "string" }, limit: { type: "integer" } } },
  run: async ({ session, limit = 50 }, { caller, thread }) => { /* return any JSON value */ },
});
```

- The name must be listed under `does.tools` in `module.json` and start with the module name.
- `description` is what Claude reads to decide when to call it. Say what it returns.
- `input` is checked before `run` sees it. A bad call gets `bad_input` with the reason (`input.session is required`).
- `run` returns the result, which the caller gets as `{ data }`. To fail, throw. An error with a short lowercase `code` reaches the caller as that code.
- The second argument holds what vyred verified about the caller: `caller`, and `thread`, `agent`, `peer` and `presence` when they were proved.

Optional fields limit who may call it: `callers` (an allowlist of caller kinds such as `cli`, `deck`, `mcp`, `module`), `internal` (modules only), and `presence` (a person must prove they are there; see [presence](../concepts/presence.md)).

One definition is reachable three ways:

```
vyre call digest.files '{"session":"<session id>"}'      # the terminal
POST /v1/tools/digest.files                              # a surface, over vyred's socket or the tailnet
mcp__vyre__digest_files                                  # Claude, through the Harness MCP server
```

## Use another module: ctx.call

```js
const r = await ctx.call("recall.search", { q: "Northwind Bakery invoice", limit: 3 });
if (r.error) { /* r.error.code, r.error.message */ }
else { /* r.data */ }
```

`ctx.call` never throws for a failed call. It resolves to `{ data }` or `{ error: { code, message } }`, exactly what an HTTP caller would get. The call is made as `module:<your name>`, goes through the same checks as any other caller, and is exempt only from presence (modules are code the user installed).

It is the only way to use another module. Never import another module's files.

On a Mac, `ctx.remote(tool, input)` does the same against the paired box, and resolves to `{ error: { code: "box_unreachable" } }` at once while the server is away, so you can fall back to local results.

On a server, six read tools can take in the paired Mac's rows: `projects.catalog`, `projects.list`, `recall.search`, `recall.sessions`, `recall.thread` and `threads.list`. A module gets them only when it passes `machines: "all"`; each row then carries `source` (`"box"` or `"mac"`) and `machine`. A Mac that is away answers `mac_offline` at once and the server's rows come back alone; `projects.catalog` and `projects.list` say which machines answered in `sources`. Without `machines: "all"` a module gets the server's rows, unlabelled. See [The server and the Mac](../concepts/box-and-mac.md#the-server-reads-the-macs-sessions).

Every built-in tool, with its input, is on [tools](../reference/tools.md).

## Emit an event: ctx.events.emit

```js
ctx.events.emit("digest.searched", { hits: 3 }, { thread });
```

- `type` must be listed under `watches.emits` and read `noun.past-verb`: `digest.searched`, `invoice.filed`, `watcher.fired`. Name what happened, not a command.
- `payload` is any JSON object. It must never carry a secret: the log refuses anything that looks like one (known API key prefixes, private keys, `"password": "..."` and similar) by throwing, because every module and the Deck can read the log. Leave out what the user typed, too.
- The third argument, optional, files the event under a `project` or a `thread` (a Claude Code session id), which surfaces use to filter the log.

Each stored event looks like this:

```json
{ "id": 42, "at": 1790457328512, "type": "digest.searched", "source": "digest",
  "project": null, "thread": "<session id>", "payload": { "hits": 3 } }
```

`source` is set by the loader to the emitting module. You cannot emit as someone else.

## Hear events: ctx.events.on and since

```js
const off = ctx.events.on("file.touched", e => { /* e.payload.path */ });
// "file.touched" one type · "file.*" every type whose first word is "file" · "*" everything
```

- A listener hears events from every module, as they are emitted, inside vyred.
- A listener that throws is ignored; it never stops the emitter or other listeners.
- A listener that also catches up with `since` (below) can see the same event twice. Write listeners so that the same event twice changes nothing.
- `on` returns a function that stops listening. Call it in your `stop()`.

`on` hears only what happens after it is called. To catch up on what happened while vyred was down, read the log from a cursor you keep:

```js
const missed = ctx.events.since(lastId, { type: "file.touched", limit: 200 });   // oldest first
```

Surfaces read the same log over HTTP: `GET /v1/events?since=<id>&type=<type>` for a page, or `GET /v1/events/stream` for server-sent events (`type` filters the same way; `since=latest` skips the backlog).

Every built-in event, with its payload fields, is on [events](../reference/events.md).

## A worked example

The `digest` module keeps a table of the files each Claude Code session changed, by listening to the Harness's `file.touched` event, and offers a quick look back through Recall. It uses all four pieces: `ctx.tool`, `ctx.call`, `emit` and `on`.

`~/.vyre/modules/digest/module.json`

```json
{
  "name": "digest",
  "version": "0.1.0",
  "description": "What each session changed, and a quick look back.",
  "requires": ["recall"],
  "does": { "tools": ["digest.files", "digest.recall"] },
  "watches": { "emits": ["digest.searched"] }
}
```

`~/.vyre/modules/digest/index.js`

```js
// @ts-check
export default {
  async start(ctx) {
    ctx.store.migrate([
      "CREATE TABLE digest_files (session TEXT NOT NULL, path TEXT NOT NULL, tool TEXT, at INTEGER NOT NULL, PRIMARY KEY (session, path))",
    ]);
    const put = ctx.store.db.prepare(
      "INSERT INTO digest_files (session, path, tool, at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (session, path) DO UPDATE SET tool = excluded.tool, at = excluded.at");

    // Every file change the Harness records. The same event twice writes the same row.
    const off = ctx.events.on("file.touched", e => {
      if (e.payload.session) put.run(e.payload.session, e.payload.path, e.payload.tool, e.at);
    });

    ctx.tool("digest.files", {
      description: "Files one session changed, newest first.",
      input: { type: "object", required: ["session"], properties: { session: { type: "string" }, limit: { type: "integer" } } },
      run: async ({ session, limit = 50 }) =>
        ctx.store.db.prepare("SELECT path, tool, at FROM digest_files WHERE session = ? ORDER BY at DESC LIMIT ?").all(session, limit),
    });

    ctx.tool("digest.recall", {
      description: "The three past turns most about a topic, from every Claude Code session on this machine.",
      input: { type: "object", required: ["q"], properties: { q: { type: "string" } } },
      run: async ({ q }, { thread }) => {
        const r = await ctx.call("recall.search", { q, limit: 3 });
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        ctx.events.emit("digest.searched", { hits: r.data.length }, thread ? { thread } : {});
        return r.data;
      },
    });

    return { async stop() { off(); } };
  },
};
```

What each part does:

- The table is named `digest_files`. `ctx.store.migrate` refuses a table that does not start with `digest_`.
- `requires: ["recall"]` makes vyred start Recall first, and fail `digest` with the reason if Recall is not running.
- The listener uses `ON CONFLICT ... DO UPDATE`, so a repeated `file.touched` does no harm.
- `digest.recall` turns a failed `ctx.call` into a thrown error with the same code, so its caller sees `bad_input` or `no_such_tool`, not a generic failure.
- The event carries the number of hits, not the query: what someone searched for is theirs, and the log is read by every module.

Run it:

```
vyre down && vyre up
vyre modules
```

Among the other modules:

```output
  digest               0.1.0    running
```

Then call it:

```
vyre call digest.recall '{"q":"Northwind Bakery invoice"}'
vyre call digest.files '{"session":"<session id>"}'
vyre call digest.files '{}'
```

The last call has no `session`, so it is refused before `run` sees it:

```output
  bad_input: input.session is required
```

In a Claude Code session with the Vyre plugin, Claude now sees `digest_files` and `digest_recall` among the `vyre` MCP tools.

## Next

- [The module contract](module-contract.md): every rule the loader enforces.
- [Writing a module](writing-a-module.md): tests with a temporary `VYRE_HOME`.
- [The MCP hub](mcp-hub.md): how tools reach Claude.
