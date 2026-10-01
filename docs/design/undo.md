---
title: "Undo: the shared acted-log"
summary: How core/undo records what agents, the assistant, watchers and modules did for the person, each with the inverse its own module declared, and how one tap runs that inverse. Who may record, who may undo, and which caller the inverse runs as.
audience: builders
owner: assistant
status: draft
---

# Undo: the shared acted-log

When something acts for the person without asking first (an agent, the assistant, a watcher, a
module), the person gets Undo instead of a confirm dialog. PLAN P14 sets the rules, and this page
describes the piece that keeps them: `core/undo`.

It is a module of its own, not part of the assistant, so switching the assistant off never takes
Undo away from watchers or any other module.

## What a row holds

Each row in `undo_acted` says who acted (`actor`, the caller label vyred gave the call, such as
`mcp:agent:juno` or `module:watchers`), what kind of actor that is (`assistant`, `agent`,
`module` or `person`), the tool and its input, a one-line summary, and the inverse: a tool name
and the input to run it with. `why` may hold the audit ids that allowed the action (`{said}` from
[Said](said.md) or `{rule}`); nothing reads them to decide anything.

The actor kind comes from the label. An agent's name is looked up once in `agents.list` to tell
the assistant from other agents. Without the agents module every agent is recorded as `agent`.

## The inverse comes from the module, never a model

`undo.record` has reach `modules`: only Vyre's own modules can call it. A model, a surface, an
agent and an added module never see it. The module that performed the action builds the inverse
from what it actually did (the id it created, the value it replaced) and records it right after.

An inverse is refused when:

- no running tool has that name,
- the tool is `outward` (send, post, pay, delete),
- it needs the person present, or it is the person's own (`PERSON_ONLY`, `HUMAN_ONLY`, or callers
  of the person's surfaces alone),
- a module caller could not run it, or it is one of undo's own tools.

The same check runs again when Undo is tapped, so a tool that changed since cannot be replayed.

## Who may undo

`undo.run {id}`: the person on any of their own surfaces or devices may undo any row. An agent,
the assistant included, may undo only rows it did itself (the same agent name over any
transport). A module may undo only its own rows. A row already undone answers `{already: true}`,
and two taps at once run the inverse once. A failed inverse marks the row `failed` with the error,
says `undo.failed`, and can be tried again.

## Which caller the inverse runs as

P14 asks that the inverse run with the original actor's authority, never the person's. The kernel
does not let a module call as another caller: `ctx.call`'s `as` is limited to the labels
`CALL_AS` in `core/modules` lists, and none is a person's. So today the inverse runs as
`module:undo`, a module caller. That keeps the safety half of P14 (no person authority, no
presence, no person-only tool), and the inverse check above already refuses anything a module
caller should not do. Running as the original actor needs a `CALL_AS` entry for undo, which is the
platform's to add.

## Events and retention

`undo.recorded {id, actor_kind, tool}`, `undo.done {id}` and `undo.failed {id}`. Rows older than
30 days are removed at start and once a day.

## Open

- `ctx.undo.record` (ADR 0047) is not routed to `undo.record` by the loader yet; until it is, a
  built-in module calls `undo.record` through `ctx.call` and passes the caller its own tool ran
  for as `actor`, because the loader carries no call chain.
- An inverse whose tool has reach `modules` is hidden from the listing undo checks against, so it
  is refused today.
