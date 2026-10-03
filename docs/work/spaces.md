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
- Libraries (earlier sessions): lib/spaces members, invites, bridges, merge, homes, home-unit, vps, authz; lib/publish; core/spaces, core/bridges, core/publish wiring.
- **Wink identity (3 Oct, DESIGN-wink.md section 2, ADR 0051 claimed):**
  - names/worker/chain.js: the identity chain (permanent id from the genesis hash, device/code/contact entries, owners for a space, add/remove/replace-code/recover ops, the 24 hour newcomer rule with founders exempt, two-contact recovery, `checkAnswer` for stale and fork, `signerKey` for records and acts). 9 tests.
  - names/worker/ids.js: the directory serves chains (claim, append, exact-name resolve, update, alias via TXT signed by an entry, release); no listing; every write self-proving, so no request signature; box names unchanged.
  - core/names/ids.js: the client (re-verifies the chain, pin comparison, sealed record, owners resolver by the name an owner entry carries).
  - core/spaces/identity.js (device key + chain copy), recovery.js (code + PIN into an Ed25519 key with scrypt), identity-ops.js (create, add/remove entry, replace code, sync with alerts, recover by code, recover by contacts, contact keys), spaces tools for all of it.
  - Spaces: a space is a chain whose list is its owners and follows membership (`syncOwners`); invites can be made `to` an identity and a join is checked against the directory's current list (a removed device cannot join); the module's internal spaceId stays beside the chain id in the sealed record.
  - lib/spaces/compute.js + tools spaces.compute.allow/accept/status/may-run: the compute grant pair (owner or admin allows with terms, the member accepts the terms hash, covers only own sessions on own machine, terms change stops acceptance, temp cannot lend).
  - Bridges: reviewed against contract section 10, nothing assumed per-space device enrolment; person ids are now identity ids.
- Tests on testbox: names/worker, core/names, core/spaces, lib/spaces all green except see Doing.

## Doing
- Nothing in flight. Publish (core/publish, lib/publish) is built from an earlier session but not touched in this round; the lead said publish comes later.

## Next
1. Wire tailnet's pairing to `identity-ops.addEntry` (phone: signed-in device shows a code, new device shows one back; the Wink exchange gives the new device's public key). Until then the tests hand the chain over with `store.join`.
2. Kernel authorize: replace `lib/spaces/authz.js` when work/kernel lands; devices stay hops, never members.
3. A sealed identity file: move the device key behind the vault or the OS secure chip (the IdentityStore interface is ready for it).
4. Recovery contacts UX: the contact key exchange (`spaces.identity.contact.key`) and the approve card (Face ID) are tools only; the Deck and phone surfaces are app-design's.
5. Invite first sight: an invitee who has never seen the space trusts the directory's first answer for the space's list (as before with the key); put the space's chain id in the invite link to pin it.
6. `homes.js` keeps a 6-digit pairing code in the pending space record until it expires (ten minutes, five tries); the pairing table keeps only its hash. Decide if that needs sealing.

## Needs from others
- tailnet: pairing calls `addEntry` (see CHAT 3 Oct); names/worker/ids.js changed shape (they own names/worker): /v1/ids/* is chain-based now, `/v1/names/*` untouched.
- vault: say whether presence keys / vault unlock become `device` entries or stay separate.
- platform: kernel `authorize`, grants and events when they exist.

## Changed contracts
- names directory `/v1/ids/*`: claim takes `{name, ops, sealed, rec}`, resolve returns `{name, kind, id, ops, sealed, rec, aliases}`; `rotate`, `recover`, `recover/cancel` and `mine` are gone (recovery is a chain op). Alias TXT is `vyre-id=2;name;id;by;via;sig`.
- spaces tools: `spaces.identity.create` takes an optional `pin` and returns `recoveryCode` once; `spaces.identity.resolve` returns `id` (the permanent identity id) and, for a space, `spaceId`; `spaces.invites.redeem` person is `{id, name, ops, by}`.
- invites payload: optional `to` (a person id).
