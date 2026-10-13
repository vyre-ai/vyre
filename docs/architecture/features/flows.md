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
Every step goes through the kernel as the approver's narrowed chain, so a Flow never reaches more than the person who approved it.

## What a person sees

- The Flows screen lists each Flow with its health line (last run, this week, next run, what needs a person). The Flow screen has the builder, the code view, a Versions list ("Version 3 (running)") with what changed and a way back, and Run history.
- The builder opens with "When does this start?" choices: A record is created, A record is created or updated, A record is removed, A record enters a stage, A person signs up, A form is submitted, On a schedule, Something happens in Vyre, Something new arrives, Someone runs it.
- "What should happen next?" opens a searchable step palette in groups: Logic (If / else, For each, Side by side, Wait, Wait for someone's yes), Records (Find records, Look up one record, Keep only some of a list, Create a record, Update a record, Find or create a record, Remove a record, Move to a stage), Calculate (Formula), Send (Send an email, Send a text), Web, AI (Hand to an agent, Sort into groups, Pull out facts) and Work (Assign a task, Start a project, Run another flow).
- Text boxes take tokens such as `{client.first_name}`, `{now}` and `{today}`, with an offset (`{appointment_at - 1 day}`) and a format (`as date`, `as time`, `as weekday`, `as weekdaytime`, `as iso`). The builder turns them into expressions.
- A run page shows "Step by step" with each step's status (Done, Failed, Waiting, Waiting for a person, Not reached), when a wait wakes, "Version approved by" the approver's name, and a "Retry this run" button for a failed run.
- Anything a Flow holds for a person appears in Needs you. See [Tasks and Needs you](./tasks-and-needs-you.md) and [Gate](./gate.md).

## How it works

**Stored form.** A Flow is a record of the reserved kind `def-flow`; each run is a record of kind `flow-run`, so both inherit history, grants and audit (`kernel/flows/store.js`). A definition never changes: an edit is a new version with a hash. `flows.approve` binds one (flow, version, hash) to the approver, and only an approved version can be active. `flows.rollback` goes back to an earlier version and asks the person again; nothing is inherited from the old approval. A saved test case that fails blocks approval.

**Triggers** (`kernel/flows/triggers.js`, five kinds):

| Kind | Stored `on` | Started by |
| --- | --- | --- |
| person | `manual` | someone or an assistant, through `flows.start` |
| schedule | `time` | cron, `every_ms` (at least a minute) or `at`, read in the Space's time zone, with business hours and holidays |
| record | `event`, `stage` | a record event pattern (optionally one changed `field`), or a record entering a stage |
| form | `web` | a form submission or an inbound call to the Flow's path |
| watcher | `watcher` | something new in a watched place such as a mailbox or folder |

A run id is a hash of the Flow and the trigger key, so a trigger delivered twice is one run. For a record trigger that says "created or updated", a second change replaces the waiting run (`when_record_changes`).

**Steps** (`STEP_KINDS` in `kernel/flows/schema.js`): find, pick, filter, create, update, upsert, remove, decide, repeat, parallel, branch, subflow, wait, ask, assign, call, stage, agent, classify, extract, service, fn. A Flow has at most 200 steps, 6 levels of nesting and 1000 repeats. The editor's "Send an email" and "Send a text" are `service` steps; "Wait for someone's yes" is `ask` (to `person:` or `role:` only); "Assign a task" is `assign`; "Hand to an agent" is `agent`. Each step may carry `timeout_ms`, `retry` (only for named transient errors), `on_fail` and `verify`.

**Values.** A value is a literal or `{ expr }`. Expressions are parsed, never evaluated as code (`kernel/flows/expr.js`), and read `trigger`, `steps.<id>`, `run`, `now` and `tz`. Functions include `format`, `date`, `datetime`, `addtime`, `coalesce`, `text`. A missing value prints as empty; a sealed field prints its placeholder. Record rules use the separate evaluator in `kernel/expr/index.js`.

**The runner** (`kernel/flows/runner.js`):

- Authority: a run has the chain [automation:<flow>, approver]. Each effect step is checked against the Flow's declared caps, then `authorize` is asked. A lost grant (revoked, not a member, expired) pauses the Flow with the reason.
- Replay: each step is written to the run's ledger before and after it acts, keyed by run, step and loop index, and the key doubles as the idempotency key. A branch, a loop's list and a wait's deadline are recorded once and reused.
- Taint: a run started by or reading external or untrusted content is tainted; its outward and grant steps ask a person.
- Models: a Flow with `authorship: "model"` that computes an outward recipient asks a person each time.
- Sends: an approved version carries one yes for its destinations and limits (`sends.allow`, `max` default 100, `per_minute` default 10, `outside`). A step with `approve: true`, a recipient from outside content, or a bound that is hit still stops for a person (`kernel/flows/standing.js`). A held send is a task of source `flow_step` with form kind `held_act`; the person's decision gives the Flows service a single-use approval for exactly that act (`kernel/approval-token.test.js`).
- Loop control: correlation depth 8, a per-Flow rate limit and a step cap. A runaway pauses the Flow and raises a card.
- Switch: `flows.pause` with `all` or `drain` holds new triggers in order; `flows.resume` runs them, or drops them with `backlog: "drop"`.

**Events** emitted by the runner: `flow.started`, `flow.queued`, `flow.finished`, `flow.paused`, `flow.cancelled`, `flow.retried`, `flow.stale`, `flow.stuck`.

## Where the code lives

- `kernel/flows/schema.js`: stored form, step kinds, limits, canonical form and hash.
- `kernel/flows/triggers.js`: the trigger registry, `whyRan` sentences.
- `kernel/flows/runner.js`: runs, ledger, waits, held acts, simulation.
- `kernel/flows/store.js`: definitions, versions, approvals and runs as records.
- `kernel/flows/expr.js`: expression parser and functions; `kernel/flows/standing.js`: what one yes covers for sends.
- `kernel/flows/compile.js`, `kernel/flows/text.js`, `kernel/flows/cheatsheet.js`: caps, the text form, the agent cheatsheet.
- `kernel/expr/index.js`: the rule evaluator for stage rules.
- `core/flows/index.js`, `core/flows/module.json`: the `flows.*` tools; `core/flows/member.js`: a team member's own Flows.
- `core/daemon/flows-host.js`: builds the assembly and mints the grants; `core/daemon/agent-wake.js`: wakes an agent on a task.
- `apps/app/screens/flows/`: Flows list, Flow screen, `RunPage.tsx`, `FlowHistory.tsx`; `apps/app/ui/flows/`: builder, palette, template composer.

## How agents use it

Every call runs under the caller's own chain; a call with no person or session chain is refused. Open to models: `flows.define` (nothing runs until a person approves), `flows.propose`, `flows.start`, `flows.get`, `flows.list`, `flows.code`, `flows.graph`, `flows.card`, `flows.simulate`, `flows.cheatsheet`, `flows.runs`, `flows.run`, `flows.health`, `flows.attention`, `flows.patch`, `flows.from-chat`. Person-only: `flows.approve` (also asks for presence), `flows.rollback`, `flows.pause`, `flows.resume`, `flows.kit.remove`, `flows.access.get`, `flows.access.set`, `flows.settle`, `flows.advance`, `flows.test.remove`. An agent step becomes a task for the named agent; the wake itself is in `core/daemon/agent-wake.js`. See Flows for agents (agent doc "flows"), the Flows cheatsheet (agent doc "flows-cheatsheet") and outward acts (agent doc "outward-acts").

## Limits today

- A "For each" step handles up to 50 items in the editor, although the engine allows 1000, and a longer list is cut without a note on the run page.
- An agent step has no deadline yet. A session that ends without finishing is marked stuck, but an agent that never ends is not timed out.
- A Flow email cannot yet carry CC, BCC or attachments.
- Members cannot inspect a Flow over MCP (`flows.describe`, `flows.runs` and `flows.connections` are for owners).

## Related

- [Gate](./gate.md), [Tasks and Needs you](./tasks-and-needs-you.md), [Records](./records.md), [Agents](./agents.md), [Kernel](./kernel.md)
- [Architecture map](../map.md), [Architecture overview](../overview.md)
- [Flows and Kits](../../using/flows.md), [Watchers](../../using/watchers.md), [Time zones](../../using/time-zones.md)
- Flows for agents (agent doc "flows"), Flows cheatsheet (agent doc "flows-cheatsheet"), [Tools reference](../../reference/tools.md), [Events reference](../../reference/events.md)
