---
title: Tasks and Needs you
summary: A task has one doer and an optional checker and moves through fixed states; Needs you is the one list of everything waiting on a person; Playbooks start a project with its stages and tasks.
audience: builders, agents
owner: docs
status: stable
---

# Tasks and Needs you

## What it is

A task is how work goes to a person or an agent, and how anything asks a person for a yes. The kernel owns every state change (`kernel/tasks/tasks.js`).
Needs you is the person's view of what waits on them: tasks, session asks, held drafts, pairing and more, drawn from one list (`core/waiting`).
A Playbook is a project template. It lists stages, the tasks of each stage and who does each task, and it starts a project with all of that in place.

## What a person sees

- **Needs you** section on the Now screen (`apps/app/screens/now/NowScreen.tsx`, `WaitingOnYou.tsx`). Three cards show on a wide screen, two on a phone, then "N more waiting".
- A task card (`apps/app/ui/tasks/TaskCard.tsx`) shows who is on it. The app words the people as **Approver** (the checker) and **Follows** (followers). A task is given through an assign picker grouped "On this project" and "Everyone" (`apps/app/screens/teammates/AssignPicker.tsx`). The Flow editor labels the same roles **Approver (optional)** and **Followers (optional)**.
- The control on a card depends on its ask kind (`askKind` in `apps/app/ui/tasks/ask-model.js`): `date`, `text`, `file`, `yes_no`, `send`, `check`, `credential`, `stuck`, `todo` and `watch`. A `send` card shows the exact words to be sent. A `credential` card opens the Vault to add the item (`/u/vault?add=...`).
- **Later** on a card (`LaterMenu`) puts it away for an hour, this evening, tomorrow morning or next Monday, with an Undo toast.
- **Playbooks** (the templates screens, `apps/app/screens/templates/`): a person starts a project from a Playbook, and the first stage's tasks land in Now with their briefs. Owners and admins write and publish Playbooks.

## How it works

**States.** `waiting`, `ready`, `working`, `needs_check`, `stuck`, `done`, `skipped` (`TASK_STATES` in `kernel/contracts/index.js`). The transition table is data there (`TASK_TRANSITIONS`). The doer starts a ready task. The kernel moves it to `needs_check` or `done` after checking its output. The checker moves `needs_check` to `done` or back to `ready`. A stuck task goes back to `ready` by a responsible person or a person with presence. `done` and `skipped` are terminal. `reopen` is a separate act, only for a task with no checker and no outward act.

**Roles on a task.** One `doer`, an optional `checker`, optional `helpers`, a `due` time, `depends_on` and `escalate_after`/`escalate_to` (`REQUEST_KEYS` in `kernel/tasks/tasks.js`). The app calls the checker the approver and shows followers as those who follow it.

**Output.** The task declares one output kind: `fields`, `note`, `draft`, `sent`, `decision` or `file`. `checkOutput` checks the format. A `note` needs text and a source, and a `decision` needs yes or no and a reason. These are format checks and say nothing about truth. A task that gates a stage, a send or a payment needs a human checker.

**Approval.** `tasks.decide` is accepted only from a chain that is exactly one person, with a hardware presence proof over the exact payload, once. The proof rides beside the request and never in the body (`core/tasks-tools/index.js`).

**Stages.** A record type can have stages with required tasks. Leaving a stage with required tasks not `done` is refused with `stage_tasks_open` (`kernel/gateway/records.js`). `stage` and `status` on the `task` record type are `owned_by: "kernel"`, so no one writes them by hand.

**Sources.** `TASK_SOURCES` in `records/core-types.js`: `gate_hold`, `grant_request`, `pairing`, `kit_install`, `reveal_request`, `continue_in_space`, `flow_step`, `assistant_request`, `memory_proposal`, `manual`. A held send, a grant request and a Flow step that needs a person are all tasks, which is why one list shows them.

**Waking an agent.** `core/daemon/agent-wake.js` picks up a ready task whose doer is an agent, see [Agents](./agents.md). If the agent cannot start or ends without handing in, the task is marked stuck with a reason and a suggested fix, and it surfaces to the assigner and approver.

**The Needs you list.** `waiting.list` and `waiting.count` (`core/waiting`) return rows by kind: `approval`, `ask`, `draft`, `access`, `run`, `task`, `eval`, `reminder` and `pairing`. The module emits `waiting.changed` with the count and per-kind counts only when they move.

**Snooze is device-local.** `apps/app/src/state/snooze.ts` keeps Later in the device's own store under vyre.needs.later. The engine has no snooze for a task, an ask or a held send, and nothing is sent anywhere. Another device still shows the card.

**Events.** task.created, task.readied, task.unblocked, task.started, task.stuck, task.completed, task.approved, task.rejected, task.skipped, task.voided, task.edited, task.reopened.

**Checks on a call.** The task actions are `tasks.request`, tasks.read, tasks.work and `tasks.decide`, registered with the authorizer. Deny looks like absence. A task a caller may not read returns null from `tasks.get`.

