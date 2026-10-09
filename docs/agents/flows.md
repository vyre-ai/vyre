---
title: Flows
summary: What a Flow is, the step kinds, how to propose a change to one, what the code step may and may not do.
audience: agents
owner: docs
status: stable
tokens: 800
when: You write, change, test or explain an automation, or a Flow step asks you to do something.
---

# Flows

A Flow is a small program: when something happens, run these steps. A step is done by Vyre, by an agent like you, or by a person. A Flow is a record, so it is versioned, granted, audited and can be undone.

## You propose, a person applies

You cannot change a Flow directly. Draft it and propose it (`tools_call flows.propose`). The proposal becomes a task for a person; their approval applies it, as them. A draft you can check without side effects: `tools_call flows.simulate` runs it against sample input and shows what each step would do.

## Steps

<!-- agent:flows:start -->

A Flow has up to 200 steps, nested up to 6 deep, and a repeat runs at most 1000 times.

| Step | What it does |
| --- | --- |
| `find` | read records of a type with a filter |
| `pick` | choose one record from what was found |
| `filter` | keep the items that match a condition |
| `create` | make a record |
| `update` | change a record |
| `upsert` | update a record if it exists, else make it |
| `remove` | delete a record (may be held) |
| `decide` | branch: then one list of steps, else another |
| `repeat` | do steps for each item (bounded) |
| `wait` | pause until a time or an event |
| `ask` | ask a person a question and wait for the answer |
| `assign` | give work to a person or agent as a task |
| `call` | run a tool of the Space |
| `stage` | move a record to a stage |
| `agent` | give one job to an agent |
| `classify` | label text with a fixed set of choices |
| `extract` | pull named fields out of text |
| `service` | run a connection's operation |
| `fn` | run a short piece of code in a sandbox (no network) |

<!-- agent:flows:end -->

## Writing a good Flow

- One trigger, a short list of steps, a name that says what it does.
- Put a person in the loop with `ask` or `assign` wherever a judgement call or an outward act is involved. Do not try to remove the person from a send.
- Name connections by id. Never put a credential in a step.
- Use `decide` for branching and `repeat` for lists. A repeat has a limit; stay under it.
- Test with `tools_call flows.simulate` before proposing. Say in the proposal what it will do and what it will not.

## The code step

`fn` runs a short piece of JavaScript in an operating-system sandbox. It has no network, no files outside its input, a time limit and an output cap. It cannot call tools. If the sandbox's self-test has not passed on this machine the step refuses to run, with a message that says so. Use `fn` for data shaping that the other steps cannot do. Prefer a built-in step when one fits.

## When a step runs as you

An `agent` step gives you one job. Do exactly that job, write the result to the record the step names, and finish. Do not widen the job. If you cannot do it, say why in the result so a person can take it.
