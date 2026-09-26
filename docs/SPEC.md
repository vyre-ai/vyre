# Vyre specification · v0.1

Status: working draft, 26 Sep 2026. This document is the source of truth for how Vyre is built.
If code and this document disagree, one of them is a bug; fix whichever is wrong and say so in
the changelog.

---

## 1. What Vyre is

Vyre runs Claude Code on a machine you own and adds the things that do not belong inside
Claude Code itself:

1. **Claude Code on your box.** It runs on a server you control, not your laptop. Simpler to set
   up, reachable from anywhere, and untrusted code never touches your own computer.
2. **Structure.** Projects, threads and context instead of one pile of sessions.
3. **Memory.** Search across every session, and a memory layer that marks in gold what came
   from memory rather than a model.
4. **Agents on your own quota.** Launch agents that use your own Claude subscription (a setup
   token) or an API key with a budget. Each agent has its own computer.
5. **Tailscale, made simple.** Your Claude Code is on your phone as easily as your laptop, at
   your own address, reachable only by your devices.
6. **A built-in vault.** Agents use credentials without anyone seeing them; single items can be
   shared with other people's Vyre, relayed by default so one revoke ends access.

### What Vyre is not

- **Not a fork or wrapper of Claude Code.** Vyre plugs into Claude Code the way any plugin does.
  When Claude Code improves, Vyre improves with it. If Claude Code ships a feature Vyre has,
  Vyre steps aside and uses theirs.
- **Not a hosted service.** Vyre AI runs one thing: the name directory for `<you>.vyre.run`. It
  holds no user data.
- **Not an IDE.** It uses Claude Code for coding. Chat is Vyre's own surface, part of the Deck.

### Install and onboarding

Installed like a self-hosted server app (n8n, a media server): one line from the landing page,
then a visual onboarding in the browser. The terminal does as little as possible.

```
npm install -g vyre
vyre up
```

`vyre up` starts vyred and prints one link: `http://127.0.0.1:<port>/onboard?t=<one-time token>`
(on a headless server, the same link over an SSH tunnel, printed with the exact `ssh -L` line).
The onboarding is the Deck's first screen, and walks through, one step a screen:

1. **You.** Your name, which becomes `<you>.vyre.run`, checked for availability.
2. **Claude Code.** Detects `claude`; signs in with your subscription (`claude setup-token`) or
   an API key, stored in the Vault. Nothing is typed into a terminal.
3. **Tailscale.** Detects it, or shows the one install command for this OS; then "Connect" opens
   Tailscale's own sign-in and waits until this machine is on your tailnet.
4. **Your address.** Reserves the name, points it at the tailnet address, gets the certificate,
   then switches the page to `https://<you>.vyre.run`. From here the loopback link stops working.
5. **Your history.** Finds existing Claude Code sessions, indexes them in the background with a
   progress bar, and lets you make your first projects by picking sessions from the catalogue.
6. **Your devices.** A QR code for the phone, and the Mac download for the Capsule.

Every step can be skipped and finished later from Settings; each is also a `vyre` command for
people who prefer the terminal. The loopback onboarding link is single-use, expires after an
hour, and is the only route vyred serves before an owner exists.

---

## 2. Principles

These are rules, not aspirations. A change that breaks one needs a spec change first.

1. **Public Claude Code surfaces only.** Vyre touches Claude Code through: the plugin system
   (hooks, skills, commands, agents, MCP servers), and documented CLI flags (`--plugin-dir`,
   `--append-system-prompt`, `-n`, `--resume`, `-p` with `stream-json`, `--permission-prompts`).
   Reading transcript files on disk is the one exception. It lives in a single adapter
   (`core/transcripts`), is best effort, and must degrade to "no history" rather than fail.
   One flag is a known risk: the Switchboard passes `--permission-prompt-tool stdio` so a
   headless thread's permission questions come to vyred. It is the flag the Agent SDK passes,
   but `claude --help` does not list it, so a release could change it without notice. It lives
   in one place (`core/switchboard/runner.js`), and a thread without it denies every question.
