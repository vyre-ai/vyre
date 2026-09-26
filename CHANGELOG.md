# Changelog

Newest first. Every change to code lands here in the same commit. A new dependency says why.

## Unreleased

#### Gate

- `core/gate`: the only way out for an agent (sections 7.7 and 11, floor rules 1 and 2). An agent
  calls `gate.request {kind: send|spend|delete, via, to, content}`; the item is held until a person
  approves the final content with `gate.approve {id, edited?}` or discards it with `gate.reject`.
  `gate.held`, `gate.get` (draft, final and a word-level diff) and `gate.senders` complete the set.
  A model never approves: every `mcp` caller is refused, and a module may approve only when
  `gate.approvers` in config.json names it (default `chat`, which checks the owner pressed the button).
- Senders are configured by the person in config.json: `gmail` (a hand-built RFC 822 message to the
  Gmail send endpoint) and `http` (exact-origin allowlist, `{{vault}}` only in headers or the body,
  redirects never followed). The credential is fetched from the Vault at the moment of sending
  (`needs.vault: ["per-sender"]`, each item granted to `gate`), or added by the owner's Vyre through
  `vault.relay` for a sender with a relayed pass, and results and errors are scrubbed of it.
- Events `gate.held`, `gate.released`, `gate.failed` and `gate.rejected` say what and where, never
  the content: a draft is the user's words and every module reads the log. A failed send returns to
  held with its error so the user can try again; two Sends at once send once.
- What the user changed before approving is taught to Memory as `draft.edited` (the recipient, the
  agent and the diff, keyed `gate:<id>`), the first of the Gate's learning signals (section 7.11).
- `gate.route` (internal) tells harness.rules to deny a sending MCP tool inside an agent's thread and
  point the agent at `gate_request`; the user's own sessions keep the interim ask-first rule.
- `gate.revise {id, edited}` changes a held item without sending it (event `gate.revised`, no
  content), and `gate.approve` takes the whole edited content, where an empty field clears it. Send
  sends exactly the latest revision, never the original; a changed `to` counts as an edit.
- An item left in "sending" by a vyred that stopped mid-send goes back to held on the next start,
  marked as possibly sent, so the person decides rather than the Gate sending twice.
- `core/harness`: harness.rules asks `gate.route` about a floor rule 1 send when the call comes from
  an agent's thread. Without the Gate running, the ask-first rule still applies.
- `core/modules`: `ctx.vault.fetch` accepts any `per-<thing>` declaration, not only `per-watcher`,
  so the Gate (`per-sender`) and agents (`per-agent`) can fetch items named at run time.

#### Chat

- Mattermost ships as a compose fragment for the box (`modules/chat/compose.yml`: 11.7 ESR, Postgres
  16, loopback only, sign-up and telemetry off), with an `mmctl` bootstrap in `SETUP.md` that pipes
  the bot and slash tokens straight into the Vault. Not yet run under Docker.
- `modules/chat`: Mattermost as a surface over the same real sessions (section 9). A channel per
  project and a thread per session; `thread.started`, finished text, what other surfaces typed,
  `ask.raised` and `gate.held` become posts, and answered or released ones are patched in place
  with their buttons gone. The owner's replies go to `threads.send` (taking the keyboard, and
  saying who had it), a root post starts a session in that project, and buttons call
  `threads.answer`, `gate.approve` and `gate.reject`. `/vyre held|send|discard|body|subject|new`
  covers the rest.
- A held post has no Edit button (the user's rule: edit inline, then Send sends exactly what is
  shown). It always shows the words Send will send: `/vyre body <id> <text>` and `/vyre subject`
  revise them and the post is patched in place, and "Edit in Deck" links to the Deck when
  `chat.deck` is set. The edit dialog is gone. Chat takes leases as `chat:<owner>`.
- Why polling and not the websocket: no dependency, nothing to reconnect after Mattermost
  restarts, and `since` turns a missed interval into a delay rather than a lost message.
