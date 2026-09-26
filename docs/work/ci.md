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
- Scan of main's full history (above).
- Workflows (10317c1), lint-clean with actionlint 1.7.7, not yet run on GitHub:
  - `node.yml`: ubuntu, Node 22 and 24, `npm ci`, `npm test`, `npm run perf-check`. Every push/PR.
  - `capsule-mac.yml`: macos-latest, `local/capsule/build.sh`, then `native/build.sh test` and
    `app` when `local/capsule/native/build.sh` exists (capsule-pro), then the Mac-only Node tests.
    Uploads `capsule-helpers.zip` and `Vyre-capsule.app.zip`. Runs on changes under `local/`.
  - `ios.yml`: an ubuntu check skips the job while `apps/ios/project.yml` is absent (no macOS
    minutes); else xcodegen, the newest available iPhone simulator, `xcodebuild test` unsigned,
    uploads `Vyre-ios-simulator.app.zip` and the build log.
  - `android.yml`: ubuntu, temurin 17, setup-gradle (cache), `assembleDebug testDebugUnitTest`
    (no FCM), uploads the debug APK and test reports. Skips while `apps/android` is absent.
  - Removed `test.yml` (full suite on 2 macOS + 2 ubuntu runners, no `npm ci`); its perf gate
    moved into `node.yml`.
  - README badges point at vyre-ai/vyre.
- How a team gets a Mac build: push its branch to the repo (capsule-mac/ios run on changes to
  their paths), or Actions tab > the workflow > Run workflow on any branch
  (`gh workflow run capsule-mac.yml --ref work/<team>`). Artifacts are on the run page for 14 days.

## Doing
- Rewrite tooling and rehearsal (team folder, `ci-rewrite/`). Then hold for the user's go.

## Next
- On the go, overnight: preflight, rewrite, rescan, publish (main plus work/*), send TEAMS.md,
  watch each workflow's first run, fix failures.
- First runs to watch: the Mac-only Node tests on a runner (some may expect a desktop session),
  the simulator choice on macos-latest, and android once work/mobile merges.

## Needs from others
- lead/user: create org vyre-ai; decide the public commit identity; the go for the overnight rewrite.

## Changed contracts
- None.
