# Bridges and the device merge

Two pure libraries. Everything impure (authorize, event log, clock, ids, record stores, vault, tasks) is passed in as `deps`. They import only node built-ins and `kernel/contracts`.

## bridges.js: the closed list of bridge acts

Every act follows one lifecycle: a grant at the source naming what may cross, the destination's acceptance (a record and an Ask card there), arrival labelled `external`, sealed fields left out, an event in both logs, an expiry and instant revocation. Every refusal is a `BridgeError` with a `code`: `not_accepted`, `expired`, `revoked`, `forbidden`, `sealed`, `wrong_space`, `needs_presence`, `bad_input`, `not_found`.

Functions: `proposeView`, `proposeReference`, `proposeProjection` (source side: authorize plus a presence proof bound to `proposalHash(kind, input)`), `acceptBridge` (destination), `revokeBridge` (either side), `readView`, `resolveReference`, `copyRecord`, `projectEvent`, `kitExport`, `kitInstallPlan`, `installKit`, `continueIn`, `sessionPolicy` with `checkSessionWrite`, `checkSessionAct`, `checkSessionProvider`, `deriveLabels`, `assertNoCrossSpacePaste`, `assertNoForeignContent`. `BRIDGE_ACTIONS` lists the actions to register.

Rules worth knowing:
- A reference you cannot read and one that does not exist return the same unresolved chip. `resolveReference` throws only for a malformed URN.
- A shared view lists the fields that may cross. Nothing else does. Fields above the share's class ceiling and all sealed fields stay out. A ceiling above `internal` needs `owner_confirmed`. `privileged` and `secret` never cross.
- The result of `readView` carries `labels.trust = "external"` and the source's `residency`. The destination's inference door calls `inferenceAllowed(residency, provider)`. A Space with no policy fails closed (`space_only`).
- `copyRecord` is its own action (`records.copy`). Sealed fields come across empty with a note. `copy_sealed` needs a presence proof, a `copy.sealed` grant and a chain of exactly one person.
- A Kit is definitions only. `kitExport` refuses rows, ids, references and sealed-looking values. Sample data lives in a section labelled `sample`.
- A multi-Space session writes drafts only, needs an Ask naming every Space for outward and grant acts, labels its output with all sources, and uses the strictest residency.

## merge.js: the device-side merge (for native-core)

The device holds one link per Space. Give each to `mergeRead` as `{ space, name, color, read(op) }`.

- `mergeRead(sources, op, { sort, groupBy, limit })` reads each Space separately, tags every row with `_space {id, name, color}` and `_key`, sorts and groups on the device, and returns `{ humanOnly: true, rows, groups, sources, unavailable, complete }`. A source that fails or was revoked shows as `unavailable` or `revoked` in `sources`; the rest still show. Error text is not passed on.
- `mergedSearch(sources, text, options)` sorts by `score`. `mergedNow(sources, options)` sorts by `due`.
- The result is for the person's eyes only. To hand it to an assistant, call `sessionFromMerge(merged, residencyBySpace)`. It returns the multi-Space `sessionPolicy` for the Spaces that contributed.
- `createSpaceCache({ spaceId, deriveKey, grantId })` gives `put`, `get`, `delete`, `size`, and `onRevoke({ grantId | space })`. Values are sealed with AES-256-GCM under a 32-byte key from `deriveKey`, which should be tied to that Space's grant. Call `onRevoke` when the grant goes; the cache is emptied and refuses further use.
