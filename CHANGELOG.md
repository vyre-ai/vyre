# Changelog

Newest first. Every change to code lands here in the same commit. A new dependency says why.

## Unreleased

#### Deck

- The onboarding (`deck/onboard/`), the first screen after `vyre up`: six steps, one a screen,
  each skippable, with live progress for the Claude sign-in, Tailscale sign-in, the address and
  history indexing, and a project picker over the session catalogue. It calls `onboard.*` (box
  stream) and answers from fixtures until those land. The one-time token is taken out of the
  address bar and kept for the tab only. Its board, `docs/design/boards/Onboard.dc.html`, is
  built from the rendered steps so the two cannot drift.
- The Deck's foundation: one stylesheet of the tokens (dark, and paper for the light theme), a
  small `h()` helper that only ever makes text nodes from strings (there is no `innerHTML` in
  the Deck, so thread text cannot become markup), and one API client. Tools that other streams
  have not merged answer from `deck/fixtures/*.json`, only with `?fixtures=1` and only when the
  live tool is missing; otherwise the view names the module that is not running.
- The shell and **Now**: header with the address, search over every turn (Recall, with ⌘K and
  arrow keys), the needs-you pill; the rail with pinned or recent projects and the machine it runs
  on; a bottom tab bar under 760 px. Now shows drafts held at the Gate and open asks in Beacon with
  their actions, running threads, and what memory learned today in gold with pin and mute. When
  nothing runs it lists the latest sessions, so Now is never empty. Views load one at a time from
  `deck/views/`, each with its own stylesheet.
- The Deck installs as an app on a phone: a manifest, the app icon, and a service worker that
  caches only the Deck's own files, network first, and never an API response.
- **Projects**: every project with pins, a new-project form, and the project board: threads
  (recorded sessions from Recall merged with live switchboard threads), the brief, and the thread
  itself, with tool lines, recalled memory in gold, held calls in Beacon with their answers, and a
  composer that takes the keyboard lease first and goes read-only when another screen holds it.
  The files pane lists what a thread touched; file contents have no API yet, and it says so.
- **Memory**: a map of each project's facts drawn as inline SVG, a list, and a fact panel with
  its source turns quoted from the threads they came from, pin, mute and forget (mute everywhere,
  with undo). Everything on it came from memory, so it is the one view where gold is the norm.
- **Agents**: the assistant and every agent, a new-agent form that picks credentials by Vault
  item name only, and the agent page: its job, what wakes it (watchers with on/off switches), its
  model and effort, a way to talk to it (`agents.ask`), and its computer with the pool screen and
  limits. Each part says which module is not running when it is missing.
- **Vault**: items by name, who holds each, what used it today, passes to and from other
  people's Vyre, and offboarding. No value is ever shown: values only go in, through password
  inputs that are read once and cleared before the call is sent, and the view keeps only the named
  fields it draws from every response.
- **Settings**: every onboarding step with its state and a way to finish it, the assistant,
  Claude Code and network status, history and memory with re-index and rebuild, lessons from
  Learning with edit and retire, the modules vyred runs, dark or paper, and this machine.
- **Phone views**, checked at 360 and 390 px: one held item full screen (`/needs/:id`), either a
  question with what it changes and Allow once / Always in this project / Deny, or a draft held
  at the Gate with its recipient, subject, the words that came from memory numbered against their
  sources, and Send / Edit / Discard fixed above the tab bar. **Ask** (`/ask`) talks to the
  assistant or any agent with @-chips, and shows an answer that came from memory as memory, with
  its sources and the time it took, and an "Ask a model" to go further. Every view fits 360 px
  without sideways scrolling.
- `/agents/:name/glass` loads Glass from `deck/glass/`, which the computers workstream builds, and
  says plainly that it is not here until then.
- Vendored `deck/vendor/qrcode.js` (qrcode-generator 2.0.4, MIT, unmodified, one file) for the
  phone QR code in the onboarding: the Deck has no build step and loads nothing from a CDN, and
  a QR encoder is not worth writing. Named `.js` because vyred serves `.mjs` without a script type.
- `deck/test/world.js` and `deck/test/shoot.js`, test helpers only: a temp `VYRE_HOME` seeded with
  the fictional corpus, a real vyred, a loopback proxy to its socket, and headless Chrome
  screenshots that can click through a flow.

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

- The embedding package is now installed on main (the user approved the one-time download of the
  23 MB model from Hugging Face; nothing about the user is sent). `package-lock.json` is committed
  so installs resolve the same versions.

- `core/transcripts`: the one adapter that reads Claude Code transcript files. It lists
  sessions and subagents (`<parent>/agent-<id>`), and when one session id has two files (a
  resume from another folder, an archive copy) the fullest wins, so they cannot take turns
  looking changed. It reads turns, the last `/rename`, the real cwd from the lines, and whether
  a person started it (not a subagent, not an SDK run). Tool traffic, thinking and lines Claude
  Code injects (`isMeta`) are not turns. It never throws over a bad file or line.
- The redactor is ported and runs before any text leaves the adapter: turns, titles and names.
  Placeholders keep the kind and last four characters, so "rotate the billing token" still
  finds the conversation.
- `recall` module: indexes on start and every `recall.every` minutes (default 5) in the
  background, one pass at a time, yielding between files so vyred keeps answering. Indexing is
  append-only: a grown transcript appends its new turns and keeps every vector; a rewritten one
  is indexed again from scratch; an unchanged size and mtime is not read. History outlives the
  transcript: a deleted file keeps its rows.
- Vectors are optional. With the model, turns are embedded one at a time (batching was slower
  and changed the numbers), in 900-character chunks with 200 of overlap, and a vector is written
  only if its turn still holds the text it was made from.
