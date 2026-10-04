# flows (sessions teammate, Vyre 0.3): Flow runner, Flows as TypeScript, Kits, Flow canvas data

Branch work/flows, worktree vyre-sessions-03, off origin/main with origin/work/kernel merged (kernel/contracts).

## Scope
1. Flow runner (contract 9): triggers (event pattern, time, inbound web call, manual, enters-stage), steps (find, create, update, remove, upsert, pick, filter, decide, repeat, wait, ask, assign, call, stage, agent, classify, http, fn), every step authorized as the approver's narrowed chain, at-least-once safety keyed by (flow, trigger event, step), versioning, loop limit, simulation over past events, runs stored as records.
2. Flows as TypeScript (contract 5.6): `defineFlow` and friends, a source-only parser of the declarative subset, a canonical printer, round trip with the stored form. Records owns the rest of the language compiler; I own the Flow part and a small Expression evaluator.
3. Kits: install with the grant card, update with a diff of widenings, remove cleanly.
4. Flow canvas: the data API (graph, runs, see-as-code, edit-as-code) and a canvas component if native-core asks.

## Layout
All code under `kernel/flows/` (pure ES modules, built on kernel/contracts types, tests beside the code):
- `expr.js` the Expression evaluator (no eval, bounded)
- `schema.js` stored form, canonical JSON and hash
- `compile.js` validate a Flow against a catalog (types, actions, roles), with an effects summary for the approval card
- `text.js` TypeScript text form: print canonical, parse the declarative subset
- `sdk.js` defineFlow and the step helpers (merged into @vyre/sdk by records)
- `runner.js`, `triggers.js`, `steps.js`, `store.js`, `simulate.js` the runner
- `kits.js` install, update, remove

## Done (3 Oct)
- kernel/flows/expr.js: the Expression language, no eval, bounded (limits on size, nesting, nodes and steps); roots and step references for the compiler.
- schema.js: the stored form, every problem reported with a path, canonical JSON and hash (what an approval binds to). compile.js: unknown types, fields, stages, roles, teammates, templates and actions; sealed fields cannot be written; expression names and step order; caps must cover the steps (derived when absent); effects summary; cron.
- text.js: TypeScript text form. Printer is canonical and idempotent; the parser is source-only and refuses everything outside the declarative subset with a line number; a Code step's source is an opaque span (E-3 tested); null-prototype build; limits; bounded worker. sdk.js and sdk.d.ts: defineFlow, step.*, expr.
- store.js: MemoryFlowStore and RecordsFlowStore (definitions, approvals, state and runs as records). runner.js: triggers, ledger, authority, taint, waits, tasks, idempotency keys, loop control, versioning, recovery, simulation. simulate is a runner method.
- kits.js: card, diff with widenings and risks, install through a task, update, remove. canvas.js: graph, paintRun, seeAsCode, fromCode, flowChanges, ops. index.js: createFlows and the tools.
- 76 tests in kernel/flows (fake kernel in testing/). Pushed: work/flows.

