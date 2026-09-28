# github

Branch: work/github · Worktree: ../vyre-github · Owner session: github

## Done
- ADR 0041 written and reviewer-APPROVED (docs/adr/0041-github-everywhere.md, ADR-NUMBERS.md
  confirms 0041 unchanged). Fixed the reviewer's HIGH (credential.helper) and 3 MEDIUMs.
- `core/github/` built: `connect.js` (RFC 8628 device flow, polling instead of a loopback
  listener; fixed a falsy-zero bug where `interval: 0`/`expires_in: 0` from GitHub were treated
  as missing), `accounts.js` (account + project store), `git.js` (worktree add/remove, fully
  working; `cloneRepo` now real, using the new `gitWithAskpass`), `index.js` (all tools, callers
  locked to people + named modules, nothing model-reachable), `module.json`.
- `lib/git-safe.js` gained `gitWithAskpass(dir, args, { token, username?, stdin? })`: fd-based
  token (never an env var holding the value), forced `credential.helper=` (repo-local is the
  proven residual risk once NOSYSTEM/GLOBAL=devNull are already accounted for),
  `protocol.https.allow=always` on top of the inherited `protocol.allow=never` (nothing but https
  is reachable), and `credential.username=x-access-token` fixed (so askpass is asked once, for
  the password, not twice). Built in this worktree (main has git-safe.js; sessions' branch
  doesn't) - sent to sessions as a self-contained new-file diff per their request; they review it
  standalone and the integrator reconciles at the stage/0.1.1 fold.
- 19/19 tests green: `core/github/connect.test.js` (8), `core/github/git.test.js` (5),
  `lib/git-safe-askpass.test.js` (3, using `git credential fill` - the real credential-resolution
  path a clone takes - so nothing needs real network), plus the earlier count. Local only so far;
  not yet run on testbox.
- federation confirmed `module:github` on `projects.create`/`projects.add-workspace`'s caller
  allowlist (their sha 624edc76, MAPPING_ALLOWED).
- `core/vault/providers.js` gained a `github-oauth` entry (`how: "oauth"`, `next: { tool:
  "github.connect" }`) alongside the existing pasted-PAT `github` entry, now relabelled "GitHub
  (paste a token)" for clarity next to it. vault's own tests (connections, providers, needs,
  rotate x2 - 30/30) still pass unchanged against the new entry.
- sessions confirmed the real hook names: `thread.started` (not "archived"/a project-change
  event, neither of which exist today) for the worktree-start trigger; `thread.stopped`/
  `.finished` for cleanup, exact choice theirs when they build the hook. ADR's section 5 fixed to
  match.
- **Incident (reported, resolved)**: an early debug script for gitWithAskpass ran `git credential
  fill` outside git-safe's isolation and printed a real stored GitHub PAT into tool output.
  Reported to reviewer and lead immediately; value not reused; recommended a rotation. Documented
  in the ADR under decision 4 so it isn't lost. The shipped code path was never exposed to this -
  only the throwaway debug script, since deleted.

