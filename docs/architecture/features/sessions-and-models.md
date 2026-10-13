---
title: Sessions and models
summary: How a chat becomes a running AI session on Claude, Codex or Grok, on which account and on which computer, and how a person switches or fans out to several models.
audience: builders, agents
owner: docs
status: stable
---

# Sessions and models

## What it is

A session is one provider's AI process (or API stream) working in a chat's folder. Vyre starts it, feeds it messages, records its turns and can move the chat to another provider, account or computer between turns.
The Switchboard (`core/switchboard/index.js`, module `threads`) owns the running threads. `core/sessions` owns providers, accounts, models, modes and fallback routes. `core/runner` decides whether the session runs on a member's own computer or on the server.

## What a person sees

- The chat composer has one **Answering** control: stacked marks of the AIs that reply. A person picks one, several or all, and a model for each (`apps/app`, the composer).
- The **+** menu in the composer has "where it runs". The session settings sheet has the sections "How it answers" (effort, thinking, mode, who replies) and "Where it runs".
- The chat shows where a session runs ("On the server" or a computer's name) and a line when it moved.
- Sign-in rows for each provider (Claude, Codex, Grok) live in Settings, in the accounts list; the row component is `apps/app/ui/components/ProviderRow.tsx`.
- With two or more AIs answering one message, each answer is its own block with the provider's mark. A person keeps one and the others stay, quieter.

## How it works

**Providers.** `core/sessions/index.js` lists five: `claude`, `codex`, `grok`, `openrouter`, `openai-compatible`. Claude runs through `core/sessions/claude.js` and the Agent SDK helpers (`core/sessions/sdk.js`). Codex (`core/sessions/drivers/codex.js`) and Grok (`core/sessions/drivers/grok.js`) are entries for the generic Agent Client Protocol driver, `core/sessions/drivers/acp.js`. `core/sessions/drivers/openrouter.js` is a plain HTTP chat driver with no tools and no process; it is the last rung of a fallback list, and it never touches the machine. Every driver speaks the same session wire, checked by `core/sessions/conformance.js`.

**Accounts.** Table `sessions_accounts` (provider, label, kind, `vault_item`, `scope_projects`, `scope_agents`, `is_default`). An account names a vault item, never holds a credential. `sessions.accounts.signin` runs the provider's own login and polls; `sessions.accounts.key` stores an API key in the Vault bound to its host. `sessions.accounts.bind` grants an account to one more project or agent, or makes it the provider default. A project or agent without the grant is refused an account even when it names it. After `sessions.accounts.remove`, the next resume asks for another account and never falls back silently. Event: account.changed.

**Models.** `sessions.models.set` stores an alias or id per purpose or project (table `sessions_models`), applied from the next session. `core/models` keeps the registry (`models_entries`, `models_sources`, `models_evals`); `models.list` and `providers.list` feed the pickers. `providers.list` merges the registry's live lists with what sessions reported.

**Switching.** `threads.switch` continues a thread on another provider and account between turns and keeps the folder and files. The new provider gets a brief of what was said. Table `threads_providers` remembers providers a thread used. Event: thread.provider.

**Fallback.** `sessions.routes.set` keeps an ordered list of provider and account entries per scope: `default`, `project:<slug>` or `agent:<name>` (table `sessions_routes`). When a thread's turn hits its limit, the thread moves to the next entry through the same switch. Two entries on one provider save only with `acknowledge: true`.

**Fan-out answers.** In a group chat, `stream.send` appends the person's words, routing picks who answers, and when two or more answer it appends a `fanout` frame (`core/stream/group.js`; the protocol allows two to eight members). `stream.keep` appends `fanout-keep` for the answer a person keeps. `stream.second-opinion` asks another assistant or model of the chat for its own answer to an answer being read.

**`team.ask`.** Sends a request to a teammate (`core/team`). A request may carry a provider and model of its own and runs in a session made for that request alone. The request row keeps `model`, `thread` and `asker`, and the launch is judged for the person who asked.

**Own computer or server.** `core/runner` places a session: `runner.place`, `runner.why-not`, `runner.here`, `runner.move`, `runner.pause-all`. On the person's own server, `core/runner/ownserver.js` seals the provider transcript into a checkpoint store at the end of each turn and `recover` restores the last whole turn after a crash. A session on a member's computer is handled by the lent-session files in `core/runner` (`core/runner/lender-host.js`, `core/runner/lease.js`, `core/runner/lent-client.js`). For the placement rules see `docs/using/local-runner.md`.

**Kernel checks on a call.** Calls on threads go through the module registry with the caller's chain. A session reaches its own thread and the threads it started, and reads its own project's. Anything else gets `denied` and the words "ask the person to do this from their own surface" (`sessionMay` in `core/switchboard/index.js`). `guard` refuses a switch from a caller that may not make it. Person-only tools (`threads.roll`, `threads.mode`, `sessions.models.set`, `sessions.accounts.remove`) need a person surface. `threads.lease` and `threads.release` move which surface holds a thread (`threads_leases`, event lease.changed). The Gate holds an outward act a session attempts.

The Switchboard also emits thread.limit, thread.started, thread.sent, thread.turn, thread.finished, thread.stopped, thread.rolled, thread.usage and usage.paused.

## Where the code lives

- `core/switchboard/index.js`: the threads module: tables `threads_*`, send, queue, switch, fork, roll, lease, asks.
- `core/switchboard/rollover.js`, `core/switchboard/residency.js`, `core/switchboard/lease.js`: context rollover, where a thread lives, surface lease.
- `core/sessions/index.js`: providers, models, modes, limits, prompts, accounts tools.
- `core/sessions/accounts.js`, `core/sessions/routes.js`, `core/sessions/providers.js`: accounts table, fallback routes, provider catalogue.
- `core/sessions/drivers/acp.js` (generic), `core/sessions/drivers/codex.js`, `core/sessions/drivers/grok.js`, `core/sessions/drivers/openrouter.js`: the drivers.
- `core/providers/index.js`: the single `providers.list`.
- `core/models/index.js`: the model registry and eval queue.
- `core/runner/index.js`: placement, own-server sealing (`core/runner/ownserver.js`), lent sessions, folders.
- `core/stream/group.js`: group chats and the fan-out frames.
- `core/team/index.js`: `team.ask` and its request rows.
- `apps/app/src/session/`, `apps/app/ui/components/ProviderRow.tsx`: the session screen and sign-in rows.

## How agents use it

- Open to models: `threads.start`, `threads.send`, `threads.list`, `threads.get`, `threads.switch`, `threads.fork`, `threads.model`, `threads.effort`, `threads.stop`, `team.ask`, `providers.list`, `models.list`, `sessions.models.get`. A session reaches its own thread and the threads it started.
- Person-only: `threads.roll`, `threads.mode`, `threads.shell`, `sessions.models.set`, `sessions.accounts.remove`, `sessions.routes.set`, `runner.move`, `runner.start`.
- Module-only (not for models): `threads.launch`, `sessions.accounts.resolve`, `sessions.models.resolve`.
- Through MCP these appear via `tools_find` and `tools_call`, see [MCP and the Engineer](./mcp-and-engineer.md). See also sessions, memory and context (agent doc "sessions-and-context"), authority (agent doc "authority") and tools (agent doc "tools").

## Extend it

In 0.5 Claude is the model Vyre has run end to end on real accounts. Codex and Grok run against recorded sessions, and the Grok driver notes that some of its behaviour is assumed. Gemini has no driver. `team.ask` hands a request to Codex or Grok with `--model` and uses whatever accounts the person signed in to. Sending one message to several models is proven for the answers. Plan, diff and terminal blocks look the same for every provider. Vyre records a Grok account's privacy mode, and xAI holds the setting. A member signs in to a provider with the provider's own sign-in, and sessions read the sign-ins, mail and calendar entries in a member's vault but not other items. A Mac as the server passes its installer test on a clean macOS in CI. The virtual machine for agents' computers has not run on real Mac hardware.

A new provider is a driver for the generic Agent Client Protocol driver in `core/sessions/drivers/acp.js`, checked by `core/sessions/conformance.js`.

When a business needs more, build a custom module: a folder with `module.json` and an entry file that registers tools and emits events. `core/modules` loads it and runs it under the supervisor in `kernel/modules`; kernel contracts are in `kernel/contracts/`. See [Modules](../../MODULES.md), [the module contract](../../build/module-contract.md) and [Writing a module](../../build/writing-a-module.md). An agent can write that module on the business's own server. For an outside app, the planned Integration (roadmap R051-01) wraps the app's API and brings its own Flow steps, triggers, connection and agent tools. [Known gaps](../../known-gaps.md) has the full list.

## Related

- [Chats](./chats.md), [Agents](./agents.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Gate](./gate.md), [Kernel](./kernel.md), [Vault](./vault.md), [Apps](./apps.md)
- [Architecture map](../map.md), [Architecture overview](../overview.md)
- [How Vyre runs your sessions](../../using/sessions.md), [Run a space's work on your own computer](../../using/local-runner.md), [Tools reference](../../reference/tools.md)