2. **Local first.** Everything runs on machines the user owns. Nothing leaves them except
   through the Gate, and nothing about the user reaches Vyre AI beyond a DNS record.
3. **One process per machine.** `vyred` runs every service on that machine. On the box it runs
   Core; on the Mac it runs Local. Same binary, different modules enabled.
4. **Everything is a module.** Core services, the Harness pieces, surfaces and third-party
   additions all use the same contract (section 5). No special cases.
5. **Boring, readable code.** Node 22.5 or newer, ES modules, plain JavaScript with JSDoc types
   and `// @ts-check`, no build step for the core. Dependencies need a reason in the changelog.
   SQLite through the built-in `node:sqlite`. Tests with the built-in `node:test`.
6. **The terminal is first class.** Anything the Deck can do, `vyre` can do.
7. **The security floor cannot be configured away** (section 11).
8. **Nothing personal in the repo.** No names, folders, domains, clients or keys. Personal
   settings live in `~/.vyre/config.json`. A test fails if the source names a real person.

---

## 3. Repository layout

```
vyre/
  bin/vyre                 the CLI entry (thin: parses argv, calls core/cli)
  core/                    services that run inside vyred
    config/                ~/.vyre paths, config.json, env overrides
    store/                 the SQLite store: open, migrate, WAL, busy timeout
    events/                the event log and in-process bus
    modules/               the module loader and contract validation
    daemon/                vyred: lifecycle, HTTP API, unix socket
    transcripts/           the ONE adapter that reads Claude Code transcript files
    projects/              projects, threads, markers, the session catalogue
    recall/                full-text and vector search over every turn
    memory/                the graph and the curator (the only writer)
    vault/                 credentials, sealing, passes          (workstream: vault)
    watchers/              the watcher runtime                    (workstream: watchers)
    gate/                  outbound control and approvals          (workstream: gate)
    switchboard/           headless sessions, streaming, lease    (workstream: switchboard)
    ship/                  preview, repo, live                     (later)
    computers/             agents' containers and the screen pool  (workstream: computers)
    names/                 <you>.vyre.run, Tailscale, certificates (workstream: box)
    cli/                   every `vyre` command
  harness/                 a Claude Code plugin
    .claude-plugin/plugin.json
    hooks/hooks.json       Brief, Enrich, Rules, Learn, Stream entry points
    hooks/*.js             each hook calls vyred; none holds logic of its own
    skills/                write-a-watcher, use-the-vault, work-in-a-project
    commands/              /vyre slash commands
    mcp/                   the Vyre MCP server (tools Claude can call)
  local/                   Mac-only modules
    capsule/               the Capsule                             (workstream: capsule)
    hands-mac/             computer use on macOS                   (workstream: capsule)
  deck/                    the web app, served by vyred             (workstream: deck)
  modules/                 first-party optional modules (hands-desktop, hands-chrome)
  docs/                    this spec, the module guide, ADRs, workstream notes
  test/                    cross-module tests; unit tests sit beside their code
  CHANGELOG.md
  LICENSE                  Apache 2.0
```

Runtime data never lives in the repo. It lives in `~/.vyre/` (override with `VYRE_HOME`):

```
~/.vyre/
  config.json              the user's settings (section 4)
  vyre.db                  the store
  vault/                   sealed vault items
  modules/                 third-party modules the user installed
  watchers/                watchers Claude wrote, one folder each
  logs/                    vyred logs, one file per day
  vyred.sock               the local API socket
```

A project folder carries `.vyre/project.json` (section 7.2).

---

## 4. Configuration

`~/.vyre/config.json`. Every key is optional; defaults are sensible for one person on one Mac.

