# sweep (caller label sweep, part A)

## Scope
TAILSCALE-removal step 2, additive only: `device`, `space` and `agent` next to `tailnet` in every caller list and class; `lib/caller.js` parses the new labels; golden, reach and docs reference regenerated. Nothing deleted, no behaviour change for existing callers. Branch work/caller-sweep off work/kernel.

## Done
- callerAllowed: `device` entry admits exactly `device:<id>`; bare `tailnet`, `device`, `space`, `agent` are never a caller (CLASS_ONLY).
- caller lists extended (see the diff); approvals, vault reveal and vault forwarding got `device` only.
- lib/caller.js: isDevice, isSpaceMember, with tests for look-alikes.

## Doing
Golden regeneration, reach files, docs reference, tests and the boot check on a test server.

## Next
Report to platform.

## Needs
Judgement items, left unchanged (platform to rule):
- Regex sites that accept `tailnet:<login>` as the person but not `device:<id>`: core/link/box.js:68, core/switchboard/index.js:2913, core/modules/federate.js:35 (TAILNET_PERSON), core/onboard/index.js:283 (mode), test/fixtures/fake-reach.js:22. Adding `device:` there changes what a paired device may do today, so they are not a mechanical add.
- Tool lists in files other owners hold, not edited: core/relay/index.js (7 lists), core/names/index.js (WHO), core/network, core/wink (tailnet's), and the fixtures core/stream/fake-threads.js and core/stream/chat-kernel.test.js.
- Approval and secret tools got `device` only, not `space` or `agent`: gate.revise, gate.approve, gate.reject, the Switchboard answer tool, vault.session.open, vault.session.status, vault.reveal, vault.copy, vault.totp and the vault forwarding list. A `device` entry admits only what the `tailnet` and `deck` entries already admitted (device:<id> through ownerDevice), so no paired device gains a tool.
- `space` and `agent` entries are inert in callerAllowed (a visiting person or an agent label opens nothing through a list). Who a visiting person reaches is the core contract's call, per tool.
- Reach files: no generator exists and the reach tests pass unchanged, so they are not edited. Their `why` strings still read "(cli, local, module, tailnet)".
- Base drift, not from this branch (origin/work/kernel 00aad33cb): the stored golden set is stale for vault.provider.status (20 cells, denied now runs for session:mcp:agent:kit and session:harness:agent:kit), so the golden reproduction test (1) and the K2b test (5) are red at the base. kernel/golden/golden.json here is the stored set plus the two new columns only (the recorder would refuse the refresh over those 20 cells and I did not allow-list them); platform refreshes it with a ruling on that tool. Also red at the base: test/project-arg.test.js (publish.create, wink.invite, work.situation, work.team.*) and the spaces module at boot (ID_ROUTES before initialization).

## Platform's rulings (4 Oct, on work/kernel)
1. Regex sites that take `tailnet:<login>` as the person (core/link/box.js, core/switchboard, core/modules/federate.js, core/onboard, the fake-reach fixture): left as they are. Adding `device:` there changes what a paired device may do, and a `device:<id>` is the person's only through `ownerDevice` and the home's own relay row (PH-1). The tailnet team converts them in the removal step, one site at a time, each with its test.
2. Lists in files other owners hold (core/relay, core/names, core/network, core/wink, the stream fixtures): their owners add the labels.
3. Approvals and secrets (gate.*, the Switchboard answer tool, vault.session.*, vault.reveal, vault.copy, vault.totp, vault forwarding) get `device` only: accepted. A `device` entry admits only what `tailnet` and `deck` already admitted.
4. `space` and `agent` entries stay inert in callerAllowed: accepted. Who a visiting person reaches is the core contract's call, per tool.
5. Reach files: no generator exists, the reach tests pass unchanged, so they are not edited; the `why` strings are text only.
6. Base drift: the golden set is refreshed after the owners of the tools it names answer (see the chat); the spaces boot failure was fixed by work/spaces (2660f4267, an ancestor of this branch); the project-arg reds are fixed in b83dab30e (publish.create declares projectArg; the others are named with reasons).
