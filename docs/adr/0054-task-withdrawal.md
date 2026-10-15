---
title: "ADR 0054: A Flow step's due time withdraws its task"
summary: When the due time of an agent or task step passes, the Flows service ends the task so nobody can hand it in late. It ends as skipped, marked withdrawn, in one write, and is never reopened.
audience: builders
owner: flows
status: stable
---

# ADR 0054: A Flow step's due time withdraws its task

Status: accepted, 16 Oct 2026 · Workstream: flows · Roadmap 0.6, item 3.

## Context

An agent or task step waits for its task. Without a due time a late agent could finish work after the Flow moved on, and a session could keep working for nothing. The task table had no way to end a task that is being worked on: `working` led only to `done`, `needs_check` or `stuck`, and `skipped` was a person's act from `ready` or `stuck`.

## Decision

1. **One new transition, `flow_deadline`.** `ready`, `working`, `needs_check` and `stuck` may go to `skipped` by `flow_deadline`. There is no new state: `skipped` is already terminal. The task carries `withdrawn: { reason: "timeout", at }`, and the log gets `task.withdrawn`.
2. **Only the Flows service withdraws.** The action `tasks.withdraw` is in the Flows manifest and in no role. The kernel also checks that the chain's acting hop is the Flows service. An agent, a member's MCP key and any other module are refused.
3. **One write ends it.** The state change is a single write. From then on every start, hand-in, move, check and reopen is refused (`bad_state`), so the agent's lent right on the task has nothing left to act on. The rest follows from the durable `task.withdrawn` event and each step is safe to repeat: the lend of the task is ended, the agent's session for it is stopped, and then the Flow's failure steps run. A crash between any two of them is finished on resume.
4. **Never reopened.** `TASK_REOPENS` refuses a withdrawn task. A person who still wants the work gives a new task.
5. **Stage tasks follow the same path.** A required stage task that is withdrawn stays required: tasks that depend on it keep waiting.

## Consequences

- A Flow author sets a due time on an agent or task step (`timeout_ms`, default for an agent from the Space). Past it the step fails with `timeout` and runs its own nested steps.
- The task shows as skipped with the reason "the due time passed". The Needs you list and the run page say so in words.
- A client store never offers `flow_deadline` as a button.
