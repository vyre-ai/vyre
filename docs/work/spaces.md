# spaces

Branch: work/spaces · Worktree: ../vyre-spaces-03 · Owner session: windows (with e2e2 walking real installs)

Scope (0.3, one release): Spaces as identity. Names in one namespace (`alex.vyre.run`, `harlow.vyre.run`, own domain as alias), create a space with a home ("Where will it live?": a server, a new VPS, this computer) including its own Twenty through the records driver, the five roles with temp (scope plus expiry, extend with presence), invites through `harlow.vyre.run/join/...`, the five bridges between spaces (reference, shared view, copy to my space, Kit as definitions, continue in another space) plus the device-side merge API for native-core, then Publish (its own internet-facing container, Caddy plus BuildKit, preview, approve, production as a Flow, rollback, domains, granted secrets, isolated from the space's data).

Specs: team/0.3/DESIGN-spaces-first.md, team/0.3/SPEC-core-contract.md sections 4 and 10 (and 13 for Publish), kernel/contracts (roles.d.ts: RoleId, ROLE_BUNDLES, Membership, VyreName, SpaceIdentity).

## Layout

The kernel is not implemented yet (platform builds it on work/kernel), so everything here is pure libraries with injected dependencies, tested alone, and thin module wiring on top that moves onto the kernel when it lands.

| Path | What | Owner |
|---|---|---|
| names/worker/identity.js, core/names/identity.js | identity names in the directory (one namespace with box names), person key or space root key, own-domain alias, sealed resolve record | windows (me) |
| lib/spaces/members.js, invites.js | roles, membership rules, temp expiry and extend, invites | subagent S1 |
| lib/spaces/bridges.js | the five bridges and the device merge API | subagent S2 |
| lib/spaces/homes.js | create-a-space flow, home drivers, the space's home unit including Twenty | subagent S3 |
| lib/publish/ | Publish | subagent S4 |
| core/spaces/ | the module wiring (tools, store, events) over the libraries | windows (me), after the libraries |

## Done
- Worktree and branch made from origin/main, work/kernel merged for kernel/contracts.

## Doing
- Names identity design and build (Worker ops in names/worker/identity.js, client in core/names/identity.js).
- Briefs out to S1 to S4.

## Next
1. Names identity with tests; tell tailnet (they own names/worker) in team/0.2/CHAT.md.
2. Integrate S1 to S4 as they return; review each against the contract; core/spaces wiring.
3. Ask e2e2 to walk create, join and invite on clean machines as each lands.

## Needs from others
- tailnet: names/worker is theirs. I add identity routes through one new file and a two-line hook in index.js; pairing and the server one-command install (the code prompt) are theirs, and `create a space` on a server calls it.
- platform: kernel `authorize`, `spaces.bridge`, grants and events when they exist; until then the libraries take an `authorize` and an `events` dependency.
- records (twenty-research): the store driver that creates a Twenty workspace per space.

## Changed contracts
- none yet