```json
{
  "name": "alex",
  "role": "box",
  "projectsDir": "~/Vyre/projects",
  "roots": ["~/Work"],
  "me": { "domains": ["example.com"], "emails": ["alex@example.com"] },
  "transcripts": ["~/.claude/projects", "~/.claude/projects-archive"],
  "modules": { "enable": ["watchers", "vault"], "disable": [] },
  "network": { "tailscale": true, "address": "alex.vyre.run" }
}
```

`role` is `box` or `local`. It decides which modules `vyred` starts by default.

---

## 5. The module contract

Every module is a folder with a `module.json` and an entry file. The loader validates the
manifest, resolves dependencies, and starts modules in order. A module that fails to start is
disabled and reported; it never takes `vyred` down.

### 5.1 The manifest: five verbs

```json
{
  "name": "watchers",
  "version": "0.1.0",
  "roles": ["box", "local"],
  "requires": ["store", "events", "projects", "vault"],
  "does":    { "tools": ["watchers.create", "watchers.list", "watchers.pause"] },
  "watches": { "emits": ["watcher.fired", "watcher.failed"] },
  "shows":   { "deck": ["panel:watchers"], "capsule": [], "cli": ["watchers"] },
  "needs":   { "vault": ["per-watcher"] },
  "teaches": { "memory": ["watcher.item"] }
}
```

| Verb | Meaning |
|---|---|
| `does` | Tools this module offers. Each becomes an MCP tool for Claude, an HTTP route, and (where it makes sense) a CLI command, from one definition. |
| `watches` | Events it emits into the event log. |
| `shows` | Where it appears: Deck panels, Capsule actions, CLI commands. |
| `needs` | Vault items it asks for. It never reads the vault any other way. |
| `teaches` | Kinds of fact it hands the curator. It never writes Memory directly. |

### 5.2 The entry file

```js
// @ts-check
/** @type {import('vyre/core/modules').Module} */
export default {
  async start(ctx) {
    // ctx.store      the module's own namespace in vyre.db (tables prefixed with its name)
    // ctx.events     emit(type, payload), on(type, fn)
    // ctx.vault      fetch(name) for items its manifest declares
    // ctx.memory     teach(kind, fact) — goes to the curator's queue
    // ctx.projects   read projects and threads
    // ctx.log        structured logging
    // ctx.tool(name, { input, run })   register a tool declared in `does`
    return { async stop() {} };
  },
};
```

### 5.3 One tool, three surfaces

A tool is defined once with a JSON schema for its input and an async `run`. The loader exposes
it as:

- an **MCP tool** in the Harness's MCP server, so Claude can call it;
- an **HTTP route** `POST /v1/tools/<module>.<tool>` on vyred;
- a **CLI command** `vyre <module> <tool>` when the manifest lists it under `shows.cli`.

Every call passes through the Rules (section 11) before `run` executes.

---

## 6. Events

