# switchboard

Branch: work/switchboard · Worktree: ../vyre-switchboard · Milestone: M6 · Wave 1

## Scope

Owns `core/switchboard/`, `core/agents/`, `core/cli/commands/threads.js`, `core/cli/commands/agents.js`.

Runs Claude Code sessions headless and makes one thread the same thing wherever it is viewed
(floor rule 3), with one keyboard at a time (rule 4).

- **Run.** `claude -p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --plugin-dir <REPO>/harness --permission-prompts host`
  (check the flags against `claude --help` on this machine first; they change between releases),
  `--resume <id>` for existing threads, cwd set to the thread's folder. The child is owned by
  vyred and survives any surface closing.
- **Stream.** Every stream-json event becomes a `thread.*` event and goes out on
  `/v1/events/stream`. Partial text is throttled (e.g. 20 per second) so surfaces are not flooded;
  events stay small (no whole tool outputs).
- **Lease.** One surface holds the keyboard for a thread. `threads.lease {thread, surface}`
  takes it and says who had it; the others go read-only and show who is typing. Port the reasoning
  in `the prototype's bin/lease.cjs` and `claim.cjs`: two writers on one transcript diverge the file.
- **Permissions.** A permission question from Claude Code becomes an `ask.raised` event with the
  tool, input summary and destination, routed to wherever the user is. `threads.answer` replies.
  Asks are also kept in a table, since a surface that reconnects must still see an open question
  (see `the prototype's bin/asks.cjs` for why asks are not events alone).

## Agents and the assistant (spec section 10)

