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

## Re-gate round (3 Oct 2026, after the account switch)

Done, pushed to origin/work/kernel (f43c4e570 and later):
- K1 items 1 to 5 and the `..` fix with reviewer-2's probes as tests (core.test.js "K1-*", urn test). A wildcard covers only read and write actions and needs an integer action_set_version; unknown trust or class is an error or most restrictive; a child grant dies with its adder's membership; absent attributes never match.
- K2-1 (sealed fields unqueryable by a model chain, read from the new `Store.describe`; suite revision 2), K2-2 (needsPresence and needsAsk: only `allow` means no requirement), K2-3 (`createLegacyChainBuilder`, legacy Space only), K2-4 (recover completes only on an exact expected-data match, else `unresolved`; intents expire after 24 h), K2-6 (`gateway.events.read(chain, filter)` and `subscribe(chain, ...)` through authorize and vis; consumer names are per actor), K2-8 (type and id validated on every call), K2-11 (intent max age).
- Field kind `ref` renamed `link`; the old web-address `link` is now `url`.
- Sealing is vault's: my kernel/seal and kernel/model removed, origin/work/sealing merged. `kernel/gateway/sealing.js` wires it: authorize first, destination, approver chain, proof and template body derived from providers (`destinations`, `approvals`, `templates`), `door.ledgerKey` into every reveal, `isChain` before any chain summary. Door takes an optional `isChain` (the kernel's) at wiring.

## Needs from others
- K4 (tasks) supplies `approvals`; until then `gateway.seal.use` and `deliver` refuse `unavailable`. reviewer-2 re-gates K1 and K2.

## Changed contracts
- `Store.describe(type)` added; `FieldKind` `ref` to `link`, `link` to `url`; `kernel/door/door.js` gains an optional `isChain` option.

## Next
- Done since: K1 8a, 9a, 9c, 9d. After reviewer-2 passes K1 and K2: remaining K1 items 6, 7, 8b, 8c, 9b, 9e, 9f, K2-5, K2-7, K2-9, K2-10, merge main, then K4 (tool surface, node.d.ts stud). Do not start K4 before the pass.

## K4 done (awaiting reviewer-2)
- kernel/tasks (tasks, presence, card, approvals). Tests: 18 in kernel/tasks, run on the test box. The old end-to-end test that used the platform's own seal was replaced by one through `createSealing` and `createApprovals`.
- Approval and sealed use: decide takes the main proof plus an optional `proofs.use` (the person's signature over the `seal.use` payload, which the sealing process verifies itself). The `seal.deliver` proof is made after the merge, by the approver, at deliver time.
- Known: tasks use their own presence verifier (kernel/tasks/presence.js); vault's `seal/proof.js` has a second one for the sealing process. One enrolment should feed both before release (Needs from vault).
- Next: K1 items 6, 7, 8b, 8c, 9b, 9e, 9f; K2-5, K2-7, K2-9, K2-10; then the tool surface and the node.d.ts stud.
