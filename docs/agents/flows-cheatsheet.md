---
title: Flows cheat sheet
summary: The whole Flows language on one page, generated from the code: triggers, every step kind with an example, retry, failure paths, checks, expressions, limits.
audience: agents
owner: docs
status: stable
tokens: 1800
when: You are about to write or change a Flow and need the exact keys, an example of each step, and the limits.
---

<!-- agent:cheatsheet:start -->

# Flows cheat sheet

A Flow is a trigger and steps. Write it in the lines form (tools_call flows.code with format lines; tools_call flows.patch edits it). Names a step makes are read as `steps.<id>`; the trigger as `trigger`; a failure path reads `error`; a check reads `output`.

## Shape
```
name: my_flow
authorship: model
trigger: {on: event, event: payment.received}
steps:
  who find type=client where=`record.email == trigger.email`
  mark update type=client record=`steps.who.rows[0].id` set={tagged: true}
on_failure:
  tell assign to=role:partner title="A run failed" output={kind: note}
```
A `key=value` value is a word, number, "string", [list], {key: value}, or a `backtick expression`. Optional keys: label, description, caps, concurrency, lock, stuck_after_ms, on_failure. In `if`, `where`, `over`, `from` and `check` the whole value is expression text; inside `set`, `match`, `input` and the like a value is a plain value, or a `backtick expression` to compute it.

## Triggers
- watcher: keys on, watcher, where; reads trigger; e.g. `{on:watcher,watcher:new-mail}`
- time: keys on, cron, every_ms, at, tz, hours, holidays, catch_up; reads trigger; e.g. `{on:time,cron:0 9 * * 1-5}`
- event | stage: keys on, event, where, type, stage; reads trigger, event; e.g. `{on:event,event:payment.received,where:trigger.amount > 0}`
- web: keys on, path; reads trigger; e.g. `{on:web,path:intake}`
- manual: keys on, input; reads trigger; e.g. `{on:manual}`

## Steps (id kind key=value; each also takes timeout_ms, retry, on_fail, verify unless it says otherwise)
- find: type, where, limit, sort
    who find type=client where="record.email == trigger.email" limit=5
- pick: type, where
    one pick type=client where="record.email == trigger.email"
- filter: from, where
    open filter from=steps.who.rows where="record.status == \"Open\""
- create: type, set
    make create type=matter set={client: `trigger.client`, stage: Intake}
- update: type, record, set
    mark update type=matter record=`steps.make.record.id` set={stage: Active}
- upsert: type, match, set
    save upsert type=client match={email: `trigger.email`} set={name: `trigger.name`}
- remove: type, record
    drop remove type=matter record=`steps.make.record.id`
- decide: if, then, else; only on_fail, verify
    big decide if="trigger.amount > 1000" else=[]
      then:
        alert assign to=role:partner title="Large payment" output={kind: note}
- repeat: over, as, steps, max; only on_fail, verify
    each repeat over=steps.who.rows as=row max=50
      steps:
        tag update type=client record=`row.id` set={tagged: true}
- parallel: steps; only on_fail, verify
    both parallel
      steps:
        left branch
          steps:
            mail create type=matter set={client: A}
        right branch
          steps:
            note create type=matter set={client: B}
- branch: steps; no policy keys (its steps have their own)
    left branch
      steps:
        mail create type=matter set={client: A}
- subflow: flow, input; only on_fail, verify
    welcome subflow flow=send_welcome input={client: `trigger.client`}
- wait: for_ms, until, event, where, timeout_ms, on_timeout; no timeout_ms
    pause wait for_ms=3600000
- ask: to, title, form, record
    yes ask to=role:partner title="Send the welcome email?"
- assign: to, title, record, output, how, template, checker, await, skills
    task assign to=teammate:paralegal title="Draft the engagement letter" output={kind: draft}
- call: action, resource, input, with
    mail call action=email.send resource=vyre://space/email/outbox input={to: `trigger.email`, subject: Welcome}
- stage: type, record, to
    move stage type=matter record=`steps.make.record.id` to=Active
- agent: assistant, title, instructions, record, output, await, skills
    draft agent assistant=teammate:paralegal title="Summarise the file" instructions="Read the file and write a short summary." output={kind: note}
- classify: input, labels
    kind classify input=`trigger.message` labels=["new client", "existing client", spam]
- extract: input, fields
    facts extract input=`trigger.message` fields=[{name: phone, kind: text}]
- service: connector, method, path, query, headers, body, drive, connection, operation, input
    crm service connection=orbit-crm operation=customers.list input={limit: 1}
- fn: language, source, hash, inputs, outputs, needs
    calc fn language=js inputs={a: 1, b: `trigger.amount`} outputs=[total] source=<<<
      return { total: inputs.a + inputs.b };
    >>>

## Lanes, other Flows, schedules
- `parallel`: lanes (2 to 8 `branch` steps) run together; the next step waits for all and reads any lane's step as `steps.<id>` (lanes cannot read each other). A failed lane fails the step; a retry reruns only it.
- `subflow flow=<name> input={...}` runs another active Flow; its top-level `returns` is `steps.<id>.result`.
- `call` step `with=<earlier send step>`: this send rides that step's yes (one question names both; the earlier tool must list this one in its `covers`; same path, not out of a loop or lane).
- A time trigger: `hours=true` (weekdays 9 to 17) or `{days, from, to}`; `holidays=[dates]` or `space`; `catch_up=once|all|skip` after downtime.

## If it can fail
- timeout_ms 1-3600000; retry false | {attempts 1-8, backoff_ms n | [n...], on [timeout, unavailable, rate_limited, upstream_5xx, connection_reset, busy]}. Defaults: find 30 s x3, pick 30 s x3, filter 30 s x1, create 1 min x3, update 1 min x3, upsert 1 min x3, remove 1 min x3, stage 1 min x3, call 1 min x1, service 30 s x1, classify 1 min x2, extract 1 min x2, fn 10 s x1; other kinds do not retry. A refusal is never retried.
- on_fail={then: continue|stop, steps}: steps run if this one fails for good (they read `error.code`, `error.message`, `error.step`); `continue` carries on, `stop` (default) fails the run after them. No on_fail inside an on_fail.
- verify={check: `output.record`, essential: true|false, say: "what was checked"} or {readback: true} on create, update, upsert, stage. Put an essential verify on every step that changes something.

## Expressions
- Read: trigger, steps.<id>, run, now, the loop name in a repeat, error in a failure path, output in a check. Operators: == != < <= > >= && || ! + - * / %, a ? b : c, a.b, a[0].
- An event a module emits (documents.signed, comms.sent) keeps its facts under `payload`: `trigger.payload.<fact>`, and in a wait's where `event.data.payload.<fact>`.
- Functions: len, lower, upper, trim, startsWith, endsWith, coalesce, round, floor, min, max, number, text, isnull, days, hours, minutes. Nothing else is callable.

## Limits
- 200 steps a Flow, 6 levels of nesting, repeat at most 1000, a Code step's source at most 64 KB. Step ids: lowercase letters, digits, underscores, starting with a letter.
- A resource is a written-out vyre:// address. A sealed field cannot be written by a Flow. Nothing runs until a person approves the version; tools_call flows.propose checks it and runs its test cases first.

<!-- agent:cheatsheet:end -->
