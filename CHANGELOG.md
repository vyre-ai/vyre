# Changelog

Newest first. Every change to code lands here in the same commit. A new dependency says why.

## Unreleased

### Shared core for the parallel workstreams (2026-09-26)

- `ctx.vault.fetch(name)`: a module gets only the vault items its manifest declares, through the
  vault module's `vault.release`, an **internal** tool: callable only by modules, never listed,
  invisible to Claude, the CLI and surfaces.
- `ctx.memory.teach(kind, fact)`: only declared kinds; a no-op when Memory is not running.
- `GET /v1/events/stream`: server-sent events with backlog replay and `Last-Event-ID` resume,
  for the Deck, the Capsule and the Switchboard. Open streams no longer hold `stop()` open.
- vyred serves `deck/` for every non-API path, with a strict content security policy, and never
  a file outside `deck/`.
- `docs/design/`: the design boards and brand tokens, so every session builds from the same design.

### M2 · the Harness (2026-09-26)

- `harness/`: a Claude Code plugin. Load with `claude --plugin-dir harness`. Verified in real
  headless Claude Code sessions: the brief reaches Claude at SessionStart, MCP tools are callable
  (`mcp__plugin_vyre_vyre__<tool>`), and the vault rule denies a Read even when `--allowedTools`
  allowed it.
- Hooks are one runner (`harness/hooks/hook.js <piece>`) that calls vyred and prints Claude Code's
  JSON. With vyred down they print nothing, except the security floor, which runs in-process.
- `core/harness` module: `harness.brief`, `harness.enrich`, `harness.rules`, `harness.learn`,
  `harness.touched`, `harness.stop`. Brief and enrich compose `projects.*` and `memory.relevant`
  through `ctx.call` and return nothing when those modules are absent.
- Floor rules now enforced at PreToolUse: rule 8 (nothing reads the vault folder, by any path,
  relative or not) and rules 1 and 2 (an MCP tool that sends as the user asks first and names
  the destination; drafts and reads pass).
- MCP server with no dependencies: lists vyred's tools live (dots become underscores), forwards
  calls, starts vyred if needed.
- Skills: `write-a-watcher`, `use-the-vault`, `work-in-a-project`. Command: `/vyre`.
- Fix: a long `VYRE_HOME` made vyred fail with EINVAL (unix socket paths are capped near 104
  bytes). Such homes now use a private per-user `/tmp/vyre-<uid>/` folder, checked for owner and
  mode 0700 so no one else can plant a socket that poses as vyred.

### M1 · projects and memory

#### Contracts (main)

- Recall's tables are a published contract (`core/recall/schema.js`): a turn is identified by
  `(session, seq)`, never by FTS rowid.
- `ctx.call(tool, input)`: one module uses another's tool through the rules, as `module:<name>`.
- `ctx.paths`: the `~/.vyre` paths, for modules that keep files.
- CLI commands are one file each in `core/cli/commands/`, found at run time.
- `test/fixtures/corpus.js`: the fictional corpus every M1 module tests against.

#### Recall

#### Memory

#### Projects

### M0 · the skeleton (2026-09-26)

- `vyred`: one daemon per machine on a private unix socket (`~/.vyre/vyred.sock`, mode 0600).
  Refuses a second copy on the same home and clears a stale socket left by a crash.
- HTTP API under `/v1/`: `health`, `modules`, `tools`, `tools/:name`, `events`. Every response
  is `{data}` or `{error:{code,message}}`.
- Module loader: validates the five-verb manifest, starts modules in dependency order, and
  fails one module without taking the daemon down. A module can register only the tools and
  emit only the events its manifest declares.
- Every tool call, from any surface, passes through the rules hook before it runs.
- Event log in SQLite; names must read `noun.past-verb`; payloads that look like secrets are
  refused.
- Store: WAL and a 10 second busy timeout on every connection; module tables must carry the
  module's name; each migration runs once, in a transaction. The database files are mode 0600.
- `vyre` CLI: `status`, `up`, `down`, `modules`, `tools`, `call`, `version`.
- A hygiene test fails the build if shipped code names a real person or carries a key.
- No dependencies.
