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
- Done: K1 items 6 to 9 and K2-5, K2-7, K2-9 (generated differential, kernel/golden), K2-10. Next: reviewer-2 re-gate, then the tool surface.

## K4 gate round (reviewer-2, db8342cc8)
- Fixed with probes as tests: items 1 to 8, 11 and the reveal-without-door condition. Open: 10 (card and observeDenial take no chain), 12 (use proof checked at decide), the door built with the kernel's isChain at gateway level, template immutability (hash the body into the approval).
- Next: events and the remaining assistant gaps (ctx.kernel), then review and merge kernel/tools/surface.js from work/teammates-03.

## Grants store (3 Oct)
- kernel/grants (index.js, roles.js, grants.test.js, 7 tests) and the gateway wiring (`createGateway({ grantsStore, presence })`, `gateway.grants`). The full `kernel/**` suite exits by itself (181 pass before this piece).
- A signer signs `grant.<verb>` over `{ resource, input_hash }` with `input_hash = sha256(canonical({ action: "grants.<verb>", input }))`; resources are `vyre://<space>/grant/new`, `grant/<id>` and `member/<person>`.
- Next: stage gates in the gateway (needs the stage definition shape from records), the tool surface review, the remaining K4 items (10, 12, template immutability).

## Round 5 (3 Oct, after the grants store)
- Done: once, rate and meter enforcement (kernel/core/limits.js); field limits fail closed under row predicates; stage gates (entry rules and required tasks, expr injected); K4 items 10, 12, template immutability, door isChain.
- Open: the stage-entry task creation is `onStageEnter` (records or tasks wires it); `rate` windows are not durable; K2-9 and default-on gates stay a reviewer-2 gate.

