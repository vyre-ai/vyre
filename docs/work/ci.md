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

## Doing (RESUME 5, after the deploy; box runs 53cd1326)
- work/ci tip for batch 4 (merge LAST): box-image pack-list detect; hygiene node_modules guard;
  idle gate on heap after a forced GC (proof 36326469056, and 36332059074 green on 22 and 24);
  onboard-page temp-home fix (tmp-guard green); vyre.tgz ships the web app:
  scripts/build-app.sh (expo export -p web, Metro's dist/assets/node_modules icons moved to
  dist/assets/nm/ since npm never packs node_modules, then precache.mjs), called by build-site.sh
  and box-image's pack step; package.json files += apps/app/dist; apps/app/.npmignore (the app's
  .gitignore drops dist/ from the pack); box-image smokes /app, /app/, entry js, /app/now,
  sw.js build id, every precached path, the manifest; release-check requires all of dist and
  caps the install at 16 MB (12.7 MB without the app, over the old 12 MB already).
  Proof on throwaway work/ci-appship (work/ci + work/mobile 2f1ccfff): release-check 36332466998
  and box-image 36332467006 GREEN; dist 2.6 MB / 26 files / 23 precached; vyre.tgz 3.8 MB;
  installed 16 MB (under the 16384 KB cap, so little headroom).
- Batch 4c (work/integrator-b4c 91f34bae on 53cd1326): box-image + design green. Red, routed:
  node: mobile world presence vs person_session_required (mobile/e2e); vyre update curls on a
  checkout (platform 54180bb5); pwa ios pins vs chat 553017a1 (chat+pwa); pwa sideways bare query
  in settings-keys.css (native-core) and term.js (chat f697d345); temp home reads ~/.claude at
  core/config/settings.js:97 (native-core/platform). app: ci's own apostrophe bug, fixed 2c1ac9aa.
  android Md.kt animateFloat, ios DetailSheet FactRow redeclared (mobile). capsule-mac: capsule-pro
  170dac3b. sessions-sdk: FIXED by sessions d7924a1d (test-only); GitHub driver job 249/0 (run 36333524676).
- box-image prints vyre.tgz / installed / app sizes against the 16 MB cap (42372d6a).
- testbox keeps vyre-box:gate and ~/vyre-ci/{ci,ci-gate,sdk-js,gate1.sh}.

## Next
- 0.1.1 (lead): move the generated docs/index.json (1 MB) and docs/reference (0.8 MB) out of the
  npm package if nothing at runtime reads them (asked docs). Install is 16.6 MB, cap 20 MB for 0.1.0.
- RC prep is HELD on work/ci-rc 1d8ae652 (root + apps/app 0.1.0-rc.1, module-sdk stays 0.1.0,
  CHANGELOG "## 0.1.0", release.yml rc tags + notes fallback + dry run builds the dispatched
  branch, release/min_from 0.1.0-rc.1). It goes to the integrator as the LAST item of the RC batch;
  rebase it on that batch's main then. work/ci reverted it (0cff3258). No tag until the user says yes.
- After 0.1.0: drop build-app.sh's dist/assets/node_modules move and rewrite once mobile says the
  export no longer writes a node_modules path (mobile will drop expo-router's error/sitemap icons).
- Delete throwaway branches once their workflows are on main: work/ci-app, ci-box-c8fb9aa,
  ci-pid1-proof, ci-sessions, ci-release, ci-pid1, ci-boundaries (after merge).
- actionlint v1.7.7 in the scratchpad (re-download). `gh run list -c` needs the FULL sha.

## Needs from others
- None.

## Changed contracts
- None.
