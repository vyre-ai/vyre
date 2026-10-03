# kernel

Branch: work/kernel · Worktree: ../vyre-kernel · Owner session: platform

## Done
- kernel/contracts: the studs (types and frozen tables, no logic).

## Doing
- Pushing the studs; then K0 (golden-decision recorder), K1 (authorize, kernel-built chain, event envelope), K2 (gateway, store interface, in-memory reference store, conformance suite).

## Next
- K3 sealing (separate process, inference door, seal ledger), K4 tasks with approval, K5 audit chain, K6 module supervisor.

## Needs from others
- reviewer-2: review each K phase before it merges.
- launch: tell me when work/rc-0.2.2 lands on main so I move onto main.

## Changed contracts
- none yet (new package kernel/contracts)

## K0 done

- kernel/golden: recorder (dump.mjs, matrix.js, index.js), golden.json, golden.test.js. Decisions only; no tool body runs. The schema check is recorded apart (`emptyBad`) so it does not mask the gates after it.

## K1 done (awaiting reviewer-2)

- kernel/core: ids, canonical, urn, errors, chain, authorize, events, core.test.js (31 tests).
- Decisions: unknown action is `deny unknown_action` (fail closed, no grant can name it). Outward and approver asks stay `ask` until K4 records an approval. Presence is met only by a held session or a verifier the K4 signer supplies; without one a claim counts for nothing. Rate limits and residency conditions are not evaluated yet (K2 meters, K3 residency).