## Full suite and K5, K6 (3 Oct)
- Full `kernel/**` run on the test box at 58453fda4: 218 tests, 218 pass, 0 fail, 0 cancelled, exit 0 by itself in 389 s, no sealing process left running.
- K5 (kernel/audit, 5 tests plus one gateway test): signed checkpoints every 1,000 events or 10 minutes, `verifyLog`, device checkpoints (rollback, rewrite and split detection), `compareCheckpoints`. The Space's signing key is the caller's `sign` function; who holds it (owners' signer) is the open design item for the home.
- K6 (kernel/modules, 6 tests): supervisor, sandbox, egress proxy, host. The Linux path is proved by the self-test on the test box. The macOS profile is written and not run in tests (Mac is shared and the lead has not freed it): run `createSupervisor().selfTest()` there before relying on it. Windows: refused.
- Next: wire the registry's install path to `createModuleHost` (core/modules/index.js), the Space key custody for checkpoints, default-on gates after reviewer-2 reads K2-9.

## The Space signing key (3 Oct, per DESIGN-wink 2)
- A Space is an identity whose list holds its owners (names/worker/chain.js). The checkpoint key is a **Space key**: an Ed25519 key made and held by the sealing process on the Space's home (`spacekey.pub`, `spacekey.sign` in kernel/seal/process.js; one per Space; the private half never leaves). It signs one thing: a checkpoint of that Space's log (`vyre-checkpoint-v1` bytes whose `space` equals the caller's; anything else is refused).
- **Endorsement:** an owner's device signs `{ space, key_id, pub, ts }` (`endorse`, kernel/audit/key.js). The endorsement is kept as an event; a device accepts the key only after `verifyEndorsement` checks it against the Space's own identity chain: the owner is on the Space's list at that time, the signing device is on that owner's own list as it stood then, and the signature covers exactly this key. The home cannot swap the key under the devices.
- **Holding:** the owners' devices hold the checkpoints (`createDeviceCheckpoints`, `compareCheckpoints`). `gateway.audit.verify` takes the endorsed public key.
- Not built here: the owners' signer UI that produces the endorsement (windows or native), and rotation (a new endorsement with a later ts supersedes; old checkpoints stay valid under their own key id).

## First-party modules (plan, 3 Oct) and what was built first
The planner, goals, watchers and waiting cannot move onto the gateway until the daemon has a kernel to move onto, and a kernel needs a durable log and store. Built now, in this order, each tested:
1. `kernel/store/sqlite.js`: the reference store written through to the home's SQLite; the same conformance suite defines it (suite revision 3, passes).
2. `kernel/store/sqlite-log.js`: the hash-chained log made durable (events, salts, cursors; an event is written before it counts as appended; a row edited on disk fails `verify`).
3. `kernel/boot.js` (`bootKernel`): the durable log and store, the grants store rebuilt from the log (first start makes the owner, a restart rebuilds), limits, tasks and the gateway. Nothing calls it yet; the daemon calls it when the kernel is on.
4. Then, one commit each, behaviour unchanged (module tests plus the golden set):
   - **waiting** (reads asks, drafts, reminders, pairing; owns nothing): reads through `gateway.tasks.list` and events instead of four tools.
   - **goals** (`goals_items` with milestones): a `goal` type with a `milestones` field; create, update and state change go through `records.*`; events become `goal.created` etc. from the gateway.
   - **watchers** (wake rules): a `watch` type; the runtime keeps reading events through `gateway.events` (authorized, field-cut).
   - **planner** (`planner_items`, firings, calendar cache): `reminder`, `firing` and `calendar_event` types; scheduling (`next_fire`) stays in the module and is an indexed query over the store.
   - Migration for each: read the old rows, create records, write a marker; the old tables stay one release for rollback.
5. Needs from others: a decision that a module's rows may live in the kernel store (grants then apply to them); the daemon wiring behind `VYRE_KERNEL=1`; the planner's firing rate (a `rate` window per grant is not the place for it: the scheduler stays in the module).

## Key custody correction (3 Oct, reviewer-2 A-1, lead's ruling)
- The Space ROOT key (it controls the owners list) lives only on the owners' devices. The home holds a DELEGATED checkpoint key (made and held by the sealing process, never returned), endorsed by an owner's device through the Space's identity chain and revocable by any owner (`revokeKey`, `verifyRevocation`, `createDeviceCheckpoints().revoke`). A home that is rolled back cannot re-sign a rewritten history under a revoked key, and cannot sign an endorsement at all.
- Owners' devices hold and compare checkpoints and apply a staleness rule: no newer checkpoint for three intervals (by the device's own clock at receipt) is reported as stale. `latest()` verifies the signature.

## K6 round 2 (reviewer-2 K5-K6.md)
- DNS rebinding: the default fetch connects to the address the proxy checked (`pinnedFetch`: a lookup that returns the pinned address, the real name kept for TLS and Host) and re-checks the connected socket's remote address before the request is written.
- `privateAddress` works on bytes: every textual form, IPv4-mapped (dotted and hex), compatible, NAT64, 6to4, Teredo, documentation, unique-local, link-local, multicast and the IPv4 ranges including 198.18.0.0/15 and the documentation blocks.
- The self-test proves 13 attempts (network, write, read outside, child process, worker, /etc/passwd, /proc/self/environ, process listing, root listing, signal to a sibling, DNS, dlopen, environment).
- The macOS profile is deny-default (run in the test user before it counts; if Node cannot start under it the self-test fails and modules are refused).
- Install card: `installCard` shows the hosts and the covert-channel warning; `install` needs the person's `approved_hosts` to equal the declared hosts; shared-suffix wildcards are refused. A module's entry cannot leave its folder; a heap cap is set.
- First party is a signature: `createFirstPartyCheck` (module.sig over the folder hash by the pinned release key; an edit, an added file or a symlink makes it not first party). The registry must pass this as `isFirstParty`; that wiring and a release that signs its modules are the platform and launch items on KERNEL-default-on.md.

## Where rows live (decided by the lead, 3 Oct 2026)
- **The kernel's own store (the home's SQLite, hot data, works with no Twenty):** tasks (planner todos and reminders are tasks with a due time; goals are a task with milestone tasks; waiting is a view over tasks), Flow definitions and runs (watchers become Flows with time, folder or event triggers), grants and memberships, offers, the event log.
- **Twenty (or another store) holds the business records a Space defines:** contacts, matters and custom types.
- **The daemon:** `VYRE_KERNEL=1` (or `start({ kernel: true })`), off by default. `bootHomeKernel` (kernel/home.js) gives the home a Space id and first owner (`<home>/kernel/space.json`), the kernel key (`kernel.key`, 0600), the durable log and store, and the module host; the registry's `deps.moduleHost` is then set so added modules run only under the supervisor.
- **Order of moves (each behaviour unchanged against the golden set, with the module's own tests):** waiting (a view over tasks, smallest), goals, planner, watchers. Not started: they need the planner's firing loop to read due tasks from the kernel store, which is the next piece.
- **Chain verifier:** the one to call is kernel/identity/chain.js (windows' final, hash pinned). kernel/audit/key.js still imports names/worker/chain.js until windows lands it; switching is one import line.
