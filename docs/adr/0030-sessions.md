---
title: "ADR 0030: Vyre-owned sessions and the provider router"
summary: Vyre runs the sessions it starts through the Claude Agent SDK behind a provider router, so Claude Code now, and Codex and ACP agents later, share one session and event model, one ask path and one set of surfaces.
audience: builders, agents
owner: docs
status: draft
---

# ADR 0030: Vyre-owned sessions and the provider router

Status: accepted, 27 Sep 2026 (steps 1 to 3 built) · Workstream: sessions · Related: ADR 0004 (presence),
ADR 0020 (the plugin), ADR 0021 (the box reads the Mac), ADR 0024 (chat), ADR 0026 (relay),
ADR 0029 (resilience) · Spec: principles 1 and 3, sections 7.8, 8, 10 and 11

## Context

Vyre runs Claude Code in two ways today.

- **Headless threads.** The Switchboard spawns `claude -p` with stream-json in and out
  (`core/switchboard/runner.js`), writes user lines to its stdin, maps its stdout in
  `translate.js`, and answers permission questions over the stdio control protocol. That protocol
  is the one the Agent SDK speaks: the flag that turns it on, `--permission-prompt-tool stdio`, is
  not in `claude --help`, and the spec lists it as a known risk.
- **Terminal sessions.** The user runs `claude` (or `vyre start`) in a terminal. Vyre follows it
  through the Harness plugin: SessionStart binds the pid and injects the brief and the about-you
  note, UserPromptSubmit injects memory, PreToolUse runs the floor, Stop delivers queued words.
  Claude Code's own TUI asks permission. Vyre never sees those questions.

What depends on this, found by reading every module (the full list is under Migration):

- The Switchboard's lifecycle (`launch`, `send`, `write`, `answer`, `stop`, `fallback`,
  `recover`), its `threads_runs` rows and its events (`thread.started`, `thread.text`,
  `thread.tool`, `thread.finished`, `thread.limit`, `thread.queued`, `thread.sent`,
  `thread.stopped`, `ask.raised`, `ask.answered`, `ask.cancelled`).
