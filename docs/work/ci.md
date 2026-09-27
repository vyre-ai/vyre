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

## Doing (2026-09-27, after logout 3)
- Workflows now: node, capsule-mac, ios, android, plus new box-image, sessions-sdk, app (all on
  work/ci, not on main until the integrator merges).
- box-image.yml builds box/Dockerfile from the `npm pack` tarball (what a deploy builds; a
  checkout build fails on .dockerignore dropping scripts/postinstall.mjs, fix given to
  resilience), then: health over the socket, tini PID 1, SIGKILL vyred -> loop.sh restarts it,
  `docker stop` exits 0 fast. Proven green on resilience c8f5654 (run 36315578355: image 609 MB,
  pid 9 -> 85, stopped in 0 s exit 0). Throwaway branches work/ci-box, work/ci-box-main (main
  15e82dd7 + workflow) and work/ci-diag: delete from origin once box-image is on main.
- Node 22 hang: every branch's node (22) job hangs to its 30-min timeout after hands-chrome
  tests fail at random (runner image sets CHROME_BIN, so Chrome tests run). Proxy-pipe fix
  aac42f8 was not enough. work/ci-diag runs the chrome file alone and the suite with
  --test-timeout to name the stuck test.
- onboard-page leaked a temp home (tmp-guard red on Node 24): fixed 1e614150, unproven in CI.
- capsule-mac signing step: sudo -n -d trust, /dev/null, 5-min timeout (d8ecff6a); capsule-pro
  may cherry-pick.
- sessions-sdk.yml (gated on the SDK in package.json) and --omit=optional in node/capsule-mac;
  asked sessions for dependency kind, test paths and smoke command.
- app.yml for apps/app agreed with mobile. The Playwright perf job (4x throttle, world.js,
  >20% regression vs last green artifact) waits for mobile's ping.

## Next
- Report box-image on main (work/ci-box-main) to lead + integrator.
- Read work/ci-diag, fix the Node 22 hang, then push work/ci and confirm node green on both.
- Recheck: `gh run list -R vyre-ai/vyre --branch <b> --workflow <wf>`. In zsh, `set -- $var`
  does not split: wrap loops in `bash -c`.

## Needs from others
- None.

## Changed contracts
- None.
