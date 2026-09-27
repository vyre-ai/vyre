---
title: "ADR 0030: Vyre-owned sessions and the provider router"
summary: Vyre runs the sessions it starts through the Claude Agent SDK behind a provider router, so Claude Code now, and Codex and ACP agents later, share one session and event model, one ask path and one set of surfaces.
audience: builders, agents
owner: docs
status: draft
---

# ADR 0030: Vyre-owned sessions and the provider router

Status: proposed, 27 Sep 2026 · Workstream: sessions · Related: ADR 0004 (presence),
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
before the process starts), `provider`, `cwd`, `project`, `agent`, `auth`, `state`, and the
launch options a resume reuses. A **turn** is one user message and everything until the provider
says it is done. Turn ids are Vyre's (`<thread>:<n>`), so they survive a resume.

States: `starting`, `idle`, `running`, `waiting` (an ask is open), `stopped`, `failed`. A
session is `idle` with no process at all once it has been closed for idleness (section 7).

Drivers emit these events. The Switchboard puts each on the bus under the names surfaces already
use, adding fields rather than renaming:

| Driver event | Bus event | Payload (beyond `thread`, `turn`, `at`) |
|---|---|---|
| `session.started` | `thread.started` | `provider`, `model`, `cwd`, `resumed` |
| `turn.started` | `thread.turn` (new) | `text` (the user message, redacted), `uuid` |
| `text.delta` | `thread.text` | `text`, `done`; throttled to 50 ms as today |
| `reasoning.delta` | `thread.text` with `kind: "reasoning"` | as above |
| `tool.call` | `thread.tool` | `call`, `name`, `status` (`running`, `completed`, `failed`, `canceled`), `summary` |
| `ask.raised` | `ask.raised` | small, as today: `ask`, `kind` (`permission`, `question`, `plan`, `mode`), `tool` |
| `ask.resolved` | `ask.answered` or `ask.cancelled` | `ask`, `decision` |
| `usage` | written to `threads_turns`, and `thread.usage` (new) | tokens, cost, context used |
| `limit` | `thread.limit` | the provider's rate-limit info |
| `turn.completed` | `thread.finished` | `result`, `cost`, `tokens` |
| `turn.failed` | `thread.finished` with `error` | `code`, `message` |
| `turn.canceled` | `thread.finished` with `canceled: true` | `reason` (`interrupt`, `restart`) |
| `turn.queued` | `thread.queued` | `uuid`, `text` |
| `state` | `thread.state` (new) | `state` |
| `session.closed` | `thread.stopped` | `reason` (`stop`, `idle`, `restart`, `exit`, `crash`) |

Full detail (tool inputs, question options, diffs) stays in rows and in the transcript, never in
events, as today: events are small and carry no credentials and no raw tool input.

### 2. The driver interface

```js
// core/sessions/router.js
/** @typedef {{ id: string, cwd: string, resume?: boolean, append?: string, model?: string,
 *    auth: Auth, plugins?: string[], tools?: "none"|null, settings?: boolean, budgetUsd?: number,
 *    mcp?: Record<string, any>, hooks?: any, floor: Floor }} StartOptions */
export interface Provider {
  id: "claude" | "codex" | `acp:${string}`;
  capabilities: { streaming, resume, fork, interrupt, steer, questions, modes, inProcessTools, transcripts };
  available(): Promise<{ ok: boolean, why?: string }>;
  start(o: StartOptions): Promise<Session>;          // new or resume, by o.resume
  sessions?(cwd?: string): Promise<SessionInfo[]>;   // provider-native sessions, for adoption
}
export interface Session {
  readonly id: string; readonly pid: number | null; readonly state: State;
  send(text: string, o?: { uuid?: string, now?: boolean }): { uuid: string, queued: boolean };
  unqueue(uuid: string): boolean;                    // a queued message not yet handed over
  answer(ask: string, a: Answer): boolean;           // resolves a pending canUseTool
  interrupt(): Promise<void>;
  setMode?(mode: string): Promise<void>; setModel?(model: string): Promise<void>;
  fork?(): Promise<string>;                          // a new session id from this one
  subscribe(fn: (e: SessionEvent) => void): () => void;
  close(reason: string): Promise<void>;              // ends the process, keeps the transcript
}
```

The router picks a provider (the thread's, else the project's, else the default), and an auth
(section 4). The Switchboard keeps everything above it: rows, leases, the inbox, the bus, asks,
the lease and the peer check. Nothing outside `core/sessions` imports a driver.

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
- **Queue, unqueue, edit.** Words sent during a turn wait in Vyre's queue (`threads_inbox`), not
  in the SDK, and are handed over when the turn ends; until then they can be taken back or
  edited. "Send now" is a separate action: it hands the message to the SDK with
  `priority: "next"` so Claude reads it at its next step. (The SDK has no public way to take a
  queued message back, which is why the default queue is ours.)
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
approved", so auth is a per-session choice, not a build-time one:

| Mode | Where the secret lives | What the child gets |
|---|---|---|
| `login` | Claude Code's own login on that machine (keychain on the Mac, `~/.claude` on the box) | nothing; the child reads it |
| `setup-token` | the vault, `claude-setup-token`, granted to `sessions` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `api-key` | the vault, `anthropic-api-key`, granted to `sessions` | `ANTHROPIC_API_KEY` |