- Search pins the top half of the keyword answer before blending in meaning, so hybrid never
  loses an exact match; any failure of the model ends in the keyword answer. FTS5 grammar a
  person did not mean (a hyphen, half a parenthesis) falls back to the literal phrase.
- Tools `recall.search`, `recall.thread`, `recall.sessions`, `recall.index`, `recall.status`;
  event `session.indexed`; commands `vyre recall <query>` and `vyre index`.
- Under `node --test`, Recall refuses to read the real `~/.claude`, whatever the config says, so
  a test that starts vyred with default settings cannot index someone's conversations.
- Dependency: `@huggingface/transformers`, optional, because it is the only way to run the
  embedding model locally from Node; without it search is full-text and says so.

#### Memory

- A taught fact can carry `project_cwds`, the project's folders. `memory.facts {project_cwds}`
  includes facts taught for that project (a folder equal to or under one asked for, the rule
  sessions follow) even when no session of the project names their subject, and leaves out
  facts taught only for other projects; `memory.relevant` applies the same rule. A fact taught
  without folders belongs everywhere and keeps the stored form and key it had before.

- Short forms are measured per identity, not per spelling. One firm written several ways
  ("Harlow Legal", "Harlow Legal Group") shares a domain, so its spellings are pooled and the
  result is credited to the most-seen one. On the real index one firm's spellings measured 0.57,
  0.29 and 0.21 apart, so "the Harlow team" found nothing although the word meant that firm
  every time; pooled, it clears the bar. The bar itself (0.6, two sessions) is unchanged, and a
  common word that starts a name ("park" for Park Dental) still measures far below it.

- `memory.teach {kind, fact, from}`, the internal tool behind `ctx.memory.teach`: only modules
  can call it, and the lesson is recorded under the calling module the loader names, never the
  `from` it claims. A fact is graph-shaped (`subject`, `rel`, `object`, `text`, `at`, `key`,
  `forget`) and lands on the same nodes the transcripts build. Its provenance is
  `{module, kind}` (table `memory_lessons`) where a transcript fact has `(session, seq)`, so
  `memory.why` names the module that taught it, and a fact with no supporting turn has
  `source: "taught by <module>"`. Teaching the same fact twice changes nothing; an explicit
  key replaces; `forget` removes it. A taught `works_at` is a strong vote, not an override.
  Taught facts make a graph even with no Recall index.
- Facts now include every relation except `mentioned_in`, so taught relations and notes show in
  `memory.facts` and `memory.relevant`.
- The first derive after vyred starts no longer blocks the event loop for about 600ms on a
  large corpus: the rowid map and the observations are read in pages with a yield between
  pages. Measured on a copy of a real 103k-turn index: worst block 70 to 120ms.

- `core/memory`: the graph and the curator, the only writer of `memory_*` tables. It reads
  Recall's tables and never runs a model. Each turn is read once by `(session, seq)` into
  observations; the graph (people, organisations, addresses, domains, repos, who works where,
  learned short forms) is derived from those and written as a difference, so a second pass
  over the same turns changes nothing.
- Edge `valid_from` is `NOT NULL`, 0 meaning atemporal. A NULL inside the unique key is what let
  the prototype append a copy of every edge on each run.
- `works_at` is voted by focus (a session's share of its organisation mentions), plus explicit
  phrasings ("Sam Okafor at Northwind Bakery") and addresses at an organisation's domain. Tools,
  hubs and the user's own organisation (from `config.me`) get no vote, because each of them
  outvoted real clients in the prototype. A move closes the old edge where the new one starts.
- Short forms ("Harlow" for Harlow Legal) are learned by measuring their precision over Recall's
  full-text index, and used only at 0.6 or above.
- Tools: `memory.facts`, `memory.relevant` (for the M2 Enrich hook), `memory.why`, `memory.pin`,
  `memory.mute`, `memory.curate`, `memory.stats`. Emits `memory.curated`; listens to
  `session.indexed` and drops a rewritten session's observations before reading it again.
- Curation runs in the background on start and shortly after each `session.indexed`, yielding
  to the event loop. With no Recall tables the module starts and answers with nothing.
- `vyre memory [about]` and `vyre why <fact>`, in the Recall gold.
- A fact's `source` is a readable label (the thread's name) and `age` is in words ("3 weeks"),
  which is what the Enrich hook and the projects brief print; the exact turn is in `ref`.
- Measured on a copy of a real 103k-turn index: first pass 6.7s, a pass with nothing new 5ms,
  one new turn 1.2s in the background; `memory.relevant` p50 0.06ms, p95 1.4ms.

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
- The `vyre` home (spec section 10): `vyre` with no arguments, from any folder, lists every
  project (threads, last activity), New session without a project (`claude` with the Harness in
  this folder), and every agent from `agents.list` ("agents arrive with the switchboard" until
  that tool exists). A project opens to its sessions, newest first, plus New session in it; a
  session resumes. Inside a project's folder that project is preselected, not opened. It is an
  arrow-key list with type-to-filter on raw-mode stdin, with no dependencies and plain ANSI, so
  it works over SSH. Enter picks, Esc clears the filter or goes back, and q quits (while
  filtering, q is a letter). Piped, it prints the same list and exits. The list logic is pure
  and tested directly; the flow is tested through stand-in terminal streams with a fake
  `claude`, and was run once through a real pseudo-terminal.
- The catalogue was taking 2.6 seconds per call on a real 614-session index, with or without a
  search, because it resolved every session's folder through realpath. Most of those folders no
  longer exist, so each lookup walked up the parents failing at every step. Session folders are
  now used as recorded, since Claude Code already writes real paths. A search takes 17 to 30 ms,
  with one `recall.search` call (limit 100, Recall's cap), and a test bounds both the Recall
  calls and the path lookups.

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