Append-only log in `vyre.db`, plus an in-process bus.

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,          -- ms since epoch
  type TEXT NOT NULL,           -- "watcher.fired", "thread.started", "gate.held"
  source TEXT NOT NULL,         -- the module that emitted it
  project TEXT,                 -- the project it belongs to, when known
  thread TEXT,                  -- the Claude Code session id, when known
  payload TEXT NOT NULL         -- JSON; never a secret value
);
```

Rules: events are facts about the past, named `<noun>.<past-verb>`. Payloads never carry
credentials (the store rejects values that look like secrets, using the shared redactor).
Consumers are idempotent: the same event delivered twice changes nothing.

---

## 7. Core services

Each is a module under `core/`. Their public tools are listed; everything else is private.

### 7.1 Store, config, events, modules, daemon

The plumbing every module uses. The store opens SQLite with WAL and a 10-second busy timeout on
every connection; migrations are numbered SQL files per module.

`vyred` listens on `~/.vyre/vyred.sock` for local clients and, when networking is on, on the
tailnet address through `tailscale serve`. HTTP API: `/v1/...`, JSON, responses are
`{ "data": ... }` or `{ "error": { "code", "message" } }`.

### 7.2 Projects

A project is a home folder, the other folders it owns, the threads in it, and its watchers.
Declared by `<home>/.vyre/project.json`:

```json
{
  "name": "Harlow Legal",
  "org": "Rivera Studio",
  "workspaces": ["../harlow-site"],
  "threads": ["<claude session id>"],
  "people": [{ "name": "Dana Reyes", "email": "dana@harlowlegal.com" }],
  "watchers": ["harlow-invoices"]
}
```

- A **thread** is a Claude Code session. It belongs to a project because a person picked it, or
  because it ran in one of the project's folders. A thread can belong to several projects.
  Nothing automatic removes a pick.
- The **catalogue** lists every session on the device from the configured transcript folders,
  with its `/rename` name, first message, folder and last activity, searchable by what was said.
- Tools: `projects.list`, `projects.create`, `projects.add-threads`, `projects.remove-threads`,
  `projects.catalog`, `projects.context`.

Port from: `the prototype's bin/projects.cjs` (tests in `test/t-projects.cjs`).

### 7.3 Recall

Search over every turn: full-text (FTS5) plus local embeddings reranked over a wide pool. Grown
transcripts append new turns in place and keep their vectors. Measured on a real 100k-turn
corpus: dense search over assistant turns beats full-text alone (MRR 0.195 against 0.142).

Tools: `recall.search`, `recall.thread`.
Port from: `the prototype's bin/recall.cjs`, `embed.cjs`, `sanitize.cjs`.

### 7.4 Memory

The graph and the curator. The curator is the only writer. It extracts entities, addresses,
domains, repos and named things from threads, keeps bi-temporal edges with provenance (every
fact points at the turn it came from), and never runs a model on the hot path. Modules teach it
through `ctx.memory.teach`; sessions only read.

Measured: the graph is precise for identity and routing and did not improve passage retrieval,
so Recall owns retrieval and Memory owns facts, people and links.

**Project graphs.** Each project has its own context graph: the facts from its own sessions and
from what its watchers teach. Together they make the main graph, which only the assistant and
agents granted those projects can see. A project's brief and a session in that project draw only
on its own graph; nothing from one client's project reaches another's.

Tools: `memory.facts`, `memory.pin`, `memory.mute`, `memory.why`.
Port from: `the prototype's bin/curator.cjs`, `graph.cjs`.

### 7.5 Vault · workstream

Credentials, sealed at rest, released one item at a time to a module or agent that declared it.
No screen, log or event ever shows a value. Passes share an item with another person's Vyre:
**relayed** by default (the value never leaves your box; their calls go through your Gate over
Tailscale; revoke ends it at once) or **sealed** (an encrypted copy; revoking means rotating).
Offboarding is one action: revoke everything a person holds and list what must be rotated.

The Vault is meant to replace 1Password entirely, for a person and for their agents: logins
(with TOTP codes), cards, secure notes, API keys and env sets, passkeys later; a password
generator; import from 1Password, Bitwarden, Chrome and Safari; autofill in the browser through
an extension, and on the phone; the Capsule can fill a login into the front app. Agents use
items without seeing them; people see them only after unlocking on their own device.

Tools: `vault.put`, `vault.list` (names only), `vault.grant`, `vault.revoke`, `vault.pass.create`,
`vault.pass.revoke`, `vault.offboard`. Modules call `ctx.vault.fetch(name)`, never the store.
Port from: `the prototype's bin/vault.cjs`, `broker.cjs`.

### 7.6 Watchers · workstream

A runtime, not a set of integrations. Vyre hosts watchers; Claude writes them.

A watcher is a folder in `~/.vyre/watchers/<name>/` with `watcher.json` and `watch.js`:

