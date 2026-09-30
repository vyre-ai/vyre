# capsule-migrate

Branch: work/capsule-02-migrate · Worktree: ../vyre-capsule-02-migrate · Owner session: capsule-pro
Scope: team/0.2/PLAN.md row R6, "Mac pieces" (capsule-pro); plans/capsule-pro.md section
"From 0.1.1".

## What this is

The Mac-side library and CLI launch's install line runs, once, as its first step on a Mac that
already has 0.1.1 on it. It clears the old install out of the way before 0.2's own install steps
run, so Option-Space is never claimed twice and nothing from 0.1.1 is silently orphaned or lost.

Code: `local/migrate/index.js` (the library: `detect`, `plan`, `apply`, `summarize`, `run`) and
`local/migrate/cli.js` (the entry point launch calls). Tests: `local/migrate/migrate.test.js`,
against fakes in temp homes only.

## What 0.1.1 leaves on a Mac (verified in this checkout, see index.js's header comment for the
exact files/lines each claim comes from)

- An ad hoc Capsule at `<home>/capsule/Vyre.app`, bundle id `sh.vyre.capsule`
  (`core/cli/commands/capsule-native.js`).
- The npm global `vyre` (`docs/get-started/install.md`: `npm install -g https://vyre.run/box/vyre.tgz`;
  `package.json` name `vyre`, `bin.vyre`).
- A local vyred with its own home (default `~/.vyre`, or `$VYRE_HOME`): a pidfile at
  `<home>/vyred.pid` holding the bare pid as text, and a socket at `<home>/vyred.sock`
  (`core/config/index.js`).
- The Capsule's presence key: a Secure Enclave handle in the login keychain, service
  `sh.vyre.capsule.presence` (`local/capsule/native/Sources/Host/Presence.swift`), enrolled as
  `<home>/capsule/presence.json` holding `{id, publicKey}`.
- Local state: clipboard history at `<home>/capsule/clips.json` (ClipStore), frecency at
  `<home>/capsule/frecency.json` (Frecency), watched threads at `<home>/capsule/watches.json`
  (Watches), and the general config at `<home>/config.json`. Snippets: `Core/Snippets.swift`
  parses a hand-edited file, but 0.1.1 never wired a default path into the running Capsule (no
  `SnippetsProvider`, no caller of `Snippets.load(path:)`, anywhere in Host/Agent wiring), the
  only path in the codebase is the test fixture's own `snippets.json`. This module copies
  `<home>/capsule/snippets.json` on a best-effort basis (if it happens to exist) but never invents
  one; **capsule-pro or windows should confirm the real default path once snippets actually ships**,
  since nothing today proves `capsule/snippets.json` is where a real 0.1.1 install would have put
  a user's hand-edited file.

## The interface launch calls

```
node local/migrate/cli.js [--old-home <path>] [--new-home <path>] [--json]
```

