# switchboard

Branch: work/switchboard · Worktree: ../vyre-switchboard · Milestone: M6 · Wave 1

## Scope

Owns `core/switchboard/`, `core/cli/commands/threads.js`.

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

## Tools

`threads.start {project?, cwd, prompt?, name?}`, `threads.send {thread, text}`, `threads.list`,
`threads.get {thread}` (recent events), `threads.lease`, `threads.release`, `threads.answer
{ask, decision}`, `threads.stop`.

## Events

`thread.started`, `thread.text`, `thread.tool`, `thread.finished`, `ask.raised`, `ask.answered`,
`lease.changed`.

## Port from

`the prototype's bin/stream.cjs`, `lease.cjs`, `claim.cjs`, `asks.cjs`.

## Done when

Started from the CLI (`vyre threads start`), a thread streams to two `curl` SSE clients at once,
a permission question is answered from one of them, and the lease moves between them. Exercised
with real Claude Code, not only a fake.
