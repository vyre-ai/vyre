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

- Integration on main: `vyre resume` and `vyre start` load the Harness with `--plugin-dir` and
  leave the brief to its SessionStart hook, so Claude reads it once. `VYRE_PROJECT` tells the
  hook which project was chosen, for a thread picked into several. `harness.brief` now asks
  `projects.context {cwd, session}` directly, the shape Projects actually offers. Verified with
  real Claude Code: a project made with `vyre new` briefed a session started in its folder.

- `core/projects`: a project is `<home>/.vyre/project.json`. The marker is the truth and
  `projects_projects` only caches where each home is, so a project outside the configured roots
  is still found and a hand-edited marker is followed. Paths in the marker are relative to the
  home.
- Projects are made by hand. A thread belongs because a person picked it (kept in the marker,
  never removed automatically) or because it ran in one of the project's folders (worked out on
  every read, so a folder added to a marker brings its sessions with it). A thread can be in
  several projects: a hub session picked into two clients belongs to both. Auto-sorting by
  content was dropped because it filed hub sessions under whichever client they named most.
- The catalogue lists every session in Recall's index with its /rename name, first message,
  folder, last activity and projects; subagents fold into their parent. Search matches names,
  first messages and folders, and what was said through `recall.search`; without Recall it
  searches titles only and says so.
- The brief (`projects.context`) is plain text for Claude, capped at 2,400 characters, cut at a
  line break, from one project only. It asks Memory for facts about the project's own folders
  only, never a picked hub's folder, which would pull in other projects' facts. A thread picked
  into several projects and started outside all of them gets no brief rather than a guess.
- Folders are compared by real path. A home typed as `/var/...` never matched a session
  recorded as `/private/var/...` on macOS.
- Tools: `projects.list`, `create`, `add-threads`, `remove-threads`, `catalog`, `of`, `threads`,
  `context`. Events: `project.created`, `project.changed`, `thread.picked`, `thread.unpicked`.
- CLI: `vyre` alone opens this folder's project or lists them; `vyre projects`, `new`, `open`,
  `threads`, `resume`, `start`, `context`, `pick`, `unpick`. `vyre resume` runs
  `claude --resume <id>` in the folder the thread ran in with the brief as
  `--append-system-prompt`; `vyre start` runs `claude -n <name>` in the project home. Every
  prompt has a flag, and prompts read piped stdin a line at a time.
- Every thread Vyre launches loads the Harness with `--plugin-dir` when this install has one,
  and then leaves the brief to its SessionStart hook, so Claude never reads it twice.
- `projects.of` returns `{slug, name, home, folders}`, the shape the Harness calls it with.

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