## Done (2026-09-28, linking an existing project)
- Lead's 0.1.1 ask: "start a project from a repo" (already had it) plus "link a project to a repo
  or a session, wherever it makes sense." Built the second half:
  - `core/github/git.js` gained three small, local-only (no network, no token) primitives, unit
    tested for real against on-disk repos (`git.test.js`, 3 new tests, 14/14 in the file):
    `originFullName(url)` (reads `owner/name` back out of an https, `git@`, or `ssh://` origin,
    null for anything not github.com), `readOrigin(dir)` (`isRepo`, `origin`, both read-only),
    `remoteUrl(dir, name)` and `remoteAdd(dir, name, url)` (the latter refuses on its own, git's
    own "remote already exists", if the name is taken, the actual protection `.project.link`'s
    confirm step relies on).
  - `github.project.detect {project}` (people + `module:launch`): read-only, no confirm needed
    ever, reports whether a project's folder already has a GitHub-looking origin and whether one
    of the connected accounts can reach it, for a surface to offer "Link to owner/repo?" without
    the person typing anything.
  - `github.project.link {project, repo, account?, confirm?}` (people only, never a module, never
    a model): an already-matching origin is recorded in one call; anything else (a different
    origin, no origin, or not a repo at all) changes nothing and reports what it found plus a
    proposed `add-remote` action; only `confirm: true` adds the remote (named `github`), and only
    when nothing named `github` is already there pointing elsewhere (`remote_exists` otherwise).
    No `origin` touch, no `set-url`, no force, anywhere in this path.
  - `github.project.unlink {project}` (people only): drops the recorded link, no git call at all.
  - `github.repos` gained real paging: `{ repos, page, limit, more }` instead of a bare array.
    Without `q` it's GitHub's own per-page listing; with `q` (no server-side text search exists on
    `/user/repos`) it scans up to 10 pages of matches, then paginates those. `getRepo` factored
    out of `github.project`'s inline fetch and reused by `.detect`/`.link`.
  - `core/github/index.test.js` (new, 7 tests): the module's tools wired up for real against a
    real sqlite table and real on-disk git repos, a fake `projects` (`ctx.call`) and a fake GitHub
    REST API (`globalThis.fetch`, swapped and restored per test, never real network). Covers
    paging, all three detect/link/unlink branches (match, mismatch+confirm, remote-exists, not-a-
    repo), and that link/unlink refuse a module caller. 21/21 in `core/github/` total, 86/86
    across `core/github/**`, `lib/git-safe*`, `test/boundaries.test.js` and the three `docs-*`
    suites. Local only so far; not yet run on testbox.
  - ADR 0041 updated: new decision "4a. Linking an EXISTING project to a repo", `github.repos`'s
    section rewritten for the paging contract, the manifest/callers table and `watches.emits`
    updated (`github.project.linked`/`.unlinked`). Also fixed three pre-existing `docs-check`
    failures unrelated to this change but blocking a clean run on this ADR: `owner: github` was
    missing from `scripts/lib/docs/check.js`'s `OWNERS` list (only owner in the whole `docs/adr/`
    tree not on it), the ADR was never added to `docs/nav.json`, and `status: proposed` isn't one
    of the three allowed values (moved to `draft`, matching other ADRs that are mostly built with
    0.1.2 work still open). Also swept the em dashes the same day's no-em-dash rule caught
    throughout the file (mechanical `sed` pass plus one manual fix at a line-wrapped instance).
    `npm run docs:ref` regenerated; all `docs-*` tests green.
  - `module.json`: `does.tools` and `watches.emits` gained the three new tools/two new events.

## Doing
- reviewer CLEARED work/github through acfcefd2 (both 3a72ea7f..84e76681 and the stdin fix).
  The credential.interactive LOW is WITHDRAWN (reviewer agreed the evidence was right); the lead
  confirmed item 1 is done with no new sha. github range fully clear, no open reviewer asks.
- Sent launch the full tool contract for Settings/onboarding (sign-in flow, event names, account
  list, disconnect, error codes). Waiting on their questions/build.
- sessions built the start/end hook (79bd2bf1, their worktree): Switchboard#where() substitutes
  the worktree path for a GitHub project's thread, cleanup fires only on canonical status
  `finished` (not `stopped`/`paused`, both resumable - cleaning those up would strand a resume).
  Agreed this is the right conservative default for 0.1.1; noted the real gap (long-lived
  interactive sessions rarely reach `finished`, so their worktrees pile up) as a deferred 0.1.2
  GC item in the ADR. Confirmed acfcefd2 already answers their ECONNRESET question (sent before,
  may have crossed in flight).
