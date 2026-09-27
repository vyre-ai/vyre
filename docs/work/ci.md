# ci

Branch: work/ci · Worktree: ../vyre-ci · Owner session: ci

Goal: build and test Vyre on GitHub Actions' free runners (public repo vyre-ai/vyre), so the Swift
Capsule, the iOS app and the Android app stop compiling on the user's Mac.

## Pre-publish scan (2026-09-27)

Scope: every commit on every branch of the live repo (44 branches, 834 commits), since teams will
push their work/* branches for Mac builds. Tools: gitleaks 8.28.0 plus a grep of `git log -p --all`
(content and commit messages) against a denylist of the user's names, clients, hosts, IPs and
paths. The denylist and the rewrite tooling live outside this repo, in the team folder under
`ci-rewrite/`, so the list itself is never published. Both ran on the test box, not the Mac.

### Secrets: clean

gitleaks reported 14 findings, all fixtures or code, none real:

- `local/capsule/lib/clips.test.js` (9): the secret-shape fixtures for the clipboard redactor
  (`AKIAIOSFODNN7EXAMPLE`, `ghp_abc...`, a stub OpenSSH armour, a jwt.io sample token).
- `core/push/push.test.js`: the RFC 8291 Web Push test vector.
- `core/vault/ssh/keys.js`: the OpenSSH armour regex, not a key.
- `core/computers/glass.test.js`: the RFC 6455 sample WebSocket nonce.
- `core/vault/import.test.js`, `core/vault/relay.test.js`: made-up vault values.

The grep for `sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `xox*`, `AKIA`, private-key armour, JWTs,
`tskey-`, `AIza`, `whsec_`, Stripe live keys and `ya29.` found only the same fixtures. No `.env`,
`.pem`, `.key` or `.p12` file was ever committed. Every tailnet name and 100.x address is a
fixture; no real public IP appears.

### Private data: small, but real

1. **Commit identity.** Every commit carries the user's real name and personal address.
2. **A real client firm's name**, in one CHANGELOG line and one `docs/work/memory.md` line
   (commit 5dd4caa and the branches that carry it).
3. **The test box's private hostname and its vault file name**, about 60 lines across docs,
   CHANGELOG, `scripts/release.sh` and commit messages.
4. **Home-relative paths** to the private prototype folder (73) and to the team folder (3:
   `docs/work/capsule-pro.md`, `docs/work/capsule-now.md`, `scripts/capsule-spaces/run.js`).

Nothing else on the denylist appears. `/Users/` only ever shows sample homes (`/Users/alex`,
`/Users/a`); the only Gmail addresses are samples.

### The rewrite (all refs, in place, overnight)

Tooling in the team folder, `ci-rewrite/` (see its README): `preflight.sh` (every worktree clean
or WIP-committed, no detached worktree, no stash), `rewrite.sh` (`git filter-repo --force` on the
live repo with `--mailmap`, `--replace-text` and `--replace-message`, then a hard reset of each
worktree that preflight proved clean), `rescan.sh` (gitleaks plus the denylist over every ref;
must print CLEAN), `publish.sh` (create the public repo, push main and work/* only, re-running
rescan first), and `TEAMS.md`, the note for every team. Rehearsed on a full copy on the test box;
numbers below.

The same strings are scrubbed from main's tree in a normal commit on this branch first.

## GitHub (2026-09-27)

- `gh` is logged in as the user's account with scopes admin:org, repo, workflow.
- The org `vyre-ai` does not exist (404), and the name looks free. Orgs can't be created by API
  for a personal account: the user creates it at https://github.com/account/organizations/new
  (Free plan, name `vyre-ai`).

## Done
- Workflows: node, capsule-mac, ios, android (see CHANGELOG). ios/android use mobile's build
  commands (`apps/ios/scripts/build.sh test`, `gradlew -p apps/android`).
- 2026-09-27 published https://github.com/vyre-ai/vyre (public, default branch main):
  - main scrubbed and merged work/ci; teams frozen, open trees WIP-committed (tracked files only).
  - Mirror backup `<vyre-dir>/vyre-prerewrite.git` plus a bundle in the team folder's
    `ci-rewrite/backup/`. After publish there is no undo.
  - `git filter-repo --force` on the live repo, all 45 branches, 3-4 s; every worktree kept its
    uncommitted edits (mixed reset, then only rewrite-changed untouched files refreshed). A commit
    landed mid-freeze with the old hostname; a second pass caught it. Rescan CLEAN (900 commits).
  - Pushed private, verified the remote tips equal the scanned tips, flipped public. main and
    work/* only; vault/* and wip/* stay local. The pre-push guard is installed in the repo's hooks.
- A push of more than 3 refs creates no workflow runs, so main's first runs were dispatched by hand.

## Doing (2026-09-27 afternoon)
- work/ci holds: box-image.yml, sessions-sdk.yml, app.yml, the capsule-mac signing fix, the Chrome
  test cleanup (Node 22 hang FIXED: 2424 pass, 4 min), tmp-guard listing, node skipping work/ci-*.
  Waiting for the integrator to merge work/ci.
- box-image green on main 15e82dd7, 9efbddc0; c8fb9aae running (work/ci-box-c8fb9aa).
- work/ci-pid1 0f804c11: compose PID-1 = tini check, merges in batch 3 WITH resilience d0129781
  (fails on a compose with `init: true`). Proof on work/ci-pid1-proof (d0129781 + workflow).
- APK: OWNER-KEY model (lead's final call). CI builds UNSIGNED vyre-<v>-<sha7>.apk + android.json;
  a throwaway-signed copy and mobile's JS signer output (apps/app/scripts/sign-apk.mjs, CLI
  guessed, asked mobile) are checked with apksigner verify. No Vyre key, nothing in the vault.
  Proof on work/ci-app (mobile + app.yml).
- sessions-sdk proof on work/ci-sessions (sessions + workflow).
- perf RSS max: not a merge. vyred holds ~160 MB for ~23 s after indexing, then 92 MB flat.
  Sent to lead (harness choice) and memory-iq (release buffers after the pass).
- Flaky tmp-guard leak from test/onboard.test.js "reserve goes to ts.net": wait for tmp-guard to
  name the writer.

## Next
- Report c8fb9aae box-image; pid1 proof; app and sessions proofs to their teams.
- Delete throwaway branches once their workflows are on main.
- Recheck: `gh run list -R vyre-ai/vyre --branch <b> --workflow <wf>`. In zsh, `set -- $var`
  does not split: wrap loops in `bash -c`. actionlint lives in the scratchpad, fetch v1.7.7 again.

## Needs from others
- None.

## Changed contracts
- None.
