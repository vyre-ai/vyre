---
title: Flows
summary: What a Flow is, the step kinds, how to propose a change to one, what the code step may and may not do.
audience: agents
owner: docs
status: stable
tokens: 1500
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
| `find` | read records |
| `pick` | take one found record |
| `filter` | keep matching items |
| `create` | make a record |
| `update` | change a record |
| `upsert` | update if it exists, else make |
| `remove` | delete a record (may be held) |
| `decide` | branch: then steps, else steps |
| `repeat` | do steps for each item (bounded) |
| `parallel` | run lanes at once; waits for all |
| `branch` | one lane of a parallel step |
| `subflow` | run another Flow, get its result |
| `wait` | pause until a time or an event |
| `ask` | ask a person, wait for the answer |
| `assign` | give a person or agent a task |
| `call` | run a tool of the Space |
| `stage` | move a record to a stage |
| `agent` | give one job to an agent |
| `classify` | label text from choices |
| `extract` | pull fields out of text |
| `service` | run a connection's operation |
| `fn` | run short code in a sandbox (no network) |

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

## How a step fails, retries and is checked

Every step runs under a time limit and a retry rule, with defaults per kind (reads 30 s and 3 tries, record writes 60 s and 3 tries, a module tool or a service write one try, code 10 s); say `timeout_ms` or `retry: { attempts, backoff_ms, on }` only to change them. Only `timeout`, `unavailable`, `rate_limited`, `upstream_5xx`, `connection_reset` and `busy` are ever retried; a refusal, a missing power, outside content and a write that may have gone out are not, and a Flow cannot say otherwise.
- **If it fails.** `on_fail: { steps, then }` runs steps that read `error` (`error.code`, `error.message`, `error.step`): `then: "continue"` carries on (the step is `failed_handled`, `steps.<id>.failed` is true); `stop`, the default, fails the run after the steps ran. A Flow can also have `on_failure: [steps]`, run once before the run is called failed. A failure path cannot have one of its own. A `decide` or `repeat` takes `on_fail` and `verify` too (a check reads `output.branch` or `output.count`), but no `timeout_ms` or `retry`.
- **Check what a step did.** `verify: { check: "<expression over output>", say: "what was checked" }` fails the step (`verify_failed`) when false; `essential: false` only flags it. On a write, `verify: { readback: true }` reads the record back and compares what was set. Put an essential verify on every step that changes something: a write that did not take is then a failure, not a success.
- **After a failure.** `flows.retry` resumes at the step that stopped; finished steps are not repeated. `skip: true` skips it (if a later step reads its output, a person gives `value` to use instead; you propose the value, they accept it). `version: "latest"` moves the run to the active version when every step already done is still there. `flows.cancel` ends a run for good.

## Reading how Flows are doing

`flows.list` gives each Flow a one-line health (red when a Connection it uses is red or a saved test fails); `flows.health` the same for one; `flows.control` says whether everything is paused or draining. `flows.describe` reads a Flow or a run in a few lines; `flows.timeline { run }` reads a run one line a step (`step` for one in detail). `flows.diff { id, from, to }` says what changed between versions; `flows.rollback` goes back and a person approves. Read these before a whole Flow.

## Write, test and stage Flows

- Read `flows-cheatsheet.md` first. `flows.code`, `flows.define` and `flows.compile-text` take `format: "lines"`; change a Flow with `flows.patch { id, base, ops }`.
- `flows.test.save` keeps a test case (`{ id, name, event | input, expect }` or `{ id, from_run }`); `flows.test.run` runs them. No version is approved while one fails. `flows.propose` also compiles and replays last week; you cannot skip it.
- `flows.attention` lists runs that need a person; `flows.settle { run, action: retry | skip | stop }` answers.
- `flows.describe { run }` explains a run. A stage with tasks is a gate run: `flows.advance { run, reason }` moves a record on early (its owner or an admin).
- `flows.kit.test` tries a Kit on a sample, sending nothing. A task may have a `brief`, `checklist`.