- **Lead: `github.session.cleanup` must never auto-delete work (user's binding rule).** Fixed
  (58d0dd87): `worktreeRemove` now only removes when there's no uncommitted change, no untracked
  file, and no commit missing from the default branch and every remote; otherwise nothing is
  touched and `github.cleanup-needed { project, session, path, branch, dirty, commits }` is
  emitted for a surface to show a confirm card. `git worktree remove --force` and `git branch -D`
  no longer appear anywhere in this file. 29/29 on testbox. Reviewer CLEARED 58d0dd87 with one
  MEDIUM and one LOW, both fixed at 4e9c6d7d: `--ignored` added to the status check (an ignored
  `.env`/build output/dataset used to slip past cleanup entirely); `refs/heads/<branch>` on
  rev-list's two revision args. Found on testbox, not assumed: `--end-of-options` on rev-list
  actually breaks `--not`/`--remotes` (git stops parsing them as flags once given), so it was
  dropped, keeping just the `refs/heads/` prefix; `git branch -d` doesn't accept `refs/heads/`
  form at all, so that one keeps the short name. 29/29 on testbox including a new ignored-file
  test. Sent to reviewer.

## Next
1. Send `sessions` the actual gitWithAskpass diff (lib/git-safe.js + lib/git-safe-askpass.test.js)
   now that it's built and tested, for their review as a new-file diff, per their ask.
2. Send `launch` the updated tool contract (below, under Changed contracts) for the repo picker
   (`github.repos`'s new `{ repos, page, limit, more }` shape) and link/unlink/detect
   (`github.project.link`/`.unlink`/`.detect`), alongside the sign-in/onboarding shapes already
   sent. Not this team's UI; hand off and wait on their questions/build.
3. Once sessions builds the start/end hook: verify `github.session.worktree`/`.cleanup` end to
   end from a real session (needs sessions' side to exist first).
4. Run the full suite on testbox once there's a natural checkpoint (nice -n 15, check load first) -
   this includes the new `core/github/index.test.js` and the `git.js` link/detect additions,
   local-only (86/86) so far.
5. 0.1.2 design-only items (not started): PRs from chat, issues as goals, per-project git
   settings, Touch ID on big moves, the GitHub App replacing the OAuth App's broad `repo` scope.

## Needs from others
- sessions: review the gitWithAskpass diff; build the session-start/end hook once they're ready
  (`thread.started` for start, `thread.stopped`/`.finished` for cleanup - their choice which).
- launch: Settings, onboarding and the repo-picker/link screens, whenever they pick this up. Tool
  shapes are stable, including the new `github.repos` paging shape and `.project.detect`/
  `.link`/`.unlink`.
- integrator: fold `lib/git-safe.js`'s `gitWithAskpass` addition (currently only in this
  worktree, built against main's copy of the file) at the stage/0.1.1 assembly, alongside
  whatever sessions lands.

## Changed contracts
- `lib/git-safe.js` gains `gitWithAskpass(dir, args, { token, username?, timeout?, stdin? })`
  (new export, additive - `gitAsync`/`gitSync`/`safeGitArgs`/`safeGitEnv` unchanged).
- `core/github/git.js` gains `originFullName(url)`, `readOrigin(dir)`, `remoteUrl(dir, name)`,
  `remoteAdd(dir, name, url)` (new exports, additive, all local-only, no network, no token).
- `github.repos`'s return shape changed (not yet shipped to a real surface - `launch` hasn't
  built the picker yet, per their own "Next" note): was a bare array, now
  `{ repos, page, limit, more }`, plus a new `page` input alongside the existing
  `account`/`q`/`limit`. The row shape inside `repos` is unchanged.
- Three new tools: `github.project.detect {project}` (people + `module:launch`),
  `github.project.link {project, repo, account?, confirm?}` (people only), `github.project.unlink
  {project}` (people only). Two new events: `github.project.linked`, `github.project.unlinked`.
- `scripts/lib/docs/check.js`'s `OWNERS` list gains `"github"` (was missing; the only owner used
  anywhere in `docs/adr/` that wasn't on it, which failed `docs-check` on ADR 0041 for reasons
  unrelated to this change). `docs/nav.json` gains the ADR 0041 entry it was also missing.
- `core/vault/providers.js` gains a `github-oauth` entry (`how: "oauth"`) alongside the existing
  pasted-PAT `github` entry.
- `core/projects/index.js`'s `MAPPING_ALLOWED` (was `SYNC_ALLOWED`) now includes `module:github`
  (federation's change, sha 624edc76).
