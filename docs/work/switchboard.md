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
Until the vault stream merges, read the token from a stub `vault.release`.

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