**Playbooks.** A Playbook is a record of kind `project-template`, one record per version (`core/work/templates.js`, shape and checks in `lib/project-template.js`).

- *What it holds.* A name, a description, a noun for its projects ("Job", "Jobs"), tags, roles, stages and automations. A stage has a name, an optional `owner` (who may move it early), a condition `moves_on_when` and its tasks. A task has a title, a `doer`, an optional `checker`, an output kind, a brief with `{record.field}` filled in, a checklist, the Connections it may use, `depends_on`, a due offset and `required`. A template has 2 to 40 stages and up to 30 tasks per stage.
- *The doer.* A doer is `person:<id>`, `role:<name>`, `teammate:<agent>`, `assistant:<name>`, `actor:<id>`, or one of `lead`, `owner` and `creator`. A template role can name an agent of the roster, and one role can be the project lead. Each task therefore goes to a person or an agent. The doer `lead` is whoever holds the Lead seat, and the project's owner when nobody does. A role nobody holds leaves the task unmade, and the start result lists it under `tasks_skipped`.
- *Versions.* `work.template.define` writes a draft. `work.template.test` runs it on a sample and creates nothing. `work.template.golive` puts it live and retires the live one. Only the template's owner or an admin does that, and an assistant can prepare it for them or propose it as a card. A running project keeps the version it started with, because the stages are pinned on the project when it starts.
- *Starting a project.* `work.start-project` takes a live template, a name and optionally a client record, and makes the project, adds the roles' agents to its team, pins the stages and makes the first stage's tasks. The result says how many tasks it made and which it skipped. The same call is the Flow step "Start a project from a template" (`call` to `work.start-project`). A stage that has tasks moves on when its required tasks are done and its `moves_on_when` condition holds. A stage with no tasks waits for a person to move it.
- *Where Playbooks come from.* `work.template.library` lists those the Kits ship, `work.template.install` copies one in as a draft, and `work.template.from-project` makes a draft from a finished project.
- *Picking a Playbook for a record.* The code holds no rule that maps a record type or field to a Playbook. The caller names the template: a person chooses it, an agent passes it, or a Flow does. To pick by type or field, write one Flow per case: a record trigger with a `where` on the field, and a "Start a project" step that names that Playbook and links the record as its client. See tracks in [Flows](./flows.md). A record type's own stages, by contrast, come from its stage sets (see [Records](./records.md)), and `kernel/flows/stages.js` creates the stage's tasks from those.

## Where the code lives

- `kernel/tasks/`: the task store, transitions, approvals, card builder.
- `kernel/contracts/index.js`: states and the transition table.
- `core/tasks-tools/`: the app's task tools over the kernel store.
- `core/waiting/`: the Needs you list.
- `core/ask/`: several questions as one card.
- `core/daemon/agent-wake.js`: waking agents.
- `core/work/templates.js`, `lib/project-template.js`: Playbook versions, tools and checks. `kernel/flows/stages.js`: makes the tasks of a stage and moves a project on.
- `apps/app/screens/now/`: Needs you and the task screen.
- `apps/app/ui/tasks/`: cards, facts, ask kinds.
- `apps/app/src/state/snooze.ts`: device-local Later.

## How agents use it

- An assistant gives work with tasks.assign (title, doer, optional checker, record, output), built in `kernel/tools/surface.js`. The tool is cut down to what the caller's grants allow, and its source is `assistant_request`.
- An agent in a task flags its own trouble with the kernel's `stuck` act and hands in its output. It cannot approve, because `tasks.decide` refuses a non-person chain.
- The app's tools `tasks.list`, `tasks.get`, `tasks.request`, `tasks.decide`, `tasks.move` and `tasks.submit` are `reach: person`. `tasks.serve` is `modules`, for a team member's reads on the team's server.
- An agent asks a person a question with `ask.many`, see [Chats](./chats.md). A send goes through `gate.request`, see [Gate](./gate.md).
- An agent writes a Playbook with `work.template.define` and tests it with `work.template.test`. Only an owner or admin puts it live.
- See authority (agent doc "authority") and tools (agent doc "tools").

## Extend it

- In 0.5, an agent step has no deadline. A session that ends without finishing is marked stuck, and one that never ends is not timed out. 0.5.1 plans a due time with a failure path (R051-03), and credentials lent to a woken agent for one job, use only (R051-02).
- A "For each" step takes up to 50 items in the editor, and a longer list is cut without a note on the run page.
- Tasks and files of a project belong to that project's team. Who can read a Space-defined record type is covered in [Records](./records.md).
- Later is local to the device in 0.5, so another device still shows the card.
- For your own task source, a custom check or a new stage rule, build a custom module. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related

- [Agents](./agents.md), [Chats](./chats.md), [Flows](./flows.md), [Gate](./gate.md), [Kernel](./kernel.md), [Records](./records.md)
- [Map](../map.md), [Overview](../overview.md)
- [Planner](../../using/planner.md), [Teammates](../../using/teammates.md), [Flows (using)](../../using/flows.md)
- [Presence](../../concepts/presence.md), [Events reference](../../reference/events.md), [Tools reference](../../reference/tools.md)
