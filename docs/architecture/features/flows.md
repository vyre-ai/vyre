---
title: Flows
summary: A Flow is a stored list of steps that starts from a trigger, runs under an approver's authority, and stops for a person wherever a send, a question or a task needs one.
audience: builders, agents
owner: docs
status: stable
---

# Flows

## What it is

A Flow is "when something happens, do these steps": one trigger and a list of steps, kept as structured data and approved by a person before it runs.
Every step goes through the kernel as the approver's narrowed chain, so a Flow reaches no more than the person who approved it.

## What a person sees

- The Flows screen lists each Flow with its health line (last run, this week, next run, what needs a person). The Flow screen has the builder, the code view, a Versions list ("Version 3 (running)") with what changed and a way back, and Run history.
- The builder opens with "When does this start?" choices: A record is created, A record is created or updated, A record is removed, A record enters a stage, A person signs up, A form is submitted, On a schedule, Something happens in Vyre, Something new arrives, Someone runs it.
- "What should happen next?" opens a searchable step palette in groups: Logic (If / else, For each, Side by side, Wait, Wait for someone's yes), Records (Find records, Look up one record, Keep only some of a list, Create a record, Update a record, Find or create a record, Remove a record, Move to a stage), Calculate (Formula), Send (Send an email, Send a text), Web, AI (Hand to an agent, Sort into groups, Pull out facts) and Work (Assign a task, Start a project, Run another flow).
- Text boxes take tokens such as `{client.first_name}`, `{now}` and `{today}`, with an offset (`{appointment_at - 1 day}`) and a format (`as date`, `as time`, `as weekday`, `as weekdaytime`, `as iso`). A token can reach through links to other records, as in `{matter.client.phone}`. The builder turns tokens into expressions.
- A run page shows "Step by step" with each step's status (Done, Failed, Waiting, Waiting for a person, Not reached), when a wait wakes, "Version approved by" the approver's name, and a "Retry this run" button for a failed run.
- A Flow holds anything that needs a person in Needs you. See [Tasks and Needs you](./tasks-and-needs-you.md) and [Gate](./gate.md).

## How it works

**Stored form.** A Flow is a record of the reserved kind `def-flow`. Each run is a record of kind `flow-run`, so both inherit history, grants and audit (`kernel/flows/store.js`). A definition never changes: an edit is a new version with a hash. `flows.approve` binds one (flow, version, hash) to the approver, and only an approved version can be active. `flows.rollback` goes back to an earlier version and asks the person again, and nothing carries over from the old approval. A saved test case that fails blocks approval.

**Triggers** (`kernel/flows/triggers.js`, five kinds):

| Kind | Stored `on` | Started by |
| --- | --- | --- |
| person | `manual` | someone or an assistant, through `flows.start` |
| schedule | `time` | cron, `every_ms` (at least a minute) or `at`, read in the Space's time zone, with business hours and holidays |
| record | `event`, `stage` | a record event pattern (optionally one changed `field`, or a `where` condition), or a record entering a stage |
| form | `web` | a form submission or an inbound call to the Flow's path |
| watcher | `watcher` | something new in a watched place such as a mailbox or folder (optionally a `where` condition) |

A run id is a hash of the Flow and the trigger key, so a trigger delivered twice is one run. For a record trigger that says "created or updated", a second change replaces the waiting run (`when_record_changes`). A schedule trigger can add `hours`, `holidays` and `catch_up` (once, all or skip) for what to do after downtime.

**Tracks.** One record type can follow several tracks, such as a personal-injury case and an estate-planning case (see stage sets in [Records](./records.md)). Write one Flow per track. Give each a record trigger with a `where` condition on the field that names the track, for example `trigger.after.practice_area == "Personal Injury"`, and each Flow then runs only for its own records. A Flow can also start from a record entering a named stage.

**Steps** (`STEP_KINDS` in `kernel/flows/schema.js`): find, pick, filter, create, update, upsert, remove, decide, repeat, parallel, branch, subflow, wait, ask, assign, call, stage, agent, classify, extract, service, fn. A Flow has at most 200 steps, 6 levels of nesting and 1000 repeats. In the editor, "Send an email" and "Send a text" are `service` steps, "Wait for someone's yes" is `ask` (to `person:` or `role:` only), "Assign a task" is `assign`, and "Hand to an agent" is `agent`. "Start a project" is a `call` to `work.start-project`, see Playbooks in [Tasks and Needs you](./tasks-and-needs-you.md).

- **Find or create.** `upsert` looks for the record whose fields equal `match`. It creates one from `match` and `set` when none exists, and its output says `created` true or false. With `update={}` a found record stays as it is.
- **Waits.** A `wait` has exactly one of `for_ms`, `until` (a time, with an optional `offset_ms`) or `event` (with a `where`), and an `on_timeout`. The deadline is recorded once, so a replay keeps it.
- **Approvals.** `ask` puts a question to a person or a role and stops the run until they answer. A held send waits for a yes as described below.
- **Failure paths.** Each step may carry `timeout_ms`, `retry` (only for named transient errors), `on_fail` and `verify`. `on_fail` holds steps that run when the step fails for good. They read `error.code`, `error.message` and `error.step`, and `then` is `continue` or `stop` (the default). The Flow as a whole may carry `on_failure` steps that run when a run fails, such as a task for the partner. 0.5 reaches these in the code view and from an agent. The editor adds failure panels in 0.5.1.

**Values.** A value is a literal or `{ expr }`. Expressions are parsed, never evaluated as code (`kernel/flows/expr.js`), and read `trigger`, `steps.<id>`, `run`, `now` and `tz`. Functions include `format`, `date`, `datetime`, `addtime`, `coalesce` and `text`. A missing value prints as empty, and a sealed field prints its placeholder. Record rules use the separate evaluator in `kernel/expr/index.js`.

**The runner** (`kernel/flows/runner.js`):

- Authority: a run has the chain [automation:<flow>, approver]. Each effect step is checked against the Flow's declared caps, then `authorize` is asked. A lost grant (revoked, not a member, expired) pauses the Flow with the reason.
- Replay: each step is written to the run's ledger before and after it acts, keyed by run, step and loop index, and the key doubles as the idempotency key. A branch, a loop's list and a wait's deadline are recorded once and reused.
- Taint: a run started by or reading external or untrusted content is tainted, and its outward and grant steps ask a person.
- Models: a Flow with `authorship: "model"` that computes an outward recipient asks a person each time.
- Sends: an approved version carries one yes for its destinations and limits (`sends.allow`, `max` default 100, `per_minute` default 10, `outside`). A step with `approve: true`, a recipient from outside content, or a bound that is hit still stops for a person (`kernel/flows/standing.js`). A held send is a task of source `flow_step` with form kind `held_act`. The person's decision gives the Flows service a single-use approval for exactly that act (`kernel/approval-token.test.js`).
- Loop control: correlation depth 8, a per-Flow rate limit and a step cap. A runaway pauses the Flow and raises a card.
- Switch: `flows.pause` with `all` or `drain` holds new triggers in order. `flows.resume` runs them, or drops them with `backlog: "drop"`.

**Events** emitted by the runner: `flow.started`, `flow.queued`, `flow.finished`, `flow.paused`, `flow.cancelled`, `flow.retried`, `flow.stale`, `flow.stuck`.

## Where the code lives

- `kernel/flows/schema.js`: stored form, step kinds, limits, canonical form and hash.
- `kernel/flows/triggers.js`: the trigger registry, `whyRan` sentences.
- `kernel/flows/runner.js`: runs, ledger, waits, held acts, simulation.
- `kernel/flows/store.js`: definitions, versions, approvals and runs as records.
- `kernel/flows/expr.js`: expression parser and functions. `kernel/flows/standing.js`: what one yes covers for sends.
- `kernel/flows/compile.js`, `kernel/flows/text.js`, `kernel/flows/cheatsheet.js`: caps, the text form, the agent cheatsheet.
- `kernel/expr/index.js`: the rule evaluator for stage rules.
- `core/flows/index.js`, `core/flows/module.json`: the `flows.*` tools. `core/flows/member.js`: a team member's own Flows.
- `core/daemon/flows-host.js`: builds the assembly and mints the grants. `core/daemon/agent-wake.js`: wakes an agent on a task.
- `apps/app/screens/flows/`: Flows list, Flow screen, `RunPage.tsx`, `FlowHistory.tsx`. `apps/app/ui/flows/`: builder, palette, template composer.

## How agents use it

Every call runs under the caller's own chain, and a call with no person or session chain is refused. Open to models: `flows.define` (nothing runs until a person approves), `flows.propose`, `flows.start`, `flows.get`, `flows.list`, `flows.code`, `flows.graph`, `flows.card`, `flows.simulate`, `flows.cheatsheet`, `flows.runs`, `flows.run`, `flows.health`, `flows.attention`, `flows.patch`, `flows.from-chat`. Person-only: `flows.approve` (also asks for presence), `flows.rollback`, `flows.pause`, `flows.resume`, `flows.kit.remove`, `flows.access.get`, `flows.access.set`, `flows.settle`, `flows.advance`, `flows.test.remove`. An agent step becomes a task for the named agent, and `core/daemon/agent-wake.js` does the wake. See Flows for agents (agent doc "flows"), the Flows cheatsheet (agent doc "flows-cheatsheet") and outward acts (agent doc "outward-acts").

## Extend it

- In 0.5, a "For each" step takes up to 50 items in the editor, though the engine allows 1000. A longer list is cut, and the run page gives no note. A Flow written in the code view loops over up to the engine's 1000.
- An agent step has no deadline in 0.5. A session that ends without finishing is marked stuck. 0.5.1 plans a due time on the step with a failure path, and a failure panel on every step in the editor (R051-02).
- A Flow email carries no CC, BCC or attachments in 0.5. 0.5.1 plans all three, with date helpers (R051-06).
- In 0.5, `flows.describe`, `flows.runs` and `flows.connections` over MCP stay with owners, so a member cannot inspect a Flow that way.
- When a business needs a step the palette lacks, such as a lookup in its own system, build a custom module: a folder with `module.json` and an entry file that registers tools and emits events. A Flow calls its tools with a `call` step and starts from its events. Core loads modules from core/modules under the supervisor in kernel/modules. See [MODULES](../../MODULES.md), the [module contract](../../build/module-contract.md) and [writing a module](../../build/writing-a-module.md). An agent can write the module on the business's own server.
- For an outside app, an Integration is planned (R051-01 in the [roadmap](../../roadmap.md)). It wraps the app's API and brings its own Flow steps, triggers, connection and agent tools.
- The full list is in [known-gaps](../../known-gaps.md).

## Related

- [Gate](./gate.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Records](./records.md), [Agents](./agents.md), [Kernel](./kernel.md)
- [Architecture map](../map.md), [Architecture overview](../overview.md)
- [Flows and Kits](../../using/flows.md), [Watchers](../../using/watchers.md), [Time zones](../../using/time-zones.md)
- Flows for agents (agent doc "flows"), Flows cheatsheet (agent doc "flows-cheatsheet"), [Tools reference](../../reference/tools.md), [Events reference](../../reference/events.md)