The default is `setup-token` when the vault holds one, else `login`. The limit fallback
(`rate_limit_event` rejected) switches a thread from `setup-token` or `login` to `api-key` by
recreating the query with `resume`, as today. A token is released from the vault per process,
lives only in that child's env, and never reaches an event, a row or a log. This closes the
box's open need: every owned session, not only an agent's, gets the vault's credential.

### 5. Codex and ACP

- **Codex** runs `codex app-server` (JSON-RPC over stdio): `thread/start` or `thread/resume`,
  `turn/start`, `turn/steer`, `turn/interrupt`; `item/*` notifications become text, reasoning
  and tool events; `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
  become asks of kind `permission` answered `accept` or `decline`; user-input requests become
  questions. Modes map to Codex's approval policy and sandbox pairs. Auth: `login` (ChatGPT
  sign-in) or `api-key` (`openai-api-key` in the vault). Its transcripts live in
  `~/.codex/sessions`, which `core/transcripts` does not read yet.
- **ACP** is one generic driver over `@agentclientprotocol/sdk`: `session/new` or
  `session/load`, `session/prompt`, `session/update` mapped like Paseo's table,
  `session/request_permission` as an ask whose options become the ask's buttons, and `cancel`.
  File-system capabilities are off; the agent uses its own tools under the floor where it can be
  applied, and under the Gate always. An ACP agent is configured by command and args.
- **Transcripts for providers that are not Claude.** Recall, memory and the rich view index
  Claude transcripts. For other providers the Switchboard writes the session's timeline
  (turns, text, tool calls, asks) to a `threads_items` table from the driver's events, and
  `core/transcripts` reads it as one more source. Claude keeps its own files as the authority.

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
  oldest idle one closes first, and a new turn waits rather than exceed it.
- **A warm spare** (`prewarm()`) is optional and off by default: it costs one idle process to
  save about a second on the first turn.
- One process per session is the right unit: a crash, a limit fallback or an interrupt affects
  one session, and the peer check can see the tree.

### 8. Security

- **The floor** runs before anyone is asked, in `canUseTool` for owned sessions and in the
  PreToolUse hook for terminal sessions (and for owned ones while they keep the plugin). The
  plugin's own floor stays in place for tool calls `canUseTool` never sees (allowed by rules).
- **Agents never approve.** `Session.answer` is reachable only from `threads.answer`, which is
  PERSON_ONLY, refuses agent and MCP callers, and refuses a call traced to the ask's own thread.
  In-process MCP tools (phase 3) never include `threads.answer`, `gate.approve` or any other
  PERSON_ONLY or HUMAN_ONLY tool, and their caller is set by the driver, never by the tool's input.
- **The peer ancestry check.** The driver reports each child's pid; `threads.pids` returns them,
  so a process started by any owned session (a Bash command, an MCP server) is refused a
  PERSON_ONLY call, as it is today. The child's executable is named `claude`, which
  `claudeCommand` already matches.
- **MCP trust.** `canUseTool`'s `mcpServer.source` says whether a tool is ours (`sdk`) or from
  configuration; decisions key on it, never on the tool name.
- **Setting sources.** Owned sessions load `user`, `project` and `local` settings by default, as
  a terminal session does, so the user's own permission rules and hooks apply. Learning jobs and
  lean threads pass `[]`, as `--setting-sources ""` does today.

### 9. Spec changes

- Principle 1 becomes "public Claude Code surfaces only: the plugin system, documented CLI flags
  and the Claude Agent SDK". The risk note about `--permission-prompt-tool stdio` goes: the SDK
  owns that flag.
- Section 10's "Every Vyre session is a real Claude Code session: in a terminal, or headless
  under the Switchboard" gains "or another provider's session, through the router".

## Migration

In order. Each step ships behind `sessions.driver` (`cli` or `sdk`, default `cli` until step 3
passes the full suite and a week of use on the box), and nothing changes for surfaces until
step 6.

1. **sessions** (new `core/sessions`): the router, the Claude driver, the fake-claude test path
   (the SDK pointed at `core/switchboard/testing/fake-claude.js` with
   `pathToClaudeCodeExecutable`). Add the SDK as a dependency, pinned.
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

For the user:

1. **Billing terms.** SDK sessions on a subscription rest on the paused 15 June change. If it
   resumes, owned sessions need `api-key`, or `login` if a subscription login in the child still
   counts as Claude Code. Auth is swappable for this reason; which default do you want?
2. **The 231 MB binary.** The SDK bundles its own Claude Code. Use it (a pinned pair, one more
   copy on disk) or point at the installed `claude` (one copy, but the SDK and CLI versions can
   drift)? Recommendation: the bundled one on the box, the installed one on the Mac so owned and
   terminal sessions run the same version there.
3. **Idle policy.** Close after 10 minutes and a cap of 6 live sessions on the box: right?
4. **Mac sessions.** Should the Mac's vyred own sessions started from the Capsule on the Mac
   (asks come to Vyre, answerable from the phone once step 7 lands), or should Capsule sessions
   start on the box by default?

For us:

- The SDK is pre-1.0 and changes weekly; pin it and run the fake-backed suite on each bump.
- A resumed session must not be open in a terminal at the same time: the second-writer check
  (`claim.js`) stays and applies to owned sessions too.
- The plugin inside an owned session and in-process hooks must never both run the same piece.
- `ExitPlanMode` and mode switches need a surface design before phase 3.