- Only the configured owner is obeyed. Every button carries its id and a per-install hook
  secret, so a request that did not come from a post Chat made is refused even with a real id;
  the slash token is compared in constant time. The bot token is a vault item fetched per
  request through a thunk (the prototype's lesson), so it never sits in an object that gets
  logged; a test checks it is absent from events, logs, status, tables and posts.
- Unconfigured, Chat starts idle and `chat.status` names what is missing; Mattermost down is a
  `failed` state that retries, never a failed vyred.
- `package.json`: the test glob now includes `modules/**/*.test.js`.

#### Learning

- Drafts the user edited before approving are signals. Learning subscribes to the Gate's
  `gate.released` where `edited` is true and reads the draft and what was sent with `gate.get`;
  Gate does not know Learning exists. A banned-by-name character the user took out everywhere
  (an em dash, an en dash, emoji, semicolons) becomes a proposed lesson at remind, which the
  thread is told about once at its next prompt. Only a summary of the edit is kept, never the
  message.
- Fix: a command run in the same millisecond as a file change counted as after it, so a test
  run could clear a commit it did not follow. Commands now count only when strictly later.
- Lessons are checked with vyred down, as the floor is. Learning keeps the accepted lessons in
  `<home>/lessons.json` (mode 0600), rewritten on every change. When vyred does not answer,
  `hook.js` runs the tool and Stop checks in-process from it (`core/learn/offline.js`), keeping
  each thread's turn in `<home>/learn-offline/`. What it caught or saw broken is appended to a
  log that the learn module counts on its next start, escalation included. Offline, only lessons
  scoped to everyone or to this agent apply, since Projects is not there to place a folder.
  Verified in real Claude Code with vyred unable to start: an em dash reply sent back once and
  the final reply clean; a code-only turn sent back until it updated the changelog; both counted
  when vyred came back.
- `core/learn`: lessons Vyre learns from corrections and enforces with hooks, so a lesson is code
  rather than advice (section 7.11). Tools `learn.lessons`, `learn.add`, `learn.accept`,
  `learn.edit`, `learn.retire`, `learn.check {stage: tool|stop|brief}` and the internal
  `learn.signal`. Events `lesson.proposed`, `lesson.learned`, `lesson.caught`, `lesson.broken`,
  `lesson.escalated`, `lesson.retired`.
- A correction in a prompt ("never use em dashes", "update CHANGELOG.md whenever you change code",
  "run the tests before you commit", never say "X") is only proposed. Claude is told to ask, and
  the lesson is in force once the user says yes (`learn_accept`, or `vyre learn accept <id>`).
  Nothing becomes a lesson unseen. A free-text rule with no known shape becomes a reminder.
- Three check kinds: forbidden text (in the final reply at Stop, and in what Write or Edit is
  about to write), a required file changed in the same turn as code, and a command that must run
  before another. The Stop hook returns `{"decision":"block","reason"}` naming the lesson, at most
  twice a turn; then the turn ends and the lesson counts as broken, is repeated in the next
  prompt, and moves up a level (remind, ask, block) the second time.
- Hard to get around: retiring or editing a lesson from inside a turn, a command that reaches
  `vyre.db` or the socket directly, and `vyre down` all ask the user first, even when Claude
  Code's own permissions allow them.
- Harness changes, kept minimal: `harness.enrich` calls `learn.signal` (slash commands too, since
  every prompt starts a turn); `harness.rules` asks `learn.check` after the floor, which it can
  never loosen; `harness.stop` runs the Stop checks and returns the block; `harness.brief`
  appends active lessons. `hook.js` passes `prompt_id`, `stop_hook_active` and
  `last_assistant_message` (sent by Claude Code 2.1.283, confirmed with a probe) and prints
  Stop's answer at the top level. `tool.held` now carries `lesson`.
- `vyre learn [add|accept|retire|level]`, `/vyre remember <text>` and `/vyre lessons`.
- Verified in real headless Claude Code (haiku): an em dash reply was sent back once and the
  final reply had none; a turn that wrote code without the changelog was sent back and then
  updated it; `learn_retire` was held although `--allowedTools` allowed it.
- Fix during review: a correction without a check matched every other lesson without one, so a
  second free-text rule was never proposed.

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
- Vendored `deck/vendor/qrcode.js` (qrcode-generator 2.0.4, MIT, unmodified, one file) for the
  phone QR code in the onboarding: the Deck has no build step and loads nothing from a CDN, and
  a QR encoder is not worth writing. Named `.js` because vyred serves `.mjs` without a script type.
- `deck/test/world.js` and `deck/test/shoot.js`, test helpers only: a temp `VYRE_HOME` seeded with
  the fictional corpus, a real vyred, a loopback proxy to its socket, and headless Chrome
  screenshots that can click through a flow.

#### Vault

- `core/vault`: credentials sealed at rest, released one item at a time to a module holding a
  grant, and shared with other people's Vyre by pass, so a teammate who leaves has nothing to
  walk off with. How and why: `docs/adr/0001-vault-crypto.md`. No new dependencies: everything
  is `node:crypto` (AES-256-GCM, HKDF, scrypt, Ed25519, X25519).
- Sealing: a master key in the macOS keychain, a 0600 key file, or wrapped by a passphrase; a
  key per item, bound to the item's id and name so a sealed file moved to another item's slot
  fails to open. Values live in `vault/items/`; names, kinds, field names and hosts in vyre.db.
- Items: `secret`, `api-key`, `login` (with TOTP), `card`, `note`, `env-set`. Tools: `vault.put`,
  `list`, `delete`, `grant`, `revoke`, `pending`, `approve`, `inject`, `totp`, `generate`,
  `import`, `audit`, `match`, `unlock`, `lock`, `identity`, `pass.create`, `pass.list`,
  `pass.revoke`, `pass.accept`, `relay`, `offboard`, and the internal `vault.release`.
- Who may call what: giving access needs a person, taking it away never does. `vault.put`,
  `inject`, `approve` and `unlock` refuse Claude and are left out of its tool list; Claude's
  grants and passes wait as pending until `vyre vault approve`. A module may `vault.put` new
  items or its own (`{name, value}` is shorthand for one field) and grant only those, which is
  how onboarding stores the Claude credential. Every release, refusal and relay
  is an audit row with names only.
- Passes: relayed by default (the holder's signed request goes to the owner's relay listener,
  which adds the value, only for the item's own hosts, with redirects off, and scrubs the value
  from the reply); sealed on request (encrypted to the holder's device key; revoking marks the
  items "rotate"). `vault.offboard` revokes everything a person holds and lists exactly what they
  received sealed. Verified between two vyred processes in two temp homes.
- Import from `.env`, 1Password CSV, Bitwarden CSV and JSON, Chrome and Safari CSV. vyred reads
  the file itself, so values never pass through Claude; the file is left alone and the user is
  told to delete it.
- `vyre vault`: `put` prompts without echo (and refuses a value on the command line), `run <item>
  -- <cmd>` puts values in one child's environment and scrubs them from its output, plus `list`,
  `grant`, `pass create/accept/revoke`, `relay`, `offboard`, `totp`, `generate`, `import`,
  `audit`, `card`, `unlock`.
- Tests prove no value appears in events, logs, `vault.list`, the audit trail, the MCP server's
  tool list, the HTTP API or any file under either home. Under `node --test` the keychain
  keystore refuses the login keychain; its own test uses a temporary keychain.
- Shared core, kept small:
  - vyred no longer trusts a `module:` caller claimed over HTTP, which let anything on the socket
    call internal tools such as `vault.release`.
  - A tool may declare `callers`; other callers are refused and do not see it in `/v1/tools`.
  - `ctx.vault.fetch(name, { field, watcher })`, and `needs.vault: ["per-agent"]` alongside
    "per-watcher", for the agents module, whose item names differ per agent.
  - The daemon client no longer pools connections: the first call after a vyred restart failed
    as "unreachable".
  - Rule 8 also denies shell commands that print the Vault's keychain item.

#### Watchers

- `core/watchers`: the watcher runtime (spec 7.6). Claude writes a folder in
  `~/.vyre/watchers/<name>/` through the write-a-watcher skill; the runtime runs it. Tools:
  `watchers.list`, `watchers.test`, `watchers.create`, `watchers.pause`, `watchers.resume`,
  `watchers.logs`, `watchers.items`. Events: `watcher.created`, `watcher.fired`, `watcher.failed`,
  `watcher.paused`, `watcher.resumed`. No Gmail, Slack or other integration ships with it; that is
  the point.
- Every run is a child process with no inherited environment, a timeout (60s default, 300s at
  most), and Node's permission model: read access to its own folder only, no writes, no child
  processes. Measured: reading another file, writing, spawning and reading the parent's env all
  fail inside a watcher.
- Vault items reach a watcher only through `vault.fetch` for names in its own `needs`, checked by
  the runtime, which declares `needs.vault: ["per-watcher"]`. A released value is scrubbed from
  logs and errors, and an item that carries one fails the run, because items are filed and taught.
- `watchers.create` turns on exactly what the last successful dry run ran (a hash of both files).
  An edit afterwards pauses the watcher until it is dry-run and created again, so a watcher cannot
  widen its `needs` or change what it does without the user seeing it.
- Items are deduped by `id`, filed as `watcher.item` rows in the project, and taught to Memory
  with `project_cwds` set to the project's folders, so they appear in that project's
  `memory.facts` and no other. Without the project's folders they are filed but not taught, so a
  client's items never become a fact for everywhere.
- Cursor: `since` is what `watch` returned, or the start of the last successful run. Failures
  retry after 30s and 2m; the third in a row pauses the watcher and says why.
- A small cron parser (five fields, steps, ranges, lists, `@hourly` style shorthands), which
  refuses a step past the end of its field: `*/120` in minutes means minute 0, which is never what
  was meant. Claude wrote exactly that in a real session.
- Webhooks: a watcher with schedule `webhook` gets `POST /v1/watchers/<name>/hook` with a token
  made at create, checked in constant time; the JSON body reaches `watch` as `hook`. Calls that
  arrive mid-run are queued, not dropped.
- `vyre watchers [test|create|pause|resume|logs|items] [name]`.
- Shared core, kept minimal: the registry gains `hook: true` tools (reachable only as caller
  `hook` through vyred's new `POST /v1/<module>/<name>/hook` route, never listed or offered to
  Claude). Nothing else outside `core/watchers/` changed.
- The write-a-watcher skill, rewritten from five real Claude Code sessions (Haiku, Harness loaded):
  it now loads before Claude asks questions, beats `/loop`, calls `watchers_list` for the folder
  instead of guessing `~/.vyre` (one session wrote there), calls the MCP tools directly rather
  than from a shell, never runs `watch.js` with plain `node`, fetches in parallel, logs what it
  read, and does not widen a filter to manufacture items.

#### Capsule

- `local/capsule/`: the Capsule. Press Control twice anywhere on the Mac, and a command bar
  opens over the current app with the caret in it. By default you talk to the assistant.
  `@` completes agents, projects and threads from the running vyred, and a "Sends to" row shows
  the destination before anything is sent (floor rule 2). A question gets an answer from memory
  as you type, in Recall gold, with its sources; Enter shows the source turn (floor rule 7).
  Gate holds and open permission asks wait in one Beacon list, oldest first (press ↑). A hold
  opens for review: send, edit, discard, allow or deny. A reply streams back from the thread it
  went to. Ported from the prototype's floating panel and rebuilt against the Capsule board.
  The prototype's workbench window is left behind: the Capsule is the command bar.
- The Capsule talks to vyred only through its API over the socket (`lib/vyred.js`, the same
  `{ data } | { error }` shape as `core/daemon/client.js`), in the main process. The window is
  sandboxed with no Node. Everything that decides meaning (what `@` completes, where Enter sends,
  how a destination reads) is in `lib/route.js`, and the page asks for it, because the
  prototype's second decision path made one sentence mean two things.
- The switchboard's `agents.*` and `threads.*` and the Gate's `gate.*` are used by their spec
  names. Which of them exist is read from `/v1/tools`, and each missing feature says so in words
  before Enter, not after. Open asks come from `threads.asks` when it exists, and otherwise from
  the event log.
- Lessons carried over from the prototype: the window is an NSPanel at screen-saver level on
  every Space, so it opens over a fullscreen app. An agent's question never opens the Capsule or
  takes the keyboard; it turns the menu-bar dot Beacon (floor rule 6). Escape hides the window
  and hands the keyboard back to the app that had it. The event stream is followed in the main
  process, because a hidden window's timers are throttled. When vyred goes away, everything from
  it is cleared and the Capsule says it is offline. There are no infinite animations.
- Fix, found on this Mac: with another app active, focusing the panel alone did not make it
  key, so typed keys reached neither app. On the user's gesture the Capsule now takes the
  keyboard (`app.focus({ steal: true })`), and `app.hide()` gives it back on close. Verified with
  real key events over TextEdit.
- `swift/hotkey.swift`: the double-Control listener, run as a child of the Capsule and read over
  stdout, so the gesture works with vyred down. It re-arms a tap macOS disables, exits when its
  parent dies, and reports a missing Input Monitoring grant in words. `--check` prints what
  macOS allows; `--simulate` posts a real double-Control through the system, for tests.
- `swift/launcher.swift` (`vyre-launcher`): one macOS identity for vyred, so Accessibility is
  granted to Vyre alone rather than to every shell. `build.sh` compiles both into
  `local/capsule/bin/`, ad-hoc signed.
- `vyre capsule` opens it and starts vyred if needed. `vyre capsule --dev` runs it from source in
  the terminal. `vyre capsule build [--app]` builds the helpers, and with `--app` packages
  Vyre.app with a stamp of its source hash. `vyre capsule` runs the package only while that
  stamp matches the source, and otherwise runs the source and says why, because a packaged app
  runs `app.asar` and ignores every edit silently.
- The `capsule` module (role `local`): `capsule.status`, and `capsule.show {action}`, which emits
  `capsule.requested` so the assistant, the CLI or a phone can open the Capsule. `capsule.autostart:
  true` in config.json starts the app hidden with vyred. It is off by default, so a vyred started
  for a test or over SSH never opens a window.
- Dev only: `VYRE_CAPSULE_DRIVE=1` with `--dev` reads JSON commands on stdin and sends keys into
  the Capsule's own window, and saves window-only screenshots. Typing through System Events goes
  to whatever app is in front; during testing it typed four characters into a terminal.
- Dependencies: `electron` and `@electron/packager`, devDependencies of `local/capsule/` only,
  never the root package. Fonts: Instrument Sans and JetBrains Mono (both SIL OFL 1.1, licences
  beside them) are bundled in the app, so it looks the same with no network (floor rule 9).
- `local/hands-mac/`: computer use on macOS through the accessibility tree, as the module
  `hands` with `hands.observe` and `hands.act`. Every act is verified by observing again. An
  action the accessibility API accepted is not counted as done until the re-read shows it.
  Secure fields never show their value, and `hands.acted` events carry the action and selector,
  never the typed text. Verified for real on TextEdit (set and type) and Calculator (press).
- Shared core, kept small: `GET /v1/health` returns `last_event`, so a surface can follow the
  stream from now. `since=0` replays the whole log, and a guessed cursor past the end drops live
  events. `npm test` now runs `local/` tests. The hygiene scan now covers `.swift` and skips build
  output (`dist/`, `bin/`).

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
- Dense retrieval (`core/recall/dense.js`). Search could only re-rank turns that shared a word
  with the question, so "making it easier for blind visitors" never reached an accessibility
  audit, which contradicted the measurement the spec quotes (dense retrieval won). Every vector
  now sits in one in-memory array, built on the first hybrid search and dropped after a pass
  writes. A brute-force dot product adds the nearest 200 turns to the pool, filtered by role and
  project folder.
- A dense hit needs a minimum cosine, so nonsense still returns nothing, and the minimum rises
  with the corpus because the best score noise reaches does (about sqrt(2 ln n)). A fixed 0.25,
  right for the 16-turn fixture, let every nonsense query through on the real corpus: "asdf
  qwerty" had 287 chunks above it. Measured with the real model: fixture nonsense at most 0.186
  against real matches 0.339 and 0.473; the real corpus (36,878 chunks) nonsense at most 0.413
  against the weakest real question's best 0.476. The floor is 0.276 and 0.444 there, capped at
  0.45. On the real corpus every test question gets dense candidates and no nonsense query does.
- The dense index builds in pages in the background once embedding finishes. The first hybrid
  search on the real corpus went from 3.3s to 83ms.
- Rankings now merge by reciprocal rank. A blend of keyword position and cosine let hundreds of
  one-common-word matches bury a turn that meaning alone had found. The pinned half now comes
  from the strict keyword pass (the query as typed), which is where exact matches live.
- A rewrite bumps a generation number in `recall_meta`, and the dense index rebuilds when it
  moves. Without that, a stale snapshot scored a (session, seq) that now held different text.
- `recall.status` and `vyre status` say "downloading the search model (23 MB, once)" while the
  first download runs.
- Dependency: `@huggingface/transformers`, optional, because it is the only way to run the
  embedding model locally from Node; without it search is full-text and says so.

#### Memory

- `memory.graph {project_cwds?, around?, depth?, limit?, since?, agent?}`: the graph as a floor
  plan for the Deck. One room per project (from `projects.list`), a Shared room for the people
  and organisations several projects have, and a No project room; entity, thread and fact nodes;
  capped (entities, then taught facts, then two recent threads each); `around`/`depth` for one
  node's neighbourhood. `updated` is a durable cursor (`memory_meta.graph_version`) that moves
  when a derive writes something or a pin or mute changes; `since` returns `{unchanged: true}`.
  `memory.curated` now carries `updated`.
- Project graphs are strict (SPEC 7.4): with `project_cwds`, facts, relevant, why and the floor
  plan use only that project's sessions and the lessons taught for it (or for everywhere). A
  fact another client's sessions established is not shown, not cited as a source, not counted,
  and not even found by name; a closing date only another project's sessions give is left off.
  Folder matching is exact (it used SQL `LIKE`, which ignores case).
- The main graph is for the user and the assistant. A named agent (in the caller as
  `agent:<name>`, or `input.agent`) is checked against `agents.list`: an agent granted every
  project sees it, any other sees only its projects' graphs, and when agents cannot be checked
  it is refused. `memory.graph` without a scope is drawn only for the Deck, the CLI, modules and
  verified all-projects agents. `memory.stats`, `curate`, `pin` and `mute` are guarded too.
- Measured on a copy of a 108k-turn index with 12 projects: main graph 70ms, one project 150ms,
  `around` 50ms, an unchanged poll under 1ms.

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