```json
{ "name": "harlow-invoices", "project": "harlow-legal",
  "schedule": "*/15 * * * *", "needs": ["billing-inbox"], "emits": "invoice.seen" }
```

```js
export default async function watch({ vault, since, emit, log }) {
  // fetch whatever changed since `since`; call emit({ ... }) for each item
}
```

The runtime handles scheduling (cron or webhook), credentials from the Vault, `since` cursors,
retries with backoff, filing items into the project, logs, pause and resume. The Harness ships a
skill, **write-a-watcher**, that turns "watch X and file it into Y" into a watcher and a dry run.

Tools: `watchers.create`, `watchers.test`, `watchers.list`, `watchers.pause`, `watchers.logs`.

### 7.7 Gate · workstream

The only way out of an agent's container. It adds credentials at the boundary, and holds
anything that would send as the user, spend money or delete until the user approves the final
content. Held items appear in Now, the Capsule and the phone.

Tools: `gate.held`, `gate.approve`, `gate.reject`.

### 7.8 Switchboard · workstream

Runs Claude Code sessions headless (`claude -p --input-format stream-json --output-format
stream-json --permission-prompts host`), streams every event to any open surface, gives one
surface the keyboard at a time, and routes each permission question to wherever the user is.

Tools: `threads.start`, `threads.send`, `threads.stream`, `threads.lease`, `threads.stop`.

### 7.9 Computers · workstream

Each agent gets a container with a desktop, Chrome and a terminal. Screens come from a shared
pool and are checked out only while an agent needs to look at something; idle containers are
frozen. Glass streams a screen to the Deck and supports take-over.

### 7.10 Names and network · workstream

`<you>.vyre.run` points at your box's Tailscale address, so only your devices can reach it.
Certificates are issued by DNS challenge, which works for a private address. The Deck is served
with `tailscale serve`, and the user is identified by Tailscale's identity headers, so there is
no separate login. The name directory at vyre.run holds only the DNS record.

### 7.11 Learning · workstream

Vyre learns from how you correct it, and enforces what it learned. A lesson that only sits in
memory is advice; Vyre's lessons are checked by hooks, so a model cannot forget them.

1. **Signals.** Corrections in your prompts ("no", "don't", "always", "I told you"), the edits you
   make to a draft before you approve it (the Gate), tool calls you deny, changes you revert,
   and `/vyre remember`. Each signal keeps the turn it came from.
2. **Lessons.** A signal becomes a lesson: `{ scope: all | project | agent, when, rule,
   check?, level: remind | ask | block, source }`. Distilling free text into a rule may use a
   model, off the hot path, on your own quota. You see every new lesson and can edit, narrow or
   retire it.