`core/agents`: the agent records and `agents.*` tools. Onboarding creates the assistant
(`kind: "assistant"`, `projects: "*"`). Every agent runs its threads through the switchboard,
authenticated from its Vault item (`CLAUDE_CODE_OAUTH_TOKEN` from the setup token, or
`ANTHROPIC_API_KEY`, set only in that child's environment), with the fallback and budget rule.
An agent's threads may only use context from its `projects`: pass them to the Harness so the brief,
Enrich and `recall.search` stay inside that list. The assistant gets the `threads.*` and `agents.*`
tools through MCP, so it can start, drive, monitor and stop any session. `agents.ask` is how the
Capsule, Deck and Chat talk to an agent directly; `threads.send` is how they talk to a session.
Tokens come from the real vault through `ctx.vault.fetch(name)` (`needs.vault: ["per-agent"]`), one grant per item to module `agents`.

## Tools

`threads.start {project?, cwd, prompt?, name?}`, `threads.send {thread, text}`, `threads.list`,
`threads.get {thread}` (recent events), `threads.lease`, `threads.release`, `threads.answer
{ask, decision}`, `threads.stop`.

Agents: `agents.list`, `agents.create`, `agents.update`, `agents.ask`, `agents.threads`, `agents.stop`.

## Events

`thread.started`, `thread.text`, `thread.tool`, `thread.finished`, `ask.raised`, `ask.answered`,
`lease.changed`.

## Port from

`the prototype's bin/stream.cjs`, `lease.cjs`, `claim.cjs`, `asks.cjs`.

## Done when

Started from the CLI (`vyre threads start`), a thread streams to two `curl` SSE clients at once,
a permission question is answered from one of them, and the lease moves between them. Exercised
with real Claude Code, not only a fake.

## Done
- `core/switchboard` (module `threads`): runner, translate, lease, asks, tools, events; fake `claude` for tests.
- `core/agents`: records, credentials with fallback and budget, scope, `agents.*`.
- CLI `vyre threads start|send|watch|…` and `vyre agents …`.
- Verified for real on Claude Code 2.1.283 with `--model haiku`, `VYRE_HOME=/tmp/vy-sw-r`, recall and memory
  off: started from `vyre threads start`; two `curl -N` SSE clients got identical streams; a Write `ask.raised`
  was refused from an `mcp` caller and answered `allow` from curl-a, and the file was written; the lease moved
  cli -> curl-b -> curl-a, and the non-holder's `threads.send` came back `{sent:false, holder}`; `vyre agents
  ask scout` replied "pong."; `mcp:agent:scout` was refused `threads.list`; everything stopped with no child left.

- After merging main (the vault) and three subagent branches, a second real run on haiku confirmed three things. An mcp caller's
  `threads.answer` was `denied` by the loader while deck's was allowed, and the Write happened. A plain `claude -p --resume <id>` from
  outside vyred, against a live headless thread, was warned in its brief (it quoted the warning), and vyred emitted `thread.contended`.

## Doing
- Nothing. Waiting on review.

## Next
1. Scope for `recall.thread` and `memory.*` over MCP, which is not done yet (see Needs).
2. Have onboarding create the assistant and grant its items to `agents`.
3. Sweep leftover `thread.text` deltas at startup (a crash skips the scheduled prune).

## Needs from others
- vault (contract final on work/vault): grants are per item and per module, via `vyre vault grant <item> agents`.
  Done here: the loader (`core/modules/index.js`, `ctx.vault.fetch`) now lets `needs.vault: ["per-agent"]` through the
  way it does `per-watcher`, with a test in `core/modules/modules.test.js`, and agents uses `ctx.vault.fetch`. Tell vault
  this branch touched the loader, so its review sees the change.
  Onboarding must grant the assistant's items to `agents` as the cli/local caller.
- recall/memory: honour an agent's scope on the tools the MCP server does not rewrite yet (`recall.thread`,
  `memory.facts`). The caller is `mcp:agent:<name>`, and `VYRE_PROJECTS`/`VYRE_SCOPE_CWDS` are in the thread's env.
- onboarding (deck): call `agents.create {name, kind:"assistant"}`. There can be only one assistant.

## Changed contracts
- New tools and events as listed in Tools/Events above, plus `threads.asks`, `thread.sent`, `thread.stopped`, and the
  internal `threads.launch` and `agents.resume`. Shapes are in CHANGELOG and were sent to capsule and deck.
- `thread.started` now also comes from `threads` (payload `{thread,name,cwd,project,agent,headless:true,resumed}`),
  alongside harness's `{session,cwd,source}` for every session. Consumers must stay idempotent.
- `harness.brief` / `harness.enrich` take an optional `projects` ("*" or a comma list).
- MCP server caller: `mcp:agent:<name>` inside an agent's thread, otherwise `mcp`.
- Internal `threads.claimed {session}` -> `{headless, holder, status}`: true when the id is a live headless thread in
  this vyred; holder is the lease surface, else `agent:<name>`, else null. Internal `threads.contend {session}` emits
  `thread.contended {thread, session, holder}` only if the thread is still live (`core/switchboard/claim.js`).
- `harness.brief` takes an optional `headless` boolean (the hook sets it from `VYRE_THREAD === session_id`). When
  false and the session is a live headless thread, the brief text starts with the two-writer warning.

## Shared files touched (minimal)
- `harness/mcp/server.js`: the caller identity, the tool filter for non-assistant agents, recall scope, and a 600s timeout for agents.ask.
- `harness/hooks/hook.js`: passes `VYRE_PROJECTS` to brief and enrich, and `headless` to brief.
- `core/harness/index.js` (+ test): scope check in brief and enrich; the second-writer warning in brief.
- `core/cli/commands/home.test.js`, `test/projects-cli.test.js`: they asserted that agents did not exist yet.
- `core/events/index.js` (+ test): `Events.prune({ type, before, source?, thread?, has? })`, the log's one
  exception to append-only, for events another event made redundant.
- `core/modules/index.js` (+ test): `ctx.events.prune(type, { before, thread?, has? })`, limited to the module's own
  `watches.emits` types and to rows it emitted itself.

## Assumptions
- `--permission-prompt-tool stdio` is not in `claude --help`. It is what the SDK passes, and without it
  `--permission-prompts host` denies every question. Principle 1 lists public flags only, so the spec may need a note.
- Headless threads load the user's own `~/.claude` settings and hooks (their SessionStart hooks ran). Hook output is dropped
  from events. `--setting-sources` could isolate agents later.
- One process per thread, and stdin stays open between turns. The process model lives in `runner.js` alone.
- The lease is about UX here (all words go through one stdin). `agents.ask` gives it back after the reply.
- The budget counts `total_cost_usd` of turns run on the API key, per agent, and is passed to `--max-budget-usd`.
- A subscription limit is detected from `rate_limit_event.status == "rejected"` or an error result naming the limit.
  This has not been seen for real yet, so the fallback is only tested against the fake.
