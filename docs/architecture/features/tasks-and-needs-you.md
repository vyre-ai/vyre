---
title: Tasks and Needs you
summary: A task has one doer and an optional checker and moves through fixed states; Needs you is the one list of everything waiting on a person.
audience: builders, agents
owner: docs
status: stable
---

# Tasks and Needs you

## What it is

A task is how work is given to a person or an agent, and how anything asks a person for a yes. The kernel owns every state change (`kernel/tasks/tasks.js`).
Needs you is the person's view of what waits on them: tasks, session asks, held drafts, pairing and more, drawn from one list (`core/waiting`).

## What a person sees

- **Needs you** section on the Now screen (`apps/app/screens/now/NowScreen.tsx`, `WaitingOnYou.tsx`). Three cards show on a wide screen, two on a phone, then "N more waiting".
- A task card (`apps/app/ui/tasks/TaskCard.tsx`) shows who is on it. The app words the people as **Approver** (the checker) and **Follows** (followers), and a task is given through an assign picker grouped "On this project" and "Everyone" (`apps/app/screens/teammates/AssignPicker.tsx`). The Flow editor labels the same roles **Approver (optional)** and **Followers (optional)**.
- The control on a card depends on its ask kind (`askKind` in `apps/app/ui/tasks/ask-model.js`): `date`, `text`, `file`, `yes_no`, `send`, `check`, `credential`, `stuck`, `todo` and `watch`. A `send` card shows the exact words to be sent. A `credential` card opens the Vault to add the item (`/u/vault?add=...`).
- **Later** on a card (`LaterMenu`) puts it away for an hour, this evening, tomorrow morning or next Monday, with an Undo toast.

## How it works

**States.** `waiting`, `ready`, `working`, `needs_check`, `stuck`, `done`, `skipped` (`TASK_STATES` in `kernel/contracts/index.js`). The transition table is data there (`TASK_TRANSITIONS`): the doer starts a ready task; the kernel moves it to `needs_check` or `done` after checking its output; the checker moves `needs_check` to `done` or back to `ready`; a stuck task goes back to `ready` by a responsible person or a person with presence. `done` and `skipped` are terminal. `reopen` is a separate act, only for a task with no checker and no outward act.

**Roles on a task.** One `doer`, an optional `checker`, optional `helpers`, a `due` time, `depends_on` and `escalate_after`/`escalate_to` (`REQUEST_KEYS` in `kernel/tasks/tasks.js`). The app calls the checker the approver and shows followers as those who follow it.

**Output.** The task declares one output kind: `fields`, `note`, `draft`, `sent`, `decision` or `file`. `checkOutput` checks the format, for example a `note` needs text and a source, a `decision` needs yes or no and a reason. These are format checks, not truth. A task that gates a stage, a send or a payment needs a human checker.

**Approval.** `tasks.decide` is accepted only from a chain that is exactly one person, with a hardware presence proof over the exact payload, once. The proof rides beside the request, never in the body (`core/tasks-tools/index.js`).

**Stages.** A record type can have stages with required tasks. Leaving a stage with required tasks not `done` is refused with `stage_tasks_open` (`kernel/gateway/records.js`). `stage` and `status` on the `task` record type are `owned_by: "kernel"`, so no one writes them by hand.

**Sources.** `TASK_SOURCES` in `records/core-types.js`: `gate_hold`, `grant_request`, `pairing`, `kit_install`, `reveal_request`, `continue_in_space`, `flow_step`, `assistant_request`, `memory_proposal`, `manual`. A held send, a grant request and a Flow step that needs a person are all tasks, which is why one list shows them.

**Waking an agent.** A ready task whose doer is an agent is picked up by `core/daemon/agent-wake.js`, see [Agents](./agents.md). If the agent cannot start or ends without handing in, the task is marked stuck with a reason and a suggested fix, and it surfaces to the assigner and approver.

**The Needs you list.** `waiting.list` and `waiting.count` (`core/waiting`) return rows by kind: `approval`, `ask`, `draft`, `access`, `run`, `task`, `eval`, `reminder` and `pairing`. The module emits `waiting.changed` with the count and per-kind counts only when they move.

**Snooze is device-local.** Later is kept by `apps/app/src/state/snooze.ts` in the device's own store under vyre.needs.later. The engine has no snooze for a task, an ask or a held send, and nothing is sent anywhere. Another device still shows the card.

**Events.** task.created, task.readied, task.unblocked, task.started, task.stuck, task.completed, task.approved, task.rejected, task.skipped, task.voided, task.edited, task.reopened.

**Checks on a call.** The task actions are `tasks.request`, tasks.read, tasks.work and `tasks.decide`, registered with the authorizer. Deny looks like absence. A task a caller may not read returns null from `tasks.get`.

## Where the code lives

- `kernel/tasks/` : the task store, transitions, approvals, card builder.
- `kernel/contracts/index.js` : states and the transition table.
- `core/tasks-tools/` : the app's task tools over the kernel store.
- `core/waiting/` : the Needs you list.
- `core/ask/` : several questions as one card.
- `core/daemon/agent-wake.js` : waking agents.
- `apps/app/screens/now/` : Needs you and the task screen.
- `apps/app/ui/tasks/` : cards, facts, ask kinds.
- `apps/app/src/state/snooze.ts` : device-local Later.

## How agents use it

- An assistant gives work with tasks.assign (title, doer, optional checker, record, output), built in `kernel/tools/surface.js`. It is cut down to what the caller's grants allow and its source is `assistant_request`.
- An agent in a task flags its own trouble with the kernel's `stuck` act and hands in its output. It cannot approve: `tasks.decide` refuses a non-person chain.
- The app's tools `tasks.list`, `tasks.get`, `tasks.request`, `tasks.decide`, `tasks.move` and `tasks.submit` are `reach: person`. `tasks.serve` is `modules`, for a team member's reads on the team's server.
- An agent asks a person a question with `ask.many`, see [Chats](./chats.md). A send goes through `gate.request`, see [Gate](./gate.md).
- See authority (agent doc "authority") and tools (agent doc "tools").

## Limits today

- An agent step has no deadline: a session that ends without finishing is marked stuck, but one that never ends is not timed out (docs/known-gaps.md).
- A "For each" step handles up to 50 items in the editor, and a longer list is cut without a note on the run page (docs/known-gaps.md).
- Matters, tasks and files of a project are limited to that project's team, but a member can read every row of a Space-defined record type (docs/known-gaps.md).
- Snooze is not shared between devices (see `apps/app/src/state/snooze.ts`).

## Related

- [Agents](./agents.md), [Chats](./chats.md), [Flows](./flows.md), [Gate](./gate.md), [Kernel](./kernel.md), [Records](./records.md)
- [Map](../map.md), [Overview](../overview.md)
- [Planner](../../using/planner.md), [Teammates](../../using/teammates.md), [Flows (using)](../../using/flows.md)
- [Presence](../../concepts/presence.md), [Events reference](../../reference/events.md), [Tools reference](../../reference/tools.md)