3. **Enforcement.** A lesson with a check becomes code. Before a tool runs, the Rules hook
   denies or asks with the lesson quoted. Before a turn ends, the Stop hook runs the output
   checks (banned characters, required steps such as "update the changelog", "test before
   commit") and, when one fails, refuses to end the turn and tells Claude which lesson it broke,
   so Claude fixes it first. A lesson without a check is added to the brief and the prompt
   whenever its `when` matches, every time.
4. **Escalation.** Every lesson counts how often it applied and how often it was broken. A
   lesson broken again moves up a level: remind, then ask, then block.

Tools: `learn.lessons`, `learn.add`, `learn.edit`, `learn.retire`, `learn.check {stage, ...}`
(what the hooks call). Events: `lesson.learned`, `lesson.broken`, `lesson.escalated`.

---

## 8. The Harness

A Claude Code plugin in `harness/`. Every thread Vyre starts loads it with `--plugin-dir`, so a
user's global Claude Code setup is never modified. Users may also install it for plain `claude`.

| Hook | Harness piece | What it does |
|---|---|---|
| `SessionStart` | **Brief** | Adds what the project is, its people, its other threads and its memory. From that project only; capped at about 600 tokens. |
| `UserPromptSubmit` | **Enrich** | Adds relevant memory, marked as memory with source, age and confidence; nothing when nothing is relevant. |
| `PreToolUse` | **Rules** | Checks the call against the security floor and the user's rules; allows, denies, or asks. |
| `PostToolUse` | **Learn**, **Stream** | Records files touched; compares a draft with what the user finally sent. |
| `Stop` | **Stream**, **Check** | Marks the turn complete for every surface. Runs the lessons' output checks first; a failed check keeps the turn going with the broken lesson named (section 7.11). |

Every hook is a few lines that call vyred over the socket and print what it returns. If vyred
is not running, hooks exit silently and Claude Code behaves exactly as without Vyre.

The Harness also ships:

- **MCP server** `vyre`: every module tool (section 5.3).
- **Skills:** `write-a-watcher`, `use-the-vault`, `work-in-a-project`.
- **Commands:** `/vyre status`, `/vyre project`, `/vyre recall <query>`.

---

## 9. Surfaces

| Surface | What it is | Built from |
|---|---|---|
| CLI | `vyre`: home, projects, threads, context, up, status | `core/cli` |
| Capsule | Control-Control command bar on the Mac: talk to the assistant, to any agent, or to any session | `local/capsule` |
| Deck | The web app at `<you>.vyre.run`: Now, Projects, Memory, Agents, Vault, Settings | `deck/` |
| Glass | An agent's screen, live, with take-over | `deck/` + `core/computers` |
| Chat | A better interface over real sessions: a thread per session, mirroring the terminal, driving the same Claude Code sessions | `deck/chat` |
| Phone | Now, approvals, drafts, Glass, Ask | later; a Deck view first |

Every surface talks to vyred's API. None reads the store directly.

---

## 10. Agents and the assistant

Every Vyre session is a real Claude Code session: in a terminal, or headless under the
Switchboard. Vyre never imitates Claude Code; every surface (the terminal, Chat, the Deck, the
Capsule, the phone) drives the same real sessions.

- **The assistant.** Every install has one, made at onboarding. It is yours: its name, voice,
  instructions and skills are configurable. It can see every project and every session, and it
  can start, drive, monitor and stop any session in any project, or outside one, through the
  `threads.*` and `agents.*` tools. It is who you talk to in the Capsule by default.
- **Agents.** Others you create, e.g. a research agent or a bookkeeping agent. Each is headless,
  runs on your Claude subscription (a setup token in the Vault) or an API key with a budget,
  and can draw context from several projects, never from projects outside its list. When a
  subscription's limit is reached it falls back to the API key if one is allowed, and says so
  in its thread. Each can have its own computer (section 7.9).
- **Talking to them.** From the Capsule, the Deck, Chat or the terminal you can talk to the
  assistant, to any agent directly, or to any session directly. Talking to a session types
  into it (one keyboard at a time, floor rule 4).

An agent is a record in `core/agents` (owned by the switchboard workstream):

```json
{ "name": "juno", "kind": "assistant", "auth": { "vault": "claude-setup-token", "fallback": "anthropic-api-key", "budget_usd": 20 },
  "projects": "*", "instructions": "...", "skills": ["write-a-watcher"], "computer": false }
```

Tools: `agents.list`, `agents.create`, `agents.update`, `agents.ask {agent, text}` (to its
current thread, starting one if needed), `agents.threads {agent}`, `agents.stop`.

### The `vyre` home

`vyre` with no arguments, from any folder, opens the home: every project (with thread count and
last activity), **New session without a project**, and every agent (with what it is doing).
Pick a project to see its sessions, newest first: resume one or start a new one in it. Pick an
agent to talk to it. Inside a project's folder, that project is preselected, not opened. It is
an arrow-key list with type-to-filter in a terminal and a plain list when piped. Over SSH it
works exactly the same.

---

## 11. The security floor

Enforced outside the model, in the Rules and the Gate. None can be switched off.

1. Nothing goes out as the user until the user has seen the final words.
2. The user always sees where something is going before it goes.
3. A thread is one thing wherever it is viewed.
4. One screen types into a thread at a time.
5. Every file change is visible, including changes a command made without saying so.
6. Only an explicit question from an agent asks for the user's attention.
7. Anything Vyre tells the user, it can show the source of.
8. No value from the Vault appears on any screen, log or event.
9. The Capsule works offline for the user's own Mac.

---

## 12. Milestones

| | Milestone | Done when |
|---|---|---|
| **M0** | Skeleton | `npm install -g .` then `vyre status` shows vyred running; module loader, store, events, config, API, test runner, CI. |
| **M1** | Projects and memory | Projects, catalogue, recall, curator and brief ported with their tests; `vyre` works as it does today, on anyone's machine. |
| **M2** | Harness | The plugin loads with `--plugin-dir`; Brief, Rules and the MCP server work in a real Claude Code session. |
| **M3** | Vault | Put, grant, fetch, revoke, offboard; relayed passes between two machines on a tailnet. |
| **M4** | Watchers | The runtime plus the write-a-watcher skill; one watcher written by Claude, running, filing into a project. |
| **M5** | Box | `vyre up` on a Linux server; Tailscale joined; `<you>.vyre.run` resolves privately with HTTPS. |
| **M6** | Switchboard and Deck | Headless threads streamed to the Deck; Now and Projects working. |
| **M7** | Capsule | Ported from the current Mac app onto vyred's API. |
| **M8** | Computers and Glass | An agent's desktop, live, with take-over. |
| **M9** | Chat, Gate, phone | Vyre Chat wired to threads; the Gate holding sends; the phone view. |

---

## 13. Workstreams

After M0, M1 and M2 land on `main`, work splits into parallel workstreams. Each runs in its own
Claude Code session, in its own git worktree, on its own branch, touching only its own folders.
The contracts in sections 5 to 8 are the boundaries: a workstream may use another's tools only
through `ctx` or the API, never by importing its files.

| Workstream | Owns | Depends on | Milestone |
|---|---|---|---|
| vault | `core/vault/` | store, events | M3 |
| watchers | `core/watchers/`, `harness/skills/write-a-watcher/` | vault (through `ctx.vault`) | M4 |
| box | `core/names/`, `vyre up` | daemon | M5 |
| switchboard | `core/switchboard/`, `core/agents/` | projects, events | M6 |
| learning | `core/learn/` | harness, memory | M6 |
| deck | `deck/` | the API only | M6 |
| capsule | `local/capsule/`, `local/hands-mac/` | the API only | M7 |
| computers | `core/computers/`, `modules/hands-desktop/`, `modules/hands-chrome/` | switchboard | M8 |
| gate + chat | `core/gate/`, `deck/chat/` | switchboard, vault, deck | M9 |

How to start them, and the order (wave 1 now, wave 2 after the switchboard and vault merge), is
in `docs/work/LAUNCH.md`.

Each workstream keeps `docs/work/<stream>.md` current: what is done, what is next, what it needs
from others. A workstream merges to `main` only with its tests passing and the full suite green.

---

## 14. Engineering rules

- **Tests beside the code**, `node --test`. A bug fix comes with the test that would have caught
  it. Tests never touch the user's real `~/.vyre` or real transcripts; they get a temp
  `VYRE_HOME`.
- **Real data before merge.** Anything that talks to Claude Code, Tailscale or a network is
  exercised for real once before it merges, not only against a mock.
- **CHANGELOG.md** is updated with every change, in plain sentences that say why.
- **Commits** are conventional (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`), one concern each,
  committed by path so parallel sessions never sweep up each other's files.
- **No secrets, no personal data** in code, tests, fixtures or commits.
- **ADRs** in `docs/adr/` for any decision a future contributor would ask about.