- The ask path: `can_use_tool` becomes an ask row (a 9-byte capability id), a person answers
  with `threads.answer` (PERSON_ONLY, refused from the ask's own thread), and "Always in project"
  rewrites Claude Code's permission suggestions to a `localSettings` rule.
- The daemon's peer check (`core/daemon/peer.js`): a PERSON_ONLY call is refused when any
  ancestor of the calling process is `claude` or a pid in `threads.pids`.
- Terminal adoption and the second writer (`sessions.js`, `adopt.js`, `claim.js`, the inbox).
- Recall, the Chat rich view and memory curation, which read `~/.claude/projects/*.jsonl`.
- Agents (`--append-system-prompt` preamble, a credential in the child env, a budget), learning
  jobs (`once`, `tools: "none"`, no plugin), the Capsule, the Deck, the CLI, push and the status
  line, which only see `threads.*` tools and events.
- Federation (ADR 0021): the box forwards `threads.send` to the Mac; `threads.answer` is not
  forwarded yet.

The user decided: Vyre owns the sessions it starts, through the Claude Agent SDK, behind a
provider router, so that Claude Code, then Codex, then agents speaking the Agent Client Protocol
(ACP) work through one session model. [Paseo](https://github.com/getpaseo/paseo) (Apache 2.0)
does this, and we read its provider layer closely (below). Sessions the user starts in a
terminal stay plain `claude`, followed by the plugin as today, and the two kinds share
transcripts, so either can resume the other.

## What we learnt

### From the SDK itself (`@anthropic-ai/claude-agent-sdk` 0.3.283)

- The SDK does not run the model in process. It spawns Claude Code (a bundled native binary,
  231 MB on linux-x64, or `pathToClaudeCodeExecutable`) and speaks the same stream-json and
  control protocol our runner already speaks. Captured argv on testbox:
  `--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio
  --setting-sources=user,project,local --permission-mode default --include-partial-messages
  --session-id=<uuid>` (and `--resume=<id>` on resume). No `-p`. The system prompt append,
  hooks, in-process MCP servers and agents travel in the `initialize` control request.
- So moving to the SDK does not change the process model or the transcripts. It moves the
  undocumented part of the protocol behind a supported, versioned API, and it adds what we
  cannot do from a bare CLI: in-process MCP tools (`createSdkMcpServer`), in-process hook
  callbacks, `canUseTool` with a title, display name, blocked path and the MCP server's
  `source` (`sdk` means one of ours; key trust on it, never on a tool name), `interrupt()`,
  `setPermissionMode()`, `setModel()`, `applyFlagSettings()`, `rewindFiles()`, `prewarm()`,
  `forkSession()`, `listSessions()`, `getSessionMessages()` and a pluggable `sessionStore`.
- `canUseTool` returning a promise is the whole permission contract. A signal aborts it. A
  deny can carry `interrupt: true`. An allow can carry `updatedInput` (question answers go
  there) and `updatedPermissions` (the "always" rules).

### From Paseo (`reference/paseo/packages/server/src/server/agent/`)

- Two layers: an `AgentClient` per provider (create, resume, catalog of models and modes,
  importable sessions, availability) and an `AgentSession` per conversation (`startTurn`,
  `subscribe`, `steerActiveTurn`, `respondToPermission`, `interrupt`, `setMode`, `setModel`,
  `describePersistence`, `close`).
- One stream of events per session, each tagged with a turn id: `turn_started`,
  `turn_completed`, `turn_failed`, `turn_canceled`, `usage_updated`, `mode_changed`,
  `permission_requested`, `permission_resolved`, `attention_required` and `timeline` items
  (user and assistant text, reasoning, tool calls, todos, compaction, errors).
- A tool call is one item keyed by its call id and re-emitted with a status (`running`,
  `completed`, `failed`, `canceled`), not separate start and result events.
- Permissions and questions share one channel: `kind` is `tool`, `plan`, `question` or `mode`,
  held in a promise map keyed by request id.
- The Claude provider keeps one long-lived `query()` per session, fed by a push queue, and only
  recreates it (with `resume`) after a crash, a rewind or a thinking change. It tree-kills the
  child because ending input leaves MCP grandchildren behind, suppresses the stale `result` that
  follows an interrupt, strips `CLAUDECODE` and friends from the child env, and does no auth of
  its own.
- Codex runs as `codex app-server` over JSON-RPC; its approvals are server-to-client requests.
  ACP agents run over `@agentclientprotocol/sdk`; `session/request_permission` becomes the same
  permission request.
- Where we differ: Paseo's timelines live in daemon memory and its surfaces trust the socket.
  Vyre keeps every event in its durable log (ADR 0029), and answers are person-only.

## Decision

**Every session Vyre starts is a Vyre-owned session: vyred holds it through a driver, behind a
provider router, and every surface sees it through one session and event model. The first
driver is Claude Code on the Agent SDK. Terminal sessions stay plain `claude` and keep the
plugin. Transcripts on disk stay the source of truth for Claude, so either side resumes the
other.**

### 1. The session and event model

A session is a `threads_runs` row, as today: `id` (for Claude, the Claude session id, known
before the process starts), `provider`, `driver`, `purpose`, `model`, `cwd`, `project`, `agent`,
`auth`, `status`, and the launch options a resume reuses. A **turn** is one user message and
everything until the provider says it is done. Turn ids are Vyre's (`<thread>:<n>`), so they
survive a resume.

States: `starting`, `idle`, `running`, `waiting` (an ask is open), `stopped`, `failed`. A
session is `idle` with no process at all once it has been closed for idleness (section 7).

The bus events, agreed with chat, capsule-now and capsule-sight (27 Sep). Existing names keep
their meaning and gain fields; every event carries `thread` and, once step 6 lands, `turn`.
A surface that sees a field absent behaves as before.

| Event | Payload (beyond `thread`, `turn`) | State |
|---|---|---|
| `thread.started` | `provider`, `model`, `auth`, `purpose`, `cwd`, `resumed` (the chip: "Claude · opus · subscription") | live |
| `thread.turn` | `turn` (`<thread>:<n>`), `uuid` (the SDK user message uuid, equal to the transcript line's), `text` | step 6 |
| `thread.text` | `message`, `block` (the content block index; key `message:block`), `delta` or `text` + `done`, `kind: "reasoning"` for thinking | `block`: step 6 |
| `thread.tool` | `id` (= `call` during the migration), `call`, `name`, `status` (`running` once, then `completed`, `failed` or `canceled` once), `summary` | step 6 |
| `ask.raised`, `ask.answered` | as today; `ask.answered` with `decision: "cancelled"` for a withdrawn question | live |
| `thread.sent` | `text`, `surface`, `uuid`, `via`: `steer` (joined the running turn), `turn` (handed over at a turn's end), `now` (a queued row sent at once); `queued` for a queue row | `via`: step 6 |
| `thread.steered` | `uuid`: Claude Code took the steered message in at a step (the delivered-at-step marker) | step 6 |
| `thread.queued` | `queued` (the `threads_inbox` row id), `uuid`, `text`, `surface`; re-emitted with the same ids for an edit | live, `uuid` step 6 |
| `thread.unqueued` | `queued`, `uuid`, `reason: "taken"` | step 6 |
| `thread.rewound` | `uuid` (the user message rewound to), `fork` (the new thread id) | parity |
| `mode.changed` | `mode` (`default`, `acceptEdits`, `plan`) | live |
| `thread.state` | `state` | step 6 |
| `thread.usage` | `tokens`, `cost_usd`, `context: { used, max }` | step 6 |
| `thread.limit` | the provider's rate-limit info | live |
| `thread.finished` | `ok`, `cost_usd`, `tokens`; `error`; `canceled: true, reason: "interrupt"` | `canceled`: step 6 |
| `thread.stopped` | `reason`: `stopped`, `idle` (resumable), `restart`, `done`, `exited ...` | live |

Full detail (tool inputs, question options, diffs) stays in rows and in the transcript, never in
events, as today: events are small and carry no credentials and no raw tool input.

### 2. The provider contract

What was built (core/sessions/conformance.js has the contract and its test):

```js
// A provider: Claude (built in: core/sessions/providers.js), or one a module adds.
{ id: "claude", capabilities: { streaming, resume, interrupt, modes, questions, transcripts },
  run(o) -> { pid, alive, write(obj), stop(grace), interrupt(), setMode?(mode) } }
// o: { id, resume, cwd, env, model, system: {mode, text}, name, budgetUsd, tools, settings,
//      plugin, plugins, subreaper, uid, gid, onSpawn({pid, pgid, sid}), onMessage(m), onExit(code, signal, stderr) }
```

`write` takes a user turn or the answer to a permission question; `onMessage` gives the session's
wire messages (system init, text deltas, assistant and user blocks, `can_use_tool` requests and
their cancellation, rate limits, a result per turn). The Claude driver speaks this natively; a
Codex or ACP driver translates to it, as Paseo's providers translate to its timeline. Every
process a provider starts goes through `core/sessions/spawn.js`, so the security of section 8
holds for every provider.

The Switchboard keeps everything above the provider: rows, leases, the queue, the bus, asks, the
floor before asks, and the peer check. Nothing outside `core/sessions` and the Switchboard imports
a driver.

### 3. The Claude driver, on the Agent SDK

- **One `query()` per live session**, fed by a push queue (`prompt: AsyncIterable`), started with
  `sessionId` (new) or `resume` (existing), `includePartialMessages: true`, and
  `spawnClaudeCodeProcess` so the driver knows the child pid and can kill its whole tree.
  The query is recreated with `resume` only after a crash, an auth switch (the limit fallback) or
  an idle close.
- **The system prompt** is `{ type: "preset", preset: "claude_code", append }`, where `append` is
  the assistant's name and voice, the agent preamble, the about-you note, and the planner and
  vault rules. Per-turn context (memory relevant to this prompt) stays a UserPromptSubmit hook,
  since a system prompt is fixed for the session.
- **Permissions.** `canUseTool` runs, in order: (1) the floor (`core/harness/rules.js`), which
  denies without asking anyone; (2) the Gate route, which denies an agent's sending tool and
  points it at `gate.request`; (3) otherwise an ask: a row, `ask.raised`, and a promise held
  until a person answers with `threads.answer`. Its `signal` cancels the ask
  (`ask.cancelled`). "Always in project" is the same rewrite as today, applied to
  `options.suggestions` and returned as `updatedPermissions`. `AskUserQuestion` is an ask of
  kind `question`, answered in `updatedInput.answers` keyed by the full question text.
  `ExitPlanMode` is kind `plan`; allowing it may also switch the mode.
- **Presence and the Needs list** are unchanged: asks are the same rows, so Needs, push, the
  status line, the Capsule and the Deck show them as today. `threads.answer` stays PERSON_ONLY.
- **Tools.** Phase 2 keeps the Harness plugin (`plugins: [{ type: "local", path: harness }]`),
  so owned and terminal sessions behave the same. Phase 3 moves owned sessions to an in-process
  MCP server (`createSdkMcpServer`) for memory, planner, vault and apps, whose caller is set by
  the driver (`mcp:agent:<name>` or `mcp:thread:<id>`), and to in-process hooks for SessionStart,
  UserPromptSubmit, PreToolUse and Stop. That removes the socket hop, the `ps` tty check and the
  key file for owned sessions. The plugin stays for terminal sessions.
- **Steering is the default** (the user, 27 Sep: Chat must feel like Claude Code in the
  terminal). A message sent while a turn runs joins THAT turn at Claude's next step: it goes to
  the SDK with `priority: "next"`, `thread.sent {via: "steer"}` says so, and `thread.steered`
  marks the step where Claude took it in. The explicit alternative, "after this turn"
  (`threads.send {mode: "queue"}`), waits in Vyre's queue (`threads_inbox`), where it can be
  taken back (`threads.unqueue`) or edited (`threads.edit`) until it is handed over at the turn's
  end, and promoted with `threads.send_now`. The SDK has no public way to take a steered message
  back, which is why the editable queue is ours. A session live in a terminal always queues
  (section 11).
- **Interrupt** is `query.interrupt()`: open asks for that turn are cancelled first, the turn
  ends as `turn.canceled`, and the stale `result` after it is dropped.
- **Resume and fork.** Resume is a new `query()` with `resume: id` on the same transcript, which
  is what a terminal `claude --resume <id>` does too. Fork is `forkSession`, a new thread id.
- **Environment.** The child env is built from nothing but what it needs (`HOME`, `PATH`, the
  `VYRE_*` variables, one credential), with `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and any
  ambient token removed, as `spawn()` does today.

### 4. Auth, swappable

The user reports that Anthropic's 15 June update paused the change to how the Agent SDK is
billed, so SDK sessions draw on the subscription today. The terms still say "unless previously
approved", so auth is a per-machine setting (`sessions.auth`), not a build-time one:

| Mode | Where the secret lives | What the child gets |
|---|---|---|
| `login` | Claude Code's own login on that machine (keychain on the Mac, `~/.claude` on the box) | nothing; the child reads it |
| `setup-token` | the vault, `claude-setup-token`, granted to `threads` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `api-key` | the vault, `anthropic-api-key`, granted to `threads` | `ANTHROPIC_API_KEY` |

Approved defaults: the box uses `setup-token`, the Mac `login`, and an API key in the vault is the
fallback when the subscription's limit is reached (the thread is resumed on it, as before). The
vault is asked only once onboarding stored a token or `sessions.auth` is set, so a machine without
one never touches it. A token lives only in that child's env and never reaches an event, a row or
a log. An agent brings its own credentials, as before.

### 5. More providers, later, as modules

Claude only for now (the user, 27 Sep). The router is ready for Codex, ChatGPT and ACP agents to
arrive later as separate modules, with no core change:

- A module declares `"does": { "providers": ["codex"] }` and calls `ctx.provider("codex", driver)`
  in its start. The registry refuses an undeclared or duplicate name.
- `threads.start { provider: "codex" }` runs a session on it; the record says `provider` and
  `driver`; an unknown provider is refused with the list this machine has.
- The driver must pass `conform()` (core/sessions/conformance.js): a turn streams with the
  session's id, a permission question reaches the tool once allowed, an interrupt withdraws a
  question and the session outlives it, stop takes the whole process group, a resume keeps the id,
  and `onSpawn` reports pid, group and session before the first message. The CLI runner and the
  SDK driver pass it; a sample module's provider runs a session end to end (core/sessions/sessions.test.js).

The sketches stay for when they are built:

- **Codex** runs `codex app-server` (JSON-RPC over stdio): `thread/start` or `thread/resume`,
  `turn/start`, `turn/steer`, `turn/interrupt`; `item/*` notifications become text, reasoning
  and tool messages; `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
  become `can_use_tool` questions answered `accept` or `decline`; user-input requests become
  questions. Modes map to Codex's approval policy and sandbox pairs. Auth: `login` (ChatGPT
  sign-in) or `api-key` (`openai-api-key` in the vault).
- **ACP** is one generic driver over `@agentclientprotocol/sdk`: `session/new` or
  `session/load`, `session/prompt`, `session/update` mapped like Paseo's table,
  `session/request_permission` as a question whose options become the ask's buttons, `cancel`.
- **Transcripts for providers that are not Claude.** The Switchboard writes their timeline to a
  `threads_items` table from the wire messages, and `core/transcripts` reads it as one more
  source. Claude keeps its own files as the authority.

### 6. Resilience, relay and federation

- **ADR 0029.** Driver events go through the bus, so every one has a cursor and replays (R1).
  `threads.send` uses the caller's idempotency key as the SDK message `uuid`, so a retried send
  is a replay, not a second turn, even across the queue (R2). `threads.answer` on an ask that is
  already answered returns the earlier outcome. A vyred restart ends running turns with
  `thread.stopped` reason `restart` (R7); idle sessions lose nothing, because they are resumed on
  the next send.
- **ADR 0026.** Nothing session-specific crosses the relay: devices call `threads.*` and follow
  the event stream as they do over the tailnet.
- **Federation (ADR 0021).** Each machine's vyred owns the sessions it starts. A Mac-owned
  session now raises its asks to the Mac's vyred instead of the terminal, so the phone must be
  able to answer a Mac's ask: `threads.answer` joins the federation allowlist, run on the Mac
  as `link:box`, carrying a presence assertion signed by the box (the "v2" of ADR 0021). Until
  that lands, a Mac-owned ask says "Answer it on <mac>", as today.

### 7. Performance on the box

One session is one Claude Code process, as today; the SDK adds no process. Measured on testbox
(4 cores, Node 22, SDK 0.3.283), see "Proof" below:

- The real bundled Claude Code, started and initialised with no turn, holds about 187 MB RSS
  and uses about 1 percent of a core for its first 30 seconds. Left alone for a few minutes it
  settles at 178 MB and 0.13 percent.
- The host process (Node, the SDK and one session) sat at 66 to 83 MB RSS, 0.4 percent of a
  core just after a turn and 0 once settled.

So an idle owned session is not free. Rules:

- **Close on idle.** A session with no turn, no open ask and no watcher for 10 minutes
  (`sessions.idle_minutes`) is closed (`thread.stopped` reason `idle`) and resumed on the next
  send. Resume costs about a second of start-up. The API's prompt cache lasts 5 minutes, so
  keeping the process longer saves nothing on tokens.
- **A cap.** At most `sessions.max_live` (default 6 on the box) processes at once; beyond it the
  oldest idle one closes first, and when every one is busy a new session is refused (`busy`)
  until one finishes.
- **The SDK is not an npm dependency** (as with the search model in `core/recall/embed.js`):
  it is installed on first use into `<VYRE_HOME>/sessions-sdk`, pinned, with its bundled Claude
  Code only where `sessions.claude` is `bundled`, and loaded with the first session rather than at
  start, since the import alone is about 40 MB. Until it is installed, sessions run on the CLI
  runner, which speaks the same protocol.
- **A warm spare** (`prewarm()`) is optional and off by default: it costs one idle process to
  save about a second on the first turn.
- One process per session is the right unit: a crash, a limit fallback or an interrupt affects
  one session, and the peer check can see the tree.

### 8. Security

Reviewed by e2e (27 Sep); the three blocking notes are built and tested before the default flip.

- **Orphans and the peer check** (blocking 1). Every session process, on every driver and
  provider, is spawned by `core/sessions/spawn.js`: detached (it leads a new process group and
  session), under `tini -s` where installed (the box image has it), so a model's Bash that
  detaches (`nohup ... &`, `setsid`, a double fork) reparents to tini and its ancestry still leads
  to a session process. pid, pgid and sid are recorded synchronously at spawn, before the process
  can run a tool, and `threads.pids` returns `{ pids, pgids, sids }`, a group listed until its
  last process is gone. e2e refuses a person-only call from any process whose group or session
  matches. A stop kills the whole group. Next (e2e with sessions): on the box, sessions run as a
  separate uid that cannot open vyred's socket (`sessions.uid`, `sessions.gid` are already passed
  to spawn), with their Vyre tools through the in-process MCP of phase 3.
- **Permission files** (blocking 2). A tool call that a settings rule allows never reaches
  `canUseTool`, so a model that writes its own `.claude/settings.local.json` would escape every
  ask. The floor (rule 1, core/harness/rules.js) denies a session's writes, by file tools or Bash
  write forms, to `settings.json` and `settings.local.json` in any `.claude` folder, `.claude.json`,
  `.mcp.json`, `managed-settings.json` and settings files under `$CLAUDE_CONFIG_DIR`. The PreToolUse
  floor stays on for rule-allowed calls, and the Switchboard also runs the floor before putting
  any question to the person: what it denies is refused with a notice, never asked.
- **Modes** (blocking 3). Only a person changes a session's permission mode: `threads.mode`
  (default, acceptEdits, plan; PERSON_ONLY; refused from the session's own thread). An answer's
  `updatedPermissions` is filtered (`safePermissions`): a switch to bypassPermissions or any mode
  Vyre does not offer is dropped, whoever answers. Nothing else calls `setPermissionMode`, and
  `allowDangerouslySkipPermissions` is never set.
- **Agents never approve.** `threads.answer` is PERSON_ONLY, refuses agent and MCP callers, and
  refuses a call traced to the ask's own thread. In-process MCP tools (phase 3) never include a
  PERSON_ONLY or HUMAN_ONLY tool, and their caller (`mcp:thread:<id>`, `mcp:agent:<name>`, both
  "mcp" to the registry) is set by the driver, never by the tool's input. Editing a system prompt
  or a model (`sessions.prompt.set`, `revert`, `sessions.models.set`) is PERSON_ONLY too.
- **MCP trust.** `canUseTool`'s `mcpServer.source` says whether a tool is ours (`sdk`) or from
  configuration; decisions key on it, never on the tool name.
- **Setting sources.** Owned sessions load `user`, `project` and `local` settings, as a terminal
  session does, so the user's own rules and hooks apply. Jobs pass `[]`.
- **Still open** (e2e's "should"): the floor re-checks an answer's final `updatedInput` (with the
  queue and edit work); whether Claude Code's Bash children inherit `CLAUDE_CODE_OAUTH_TOKEN` is to
  be measured against a fake Messages API (if they do, the box moves to `login` or an
  `apiKeyHelper`); owner tailnet nodes are treated as the person over HTTP until e2e's HTTP person
  session lands, so Mac-owned sessions stay behind that.

### 9. Models per purpose

The user, 27 Sep: Opus for real work, a faster, cheaper model for quick answers and background
jobs. Each session has a purpose (`chat`, `agent`, `project`, `capsule`, `job`, `memory`,
`planner`, `learn`), given by the caller or inferred (a lean or one-shot thread is a `job`, an
agent's is `agent`, one in a project is `project`, else `chat`). The model is, in order: an
explicit one (a launch, an agent's own model), the project's override, the purpose's override set
from a surface (`sessions.models.set`, person-only), `sessions.models` in config, and the default:
`opus` for chat, agent and project, `haiku` for the rest. `sessions.models.get` shows the map and
where each comes from; `thread.started` carries the model for the chip.

### 10. Adopting existing sessions

The user asked how existing sessions work with Chat on the SDK. There is no conversion:

- **One list.** The Deck and the phone list every session: history from the transcripts
  (`projects.catalog`, `recall.transcript`) and the live ones from `threads.list`, each with a
  source badge: terminal, Vyre, Mac or box.
- **The first message resumes it through the SDK.** A message from Chat to a session Vyre did not
  start adopts it (`adopt.js` makes the record) and resumes it with `resume: <id>` in the
  transcript's own folder, on the machine that owns it: a Mac session on the Mac, with the
  installed `claude`. From then on it is a Vyre-owned session: the assistant's system prompt,
  `canUseTool` and its asks, steering and the queue.
- **One writer.** If the session is live in a terminal (bound by the hook, `claude --resume` in
  `ps`, or a transcript write in the last 30 seconds: `openElsewhere`), the message is QUEUED by
  default and handed over at that terminal turn's end, as today. Chat offers FORK
  (`forkSession`: continue as a copy, a new thread) instead. Vyre takes the session over only
  once the terminal has exited. Never two writers on one transcript.
- **No duplicates.** Live turns and history are matched by Claude's message id (and the user
  message `uuid`), so a turn seen live and then read from the transcript is one row.
- **Open in terminal** is `claude --resume <id>` for any session, where it ran. For a session
  vyred is running, `vyre resume` hands it over first: an idle one is closed; one mid-turn or
  waiting on a question is left alone.
- **Older transcripts.** A transcript an older Claude Code wrote resumes as it would in the
  terminal; the transcript reader already tolerates older line shapes.

### 11. Parity with Claude Code in the terminal

The user, 27 Sep: Chat must feel exactly like Claude Code in the terminal. What each behaviour
takes, and who provides it:

| Behaviour | In the SDK | Ours |
|---|---|---|
| Steering: a message sent while working joins the turn at the next step | streaming input, `priority: "next"` | the default for send while busy; `thread.sent {via: "steer"}`, `thread.steered` |
| Esc interrupts at once | `query.interrupt()` | `threads.interrupt`; open asks cancelled; `thread.finished {canceled}` |
| Double Esc rewinds to an earlier message | `resumeSessionAt`, `forkSession`, `rewindFiles` (with file checkpointing) | `threads.rewind {thread, uuid}`, `thread.rewound`; the message list as rewind points |
| Shift+Tab modes (default, acceptEdits, plan) | `setPermissionMode` | `threads.mode`, person-only, never bypass |
| Slash commands, the user's own and plugins' | `supportedCommands()`; a `/command` sent as a user message | the list for the composer's menu |
| @file mentions | none (text) | the composer's picker, inserting the path |
| `!` shell | none | a Bash call the session makes, or the Deck's terminal |
| `#` add to memory | none | `memory.remember` from the composer |
| Image paste | image content blocks in a user message | the composer's paste, sent as blocks |
| The thinking display | thinking blocks, `stream_event` thinking deltas | `thread.text {kind: "reasoning"}` |
| Todos | TodoWrite tool calls | the todo card from `thread.tool` |
| Background tasks | `backgroundTasks()`, `stopTask()`, task notifications | a task list on the thread |
| Compact | `/compact` as a user message; compaction status messages | a compact action and its marker |
| Model switch | `setModel()` | the chip's picker (sessions.models for defaults) |
| Up to recall or edit the last message | none | the composer's history; editing a sent message is a rewind |

`threads.edit` and `threads.unqueue` act on queued rows only; editing a message Claude already
has is a rewind to it.

### 12. Spec changes

- Principle 1 becomes "public Claude Code surfaces only: the plugin system, documented CLI flags
  and the Claude Agent SDK". The risk note about `--permission-prompt-tool stdio` goes: the SDK
  owns that flag.
- Section 10's "Every Vyre session is a real Claude Code session: in a terminal, or headless
  under the Switchboard" gains "or another provider's session, through the router".
- Principle 8 (light by default) gains: an idle session is closed after `sessions.idle_minutes`.

## Migration

In order. Steps 1 to 3 shipped behind `sessions.driver`; the default becomes `sdk` as soon as the
full suite is green on it (days, not a long dual run), and the CLI runner then stays only for the
window before the SDK is installed. Nothing changes for surfaces until
step 6.

1. **sessions** (new `core/sessions`): the router, the Claude driver, the fake-claude test path
   (the SDK pointed at `core/switchboard/testing/fake-claude.js` with
   `pathToClaudeCodeExecutable`). The SDK installs on first use, pinned (section 7).
2. **switchboard**: `launch`, `send`, `write`, `answer`, `stop`, `halt`, `fallback` and `recover`
   go through a `Session`; `runner.js` and most of `translate.js` retire; idle close and the cap;
   `threads.pids` includes driver pids; new events `thread.turn`, `thread.usage`,
   `thread.state`; `thread.tool` gains `call` and `status`.
3. **harness** and **security/e2e**: the plugin passed through the SDK; the floor inside
   `canUseTool`; tests that an owned session's Bash cannot call a PERSON_ONLY tool, and that an
   agent cannot answer its own ask. Then phase 3: in-process hooks and MCP with the caller set
   by the driver.
4. **agents** and **learn**: the preamble becomes `append`, credentials become an auth mode,
   `budget_usd` becomes `maxBudgetUsd`; jobs keep `once`, `tools: "none"` and no settings.
5. **onboard**, **box** and **vault**: the vault's `claude-setup-token` and `anthropic-api-key`
   are granted to `sessions`; `vyre doctor` reports which auth each machine uses.
6. **chat**, **capsule**, **deck**, **mobile**: tool rows by call id and status, "queued" with
   take-back and edit, "send now", interrupt, and the turn and state events. The Capsule's "not
   one vyred runs" message applies only to terminal sessions.
7. **federation** and **link**: `threads.answer` forwarded with a signed presence assertion.
8. **resilience**: idempotency keys become SDK message uuids; `thread.stopped` reason `restart`.
9. **sessions**: the Codex driver, then ACP, then `threads_items` for their timelines in recall.
10. **docs**: the spec changes above, `using/claude-code.md`, the reference for new events.

Terminal sessions, `core/term`, `core/computers` and `recall.watch` do not change.

## Proof

`scripts/sessions-proof/` on testbox, in a temp home, with the real SDK (0.3.283) driving Vyre's
fake `claude` (so no subscription is spent) through `pathToClaudeCodeExecutable`:

| Step | Result |
|---|---|
| Start a session, stream a turn | ok: `system/init`, 4 text deltas, first turn in 60 to 86 ms |
| A Bash call through `canUseTool` into an ask, answered by a "person" | ok: `ask.raised` for Bash `npm test`, `ask.answered` allow, the tool ran |
| The floor denies `rm -rf /` without an ask | ok |
| An `AskUserQuestion` answered with its answers | ok: 2 questions, answers returned in `updatedInput.answers` |
| A message sent mid-turn waits, then runs | ok |
| Close, then resume in a new query | ok: `--resume=<id>` passed, the same transcript grew from 20 to 22 lines |

Then the real bundled Claude Code, started with no credentials and no turn: initialised in 0.6
to 1.2 s; 187 to 189 MB RSS and about 1 percent of a core in its first 30 s; 178 MB and 0.13
percent after two more minutes; the host at 67 to 68 MB. No API call was made.

With the fake child, the active and idle numbers were: host 83 MB and 0.5 percent during turns,
66 MB and 0.4 percent idle; child 54 to 56 MB and 0.1 percent.

## Risks and open questions

Decided by the user (27 Sep): auth (box setup-token, Mac login, API key fallback), the bundled
Claude Code on the box and the installed one on the Mac, idle close at 10 minutes and a cap of 6
on the box (both configurable), Capsule sessions where the work lives (quick asks to the box
assistant, Mac project folders Mac-owned), steering as the default, Opus for work and a fast model
for quick answers and jobs, Claude as the only provider for now.

Still open:

- **Billing terms.** SDK sessions on a subscription rest on the paused 15 June change. If it
  resumes, the box moves to `api-key`, or `login` if a subscription login in the child still
  counts as Claude Code. `sessions.auth` makes that one setting.
- **Credentials in Bash** (section 8, "still open").
- **Floor rule 8 and agents' folders.** The floor treats all of VYRE_HOME except `watchers/` and
  `modules/` as Vyre's own state, so an agent without a project, which runs in
  `<home>/agents/<name>`, cannot write files in its own folder. e2e decides.
- **Mac-owned sessions** wait for e2e's HTTP person session and tailnet's signed answer forward
  (migration step 7).
- The SDK is pre-1.0 and changes weekly; it is pinned in `core/sessions/sdk.js`, and a bump runs
  the switchboard and sessions suites on the SDK driver first.
- The plugin inside an owned session and in-process hooks must never both run the same piece.
