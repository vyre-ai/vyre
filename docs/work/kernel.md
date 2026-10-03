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

## K2a done

- kernel/store (memory, query, values), kernel/conformance (suite, memory test with 5 broken-store checks), kernel/gateway (records, index).
- Decisions: a deny on read is `null`, on write `not_found` with the true code in `hidden_reason` and an `access.denied` event. Query returns the store's page filtered by the gateway (short pages allowed, up to 10 store pages to find a visible row); totals are computed by the gateway over allowed rows only. An `unavailable` store answer leaves the intent open for `recover()`; definite refusals close it as compensated.

## K2b done (awaiting reviewer-2)

- kernel/retrofit/gates.js, gates.test.js; Registry.call takes deps.gates (default off). golden.test.js runs the recorder with the gates on and requires zero changed cells.
- Not yet moved into the kernel (stays in the registry, in order): input schema, projectArg and the agent grant lookup, the rules hook, proof verification, the asked-match, idempotency. Default-on needs `kernel/` in package.json files and a release that ships it, so that is a launch decision, not made here.
- Retrofit-only pieces to delete at K6: `fromLegacy` on the chain builder, `Via.legacy`, parseCaller.

## K3 done (awaiting reviewer-2)

- kernel/seal (normalize, classes, detect, engine, serve, client, index), kernel/model/door.js, kernel/core/gate.js.
- The process is Node for now. The line protocol in serve.js is the contract; the client takes any command that speaks it, so a Rust process (the lean from the kernel decisions) can replace it without touching the kernel. The language spike is still open and is the lead's call to schedule.
- Known gap: Node 22's permission model has no network deny, so the sealing process can open sockets today. Closing it needs Node with `--allow-net`, an OS sandbox wrapper (a network namespace or seatbelt profile) or the Rust process under its own sandbox. Plaintext lives in that process's memory while merging (8.12 residual).
- Not here yet: K4 supplies the presence verifier (`verifyPresence`) and `approvedTask`; the connector egress adapters; per-actor lookup rate limits (equality is not offered at all yet); sealing an existing field's values (8.9 migration); uniqueness check at write time.
