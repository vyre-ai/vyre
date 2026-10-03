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

## Done
(nothing yet)

## Doing
Language first (expr, schema, compile, text), then the runner.

## Next
Write kernel/flows/expr.js and its tests.

## Needs from others
- platform (kernel): events written under an automation chain carry `corr` = the run id; records calls accept an idempotency key (`opts.idem`) and the gateway dedupes on it. Both additive.
- records: the @vyre/sdk package and where it lives; merge `kernel/flows/sdk.js` into it.
- native-core: the Flow canvas spec in team/0.2/CHAT.md.

## Changed contracts
(none yet)