## Done (3 Oct, relaunch)
- Merged work/kernel and work/records. kernel/flows/testing/real-kernel.js: the real gateway, tasks, presence and chain builder behind the Fake's surface; every missing piece is a SHIM(name) block, listed in team/0.2/CHAT.md. world.js takes `kernel: "real"`; real.test.js runs the runner on it.
- kernel/flows/stages.js: stages made of tasks, a module over record.stage-entered and task state events (tasks made once per entry, depends_on wired, advance once when required tasks are done, hand-moved records left alone, re-entry makes new tasks). Registered in createFlows (`stages: { approver }`). stages.test.js runs on both kernels.
- kernel/flows/e2e/estate.e2e.test.js: Estate planning kit (records' kit.ts compiled by their compiler) from a Stripe payment to the next stage on the real kernel. 93 of 93 on testbox.

## Triggers (5 Oct, fork T)
- kernel/flows/triggers.js is the trigger registry: five kinds and no others, each one entry (stored `on` values, shape check, plain words, expression scope, source label, how it is armed). schema, compile, canvas and the text form read it. watcher = `watcher`, schedule = `time`, record event = `event` and `stage`, form or hook = `web`, person or assistant = `manual`.
- Watcher: `{ on: "watcher", watcher, where? }`. `runner.watcherItem({ watcher, item })` starts the Flows armed on it, once per item, tainted `external`, item as `trigger.item`. kernel/flows/watcher-bridge.js adapts the watchers module (`watcher.fired`, then `watchers.items`) through injected ports; core/watchers is untouched. The host (daemon) must call `bridgeWatchers({ runner, on: ctx.events.on, call: ctx.call })`.
- Schedule: cron is read in the Space's zone (`catalog.tz`, or `trigger.tz`, default UTC; kernel/flows/zone.js, DST rules written there: a gap runs once after it, an overlap runs once at the first occurrence). The last run is kept in the store (`getSchedule` and `putSchedule`; record type `flow-schedule`), so a restart catches up ONCE (`caught_up`, `missed`). Existing homes need `store.define()` again for the new type.
- Every run records `trigger: { kind, source, at, input (capped at 64 KB, sealed values replaced), key, caught_up?, missed?, tz? }`; `paintRun` returns `why` and `fired` on the trigger node.
- Not done: the daemon wiring of `bridgeWatchers` and a `catalog.tz` from the Space's setting (both host side); the canvas component for trigger nodes (native-core).

## Doing
All six relaunch items have a first cut (4 Oct): real-kernel harness + stages + Estate e2e (kernel/flows), sessions under Wink (core/space-sessions, docs/work/sessions-spaces.md), door retrofit (docs/work/door-retrofit.md). Waiting on platform for the gateway gaps listed in team/0.2/CHAT.md (sessions -> platform, 3 Oct).

## Next
00. Open: confirm with lead plaintext-over-Wink for working copy sync; platform to allow continue_in_space source, ctx.model/ctx.chainFor, door.stream; vault release({purpose:"workcopy"}); kernel bug: required task with no checker waits forever; records kit.ts uses defineField.ref (now link). Native-core canvas data on request (kernel/flows/canvas.js).
0. Drop each SHIM in real-kernel.js as platform lands it; run the whole flows suite on the real kernel once tests stop reading the Fake's internals (kernel.tables, kernel.tasks).
1. Wire createFlows into the module host once platform's gateway lands (tools to manifest, reach, docs:ref). Until then nothing registers in today's registry.
2. Canvas component for the Deck if native-core asks (the data API is canvas.js).
3. Merge sdk.js into @vyre/sdk with records (language compiler is theirs).
4. Record each cap as a grant with `parent` = the approver's grant when the gateway's grants.create takes `parent` (today the runner enforces caps itself).

## Needs from others
- platform (kernel), all additive: (a) events written under an automation chain carry `corr` = the run id (chain.job.run); (b) records and ask calls take a fifth argument `{ idem }` and the gateway dedupes on it; (c) after an approved `flow_step` held-act task, `authorize` allows once the same (chain, action, resource) when called with `approval: <task id>`; (d) event `record.stage-entered` { type, id, stage }; (e) event `task.completed` { task, state, outcome, answer }; (f) actions `flows.run`, `kits.install`, `kits.remove`, `ask.request`, `model.call`, `http.request`, `fn.run` in the registry with their risks; (g) a `template` record type, `def_role` and `def_view`.
- records: the @vyre/sdk package and the Kit language compiler; where Kit text lands. My Kit shape is `includes: { types, templates, roles, teammates, views, flows, seed }` (kits.js kitParts); tell me if yours differs.
- native-core: the Flow canvas spec in team/0.2/CHAT.md. Data API is kernel/flows/canvas.js (graph, paintRun, seeAsCode, fromCode, flowChanges, ops).

## Changed contracts
None to kernel/contracts. Additive asks above.