- `--old-home` defaults to `$VYRE_HOME`, then `~/.vyre` (0.1.1's home).
- `--new-home` defaults to `$VYRE_NEW_HOME`, then `~/Library/Application Support/Vyre` (the 0.2
  local node's home per plans/capsule-pro.md section 3A/3B).
- Default (no `--json`): prints one line, the exact text of `summarize()`'s result, meant to be
  shown to the person as-is (for example `0.1.1 migrated: stopped the old Capsule and vyred;
  carried over clips, frecency, watches, config; kept the old home as ~/.vyre-0.1.1; removed the
  old app and the npm-installed vyre.`, or `0.1.1: nothing to migrate.` on a clean Mac or a second
  run).
- `--json`: prints one JSON object `{report, plan, result, summary}`: `report` is `detect()`'s
  output, `plan` is the ordered steps, `result` is what `apply()` actually did per step
  (`{id, ok, detail|error|skipped}`), for the installer to log.
- Exit codes: `0` nothing to do, or everything applied; `1` a step failed (the printed line already
  names which one and why); `2` bad usage (unknown flag).

Every side effect (stopping the old vyred/Capsule, copying files, renaming the home, deleting the
app, `npm uninstall -g`) is real when the CLI runs for real: launch should call this once, early,
and treat a non-zero exit as a reason to stop the install and show the person the line, not paper
over it.

## What's moved, kept, and removed

In order (see `plan()` for why this order, `apply()` for the steps):

1. **Stop.** The old vyred, by the exact pid in `<oldHome>/vyred.pid` (never a name match). The
   old Capsule, by pids whose full command line names the exact executable path inside
   `<oldHome>/capsule/Vyre.app` (`pgrep -f` narrowed by an exact `ps -o comm=` check on each hit)
   never a broad `pkill Vyre`.
2. **Copy.** `clips.json`, `frecency.json`, `watches.json`, `snippets.json` (if present) and
   `config.json` land at the same relative path under the new home. Never overwrites a file the
   new node already has (idempotent, and safe if the new node started before this ran).
3. **Mark.** If `<oldHome>/capsule/presence.json` holds an enrolled key, its `id` and `publicKey`
   are written to `<newHome>/capsule/migrated-0.1.1.json`. This module does **not** talk to
   vyred or the keychain itself; see "What the Swift side still needs" below.
4. **Rename.** `<oldHome>` (typically `~/.vyre`) becomes `<oldHome>-0.1.1`. Never deleted.
5. **Remove.** The app bundle only (`Vyre.app`, from inside the renamed backup folder; the rest
   of the backup folder is left alone), then `npm uninstall -g vyre`.

Idempotent: once the old home has been renamed away, a second `detect()` against the same
`--old-home` finds nothing there (and, once npm is gone, nothing there either), so `plan()` is
empty and `apply()`/the CLI do nothing and say `0.1.1: nothing to migrate.`

## What the Swift side must still add (follow-up for capsule-pro, not done here)

`plans/capsule-pro.md`'s "From 0.1.1" section says: "The new build enrolls a fresh Secure Enclave
key at its first proof, and removes the old key's `presence_keys` row with the new key's
signature (the same path as the re-enroll cleanup in 0.1.1)." `Presence.swift`'s `proof()` already
has that exact cleanup path for its own re-enroll case (self-signs a `presence.remove` call with
the *new* key right after enrolling it, never a second Touch ID). What's still needed:

- On first launch of the 0.2 Capsule, read `<home>/capsule/migrated-0.1.1.json` (this module's
  marker) if it exists.
- After `enroll()` succeeds for the new key, if the marker's `oldKeyId` differs from the new key's
  id, send `presence.remove {id: oldKeyId}` signed with the new key, the same call `proof()`
  already makes for its own re-enroll cleanup, just triggered by this marker instead of by a
  signing failure.
- Delete (or rename) the marker file once that call succeeds, so it is sent once.

None of that is built in this branch; it is Swift, and the rules for this session say Swift
changes happen on GitHub Actions, not here. This doc is the handoff.

## Tests

`local/migrate/migrate.test.js`, 9 cases, run with:

```
nice -n 15 node --test --test-reporter=spec "local/migrate/*.test.js"
```

Covers: an empty Mac (nothing to do), a fully seeded 0.1.1 install (every field detected), step
ordering, a full apply against fakes (stop/copy/mark/rename/remove/npm, nothing real touched),
never clobbering state the new home already has, a failed step stopping the run without throwing
and without renaming the home away, and idempotence (second run is a no-op). All fakes; no real
pid, keychain, npm or filesystem outside a temp dir under `test/scratch.mjs`'s `SCRATCH`.

`test/boundaries.test.js` passes unchanged: `local/migrate` imports only `node:fs`, `node:path`,
`node:child_process` (kernel-equivalent, no cross-part edge needed).

## Known gap, found while building this

Manually invoking the CLI once, by hand, with real default path resolution (no override for the
npm-detection dependency) ran `npm uninstall -g vyre` against this real Mac's real global `vyre`
package for real, deleting it, a rule violation (never run a real `vyre`-adjacent side effect on
this Mac). Flagged in feedback; not repeated. Every check of this module from here on must go
through `node --test`, never a bare manual CLI call with unstubbed defaults.

## Needs from others

- launch: wire this as the install line's first step on a Mac (R6, agreed 00:42 in PLAN.md); the
  exit code and printed line above are the contract.
- capsule-pro (Swift): the re-enroll-and-remove-old-row step above, and confirm/replace the
  snippets default path once that feature is wired.
