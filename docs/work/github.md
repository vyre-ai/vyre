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
    the person typing anything. Reworked per-workspace later the same day, see below.
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
    suites (86/86 local first, sha 882809ef; superseded by the testbox rerun below).
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
  - Committed as 882809ef. Reported to team-lead/launch/integrator.

## Done (2026-09-28, HOLD on link/unlink + detect goes per-workspace)
- Lead: RULES violation caught - "local only so far" with real on-disk git repos on the Mac
  breaks "Git credentials never on the Mac" and "tests run on testbox only" (the rule exists
  because of the morning's token-leak incident). Reran the full 86 on testbox (temp
  `HOME`, `GIT_CONFIG_NOSYSTEM=1`/`GIT_CONFIG_GLOBAL=/dev/null`, `nice -n 15`): first pass 85/86,
  one flake in `lib/git-safe-askpass.test.js` (a file untouched this session, owned by
  `sessions`) - 5/5 alone, 86/86 on a clean rerun. Won't run tests locally again.
- Lead's HOLD, crossed with the build above: the user is reconsidering the project/repo model
  itself (a project may own several repos or none, one per workspace, rather than one linked
  repo), so `github.project.link`/`.unlink` are paused - not for review, not for the integrator,
  possibly gone entirely depending on the decision. `github.project.detect` is NOT part of the
  hold (read-only, needed whichever way the model lands) and the lead asked for it to go
  per-workspace now: for every folder a project owns (home plus every `workspaces` entry,
  deduplicated), report isRepo, every remote, and for a GitHub remote, owner/repo plus which
  connected account (if any) can reach it.
  - `core/github/git.js` gained `listRemotes(dir)` and `folderGitState(dir)` (both local-only,
    no network, no token - `git remote` plus `git remote get-url` per name), 4 new tests
    (`git.test.js`, 33/33 in the file now).
  - `github.project.detect` rewritten: was folder-scoped (home only) with `linked`/`origin`
    fields tied to the (now-paused) `github_projects` link concept; now takes no dependency on
    that table at all, iterates every workspace via a new `projectFolders()` (reads
    `projects.list`'s `home`+`workspaces`, same `ctx.call` contract `homeOf()` already used),
    and returns `{ project, workspaces: [{ folder, isRepo, remotes: [{ name, url, full_name,
    match }] }] }`. `accountFor()` (new, was inline in the old detect) caches the account lookup
    per `full_name` so the same repo behind two remotes, or in two workspaces, is checked once.
  - `core/github/index.test.js` rewritten for the new shape (2 tests: single-workspace with a
    bare/foreign/matching remote, and a multi-workspace project with one non-repo folder).
  - ADR 0041: added a "Status, 28 Sep 2026: ON HOLD" note at the top of 4a naming exactly what's
    paused and what isn't; split detect out into its own "4b. Detecting a project's repos, per
    workspace" with the new contract.
  - Regenerated `docs/index.json`/`docs/reference/index.md`. Synced and ran on testbox twice more
    (once to catch a stale-docs failure from the tool-description changes, `npm run docs:ref`
    fixed it; once clean): 89/89 (`core/github/**` 29, `lib/git-safe*`, `boundaries`, `docs-*`).

## Done (2026-09-28, the user's decision: no link - detect + add-repo)
- The user approved the per-workspace model and settled it for real: **no explicit link, ever.**
  A project's repos are either its one primary repo (set once, by `github.project`, what a
  session's worktree is made from) or workspaces it owns (a fresh clone each, `add-repo`).
  `github.project.link`/`.unlink` are gone, not just paused - reverted out of the tree entirely.
  - `core/github/git.js`: removed `readOrigin` and `remoteAdd` (existed only for `.link`'s
    confirm step). Kept `remoteUrl` (used by `listRemotes`) and `originFullName` (used by
    `detect`). `git.test.js`: removed their tests, added one small `remoteUrl` test in their
    place (`listRemotes`/`folderGitState` already cover it well); 31 tests in the file now.
  - `core/github/index.js`: removed `github.project.link`/`.unlink` and the now-dead `homeOf()`
    helper. Added `github.project.add-repo {project, repo, account?, folder?}` (people only): the
    one GitHub action on an existing project, clones the repo as a brand-new workspace (same
    `cloneRepo`/`gitWithAskpass` `github.project` uses, `folder?` overrides the destination
    folder's name), registers it via `ctx.call("projects.add-workspace", ...)`, never writes the
    `github_projects` primary-repo row, never touches the project's other folders. `github.project`
    narrowed to match: dropped its `project?` param (the old "attach to an existing project"
    branch, which used to overwrite the primary-repo row - a real bug against the new model,
    caught while making this change, not asked for explicitly but the right fix alongside it) -
    it now only ever makes a brand-new project.
  - `core/github/module.json`: `does.tools` swaps `.link`/`.unlink` for `.add-repo`; `watches.emits`
    drops `github.project.linked`/`.unlinked` (nothing to announce - `add-repo` doesn't change
    what `github.project.of` answers, so no new event was needed for it).
  - `core/github/index.test.js`: replaced the four link/unlink tests with two `add-repo` tests
    (clone-as-new-workspace + never-touches-other-folders; `folder?` naming, not-found/refused/
    denied) and one `github.project` test for the narrowed create-only behavior.
  - ADR 0041: 4a rewritten from "Linking an EXISTING project" to "Adding a repo to an EXISTING
    project" with a "Decided, 28 Sep 2026: there is no explicit link" note explaining why the
    earlier draft was dropped (recorded under Rejected too, for the record); decision 4's step 3
    updated (no more attach-to-existing branch) and step 4 clarified as the project's *primary*
    repo; 4b (detect) and section 6's manifest/callers table updated for the new tool set.
    `npm run docs:ref` regenerated.
  - Tested on testbox (temp `HOME`, per RULES, never locally). First run caught two real bugs the
    new tests exposed: (1) `github.project.add-repo`/`.project`'s happy paths need a real
    https-reachable git server to clone from (git-safe's `protocol.allow=never` correctly refuses
    a local `file://` stand-in, same as `git.test.js` already proves) - rewrote those tests down
    to the validation that runs before any clone is attempted, matching how `github.project`
    itself was always tested (never end-to-end); (2) regenerating `docs/reference/tools.md` now
    picks up `github.connect`'s REAL description at last (earlier commits' committed copy said
    "No description." for it - a pre-existing generator quirk with a backtick-string description
    this session's repeated `docs:ref` regens finally surfaced), and that description has always
    had an em dash. Fixed the em dash (colon instead); not otherwise this session's bug, but the
    right fix now it's visible. 85/85 clean on testbox, twice.

## Done (2026-09-28, live clone test - lead's ask after review)
- Lead: the actual clone had never been tested end to end (index.test.js's own github.project/
  .add-repo tests only cover the validation before a clone, since git-safe correctly refuses a
  local file:// stand-in). Added an opt-in live test.
  - `core/github/index.live.test.js` (new): off by default, `VYRE_LIVE_GITHUB=1` to run, no
    caller allowlist beyond the module's own (still `cli`/etc via the test's own `as()`), never
    touches real credentials - a made-up account row, a placeholder token throughout. Clones
    GitHub's own tiny public demo repo (`octocat/Hello-World`) for real, twice, through the real
    `github.project` and `.add-repo` tool paths: makes a project, clones the repo, adds a second
    clone as a workspace, checks `.project.of` still names the first as primary, checks
    `.detect` sees both. Also asserts neither clone has a `credential.helper` configured
    afterward - a second, concrete proof next to `git-safe-askpass.test.js`'s existing ones.
  - Drove one real fix in `getRepo` (`core/github/index.js`): a broken/placeholder token used to
    401 outright, even reading a repo anyone could see anonymously (GitHub validates whatever
    credential is offered before ever falling back to public access) - now retries once with no
    credential at all on a 401, so a bad token no longer wrongly reports a public repo as
    inaccessible. Confirmed empirically first (curl, no git/credential machinery involved): no
    Authorization header against a public repo's REST endpoint is 200; any garbage Bearer value
    is 401.
  - `core/github/index.test.js`'s `world()` fake `projects` made stateful (`projects.create`/
    `.add-workspace` now actually update the rows a later `projects.list` sees) so a test can
    create-then-add-repo-then-detect in one flow; no existing test relied on the old
    always-static behavior, so this is additive.
  - Ran on testbox only (temp `HOME`, never the Mac): default run shows it `SKIP`ped (25/26,
    1 skipped, the rest green); with `VYRE_LIVE_GITHUB=1`, ran alone and passed for real (a real
    clone happened); full suite rerun after, clean (85/85 + 1 skipped, after one confirmed-
    transient flake in the same unrelated `git-safe-askpass.test.js` file as before). ADR 0041's
    4a updated with what the live run proved and the fix it drove. Sending this sha to the
    reviewer as part of the same packet.

## Done (2026-09-28, reviewer's e5a612c0 findings - MEDIUM + LOW, both fixed)
- reviewer HOLD on e5a612c0 (range 4e9c6d7d..e5a612c0): one MEDIUM, one LOW, everything else
  passed (add-repo person-only and using the cleared clone path correctly, the primary-row fix
  confirmed correct, detect read-only/git-safe/bounded, repos paging bounded, link/unlink fully
  gone, no trailers on 12 commits - relied on the 85/85 report rather than rerunning).
  - **MEDIUM**: `github.project.detect` returned each remote's raw `url`. A folder cloned by hand
    with a token embedded in the remote's `https://` URL (userinfo before the host) would send
    that credential straight back out through the tool, onto whatever screen shows it. Fixed:
    `core/github/git.js` gained `sanitizeRemoteUrl(url)` (strips userinfo, query string and
    fragment from a `scheme://` URL; the scp-like ssh form has no such syntax and passes through
    unchanged; never throws on something unparsable). `github.project.detect` runs every remote's
    `url` through it before returning. `listRemotes` itself still returns the raw URL (git's own
    answer) - sanitizing is the caller's job, since a future caller might have a reason to need
    the real value (the doc comment says so explicitly now).
  - **LOW**: `repoName` (index.js) and `originFullName` (git.js) accepted any non-slash owner
    (`[^/\s]+`), so `../user` as an owner resolved to `/repos/user` once built into an
    `api.github.com` path. Both now use GitHub's own charset: owner `[A-Za-z0-9-]{1,39}`, name
    `[A-Za-z0-9._-]{1,100}`, plus an explicit check that name is never exactly `.` or `..` (its
    charset, unlike owner's, allows dots, so that needs a real check rather than just the
    charset).
  - Tests: `git.test.js` gained a `sanitizeRemoteUrl` test and an `originFullName` path-traversal/
    dot-name test (4 new); `index.test.js` gained a detect test proving a token embedded in a
    remote URL never appears anywhere in the response, and a `github.project` test proving a
    path-traversal repo string is refused (`bad_input`) before any tool call or fetch happens (2
    new). 12 new/changed assertions total across the two findings.
  - Also had to fix the ADR's own prose once regenerated docs caught it: `user:TOKEN@github.com`
    in a sentence explaining the MEDIUM read as an email address to `docs-check`'s hygiene sweep
    (not an `@example.com` one) - reworded to avoid the pattern rather than exempt it.
  - Tested on testbox (temp `HOME`): 90 tests (89 + the live one, skipped by default), 88 pass +
    1 skip clean on the second run, after the docs-check catch above was fixed. Sending this sha
    back to the reviewer.

## Done (2026-09-28, the 401-fallback LOW - reviewer + lead, both closed)
- reviewer reviewed 119ef290 separately: the URL-scrub MEDIUM was confirmed NOT yet in that sha
  (it landed in 5b1c69f1, which the lead then confirmed closes it) - nit taken too, the live
  test's `projectsDir` mkdtemp is now cleaned up with `t.after`. New LOW on 119ef290's own fix:
  the 401-to-anonymous retry in `getRepo` changes real product behavior to suit a test fixture - a
  real revoked/expired token now reads as fine for any public repo, `detect`'s `match` would say
  the account can reach it, and `github.project` only fails later, on a push or a private repo.
  Lead: same finding, plus "mark the account as needing sign-in again" and "don't report the
  account as able to reach a repo" as the two concrete asks.
  - `getRepo` (index.js) now returns `{ info, tokenBroken }` instead of a bare repo-or-null.
    `tokenBroken` is true exactly when the credentialed request 401'd, independent of whether the
    anonymous retry then found the repo.
  - `accountFor` (detect's per-remote account matching): a broken-token account is skipped as a
    match candidate entirely - `github.token-invalid { name }` is emitted and the loop moves to
    the next account, never crediting it with reaching a repo just because the repo happens to be
    public. `match` stays `null` for that account even when the anonymous read succeeded.
  - New shared helper `resolveRepo(acct, token, full_name)` for `github.project`/`.add-repo`:
    still lets a public repo resolve through the anonymous fallback (a dead token shouldn't block
    cloning something public), still emits `github.token-invalid` every time, but throws a new,
    distinct `token_invalid` error ("<account>'s GitHub sign-in isn't working anymore; reconnect
    it and try again") instead of the generic "refused" whenever the repo *isn't* reachable even
    anonymously (private, or truly gone) - never a vague not-found for what's actually a dead
    credential.
  - `module.json`: `watches.emits` gains `github.token-invalid`.
  - Tests: `index.test.js` gained a `fakeFetch` `brokenToken` option (401s a specific token's
    credentialed request, still serves an anonymous one from `reachable`) and 3 new tests -
    detect never credits a broken token even for a public repo (and flags it); `github.project`
    gets `token_invalid` with a "reconnect" message for a repo unreachable even anonymously (and
    flags it); `github.project.add-repo` checks the project first (`not_found`), then the same
    `token_invalid` once past that. Proving the "public repo still clones, but gets flagged" branch
    needed a REAL network call (the fake fetch doesn't intercept git's own clone), so that's
    proven in `index.live.test.js` instead: it already runs with a placeholder token throughout
    (which really is broken against the real API), and now asserts `github.token-invalid` fires
    for `github.project`, and that `detect`'s `match` is `null` for both real clones since the
    one connected account's token is the same broken one.
  - ADR 0041 4a updated with what drove the follow-up fix and the exact contract.
  - Tested on testbox (temp `HOME`, never locally): default suite 92/92 clean (+1 opt-in live
    test skipped), twice; with `VYRE_LIVE_GITHUB=1`, the live test ran alone and passed for real -
    the placeholder token 401'd against the real GitHub API as expected, the anonymous fallback
    still cloned both repos, `github.token-invalid` fired, and `detect`'s `match` came back
    `null` for both (the exact behavior this fix was for). Sent to reviewer and launch.

## Done (2026-09-28, reviewer CLEARED 4e9c6d7d..5b1c69f1 and 771dab0a; 2 small follow-ups)
- reviewer CLEARED both ranges (the URL-scrub MEDIUM, the charset LOW, and the 401 LOW/live-test
  nit all confirmed closed). Two small LOWs left open, non-blocking, folded into one sha per the
  lead:
  - **`sanitizeRemoteUrl` fails CLOSED now.** The reviewer found a real repro where WHATWG `URL()`
    itself throws on a value that still has userinfo to leak (`http://u:p@github.com:99999/o/r`,
    an out-of-range port) - the old code returned the raw input on that throw, silently
    undoing the whole point of the function. Now: on a throw, strip a userinfo prefix with a
    regex instead (`//[^/@]*@` -> `//`), plus cut anything from a `?` or `#`, the same two things
    the happy path also strips. New test proves the exact repro is now safe.
  - **firstParty required on every module-caller check.** Lead's separate finding: `core/github`
    admitted `module:launch`, but no module in this repo is actually named `launch` (that's a
    team, not a module - `core/switchboard`'s real name is `threads`). A module's name is
    self-declared in its own manifest, and on a Mac a model can write into the home modules
    folder, so a rogue local module could just name itself `sessions` or `threads` too and
    present the same caller string - the allowlist checking the *name* alone was never actually
    proof of who was calling. `checkModuleCaller` now also requires `meta.firstParty === true`
    (the registry's own signal, `core/modules/index.js`'s `firstParty()`, set from where the
    calling module's code lives on disk). `module:launch` dropped everywhere in `MODULE_CALLERS`
    (`github.repos`, `.project`, `.project.of`, `.project.detect`), replaced with `module:threads`
    per the lead. New test: `module:threads` without `meta.firstParty: true` is refused even
    though the name matches; with it, it's let through. `index.test.js`'s `as()` test harness
    gained a `firstParty` option to exercise both.
  - ADR 0041 updated (the rename, and a short explanation of why the name-only check wasn't
    enough) throughout.

## Done (2026-09-28, reviewer CLEARED 32935271; narrow module:threads down to what the switchboard actually calls)
- reviewer CLEARED 32935271 (the sanitize fail-closed fix and the firstParty requirement both
  confirmed sound - noted the registry sets `meta.firstParty` after the caller's own meta,
  `core/modules/index.js:565-570`, so a caller can't claim it itself). One more LOW, non-blocking:
  `module:threads` had landed on `github.repos`, `github.project` and `.project.detect`, but the
  switchboard only actually calls `.project.of`, `.session.worktree` and `.session.cleanup`.
  Dropped `threads` from the first three (`launch`'s screens are person callers - `deck`/`cli`/
  etc - so nothing needs a module entry on those anyway); `github.repos` keeps `module:sessions`
  only, `github.project`/`.detect`/`.add-repo` are now people-only across the board (no
  `checkModuleCaller` call left in either `github.project`'s or `.detect`'s `run`, matching
  `add-repo`'s own shape). `github.project.of` and the two session-worktree tools keep both
  `sessions` and `threads`.
  - **Merge heads-up from the reviewer, acted on now rather than left for the fold**: the
    integrator's stage branch (859fb63d) already has `SESSION_ONLY = {sessions, threads}`; this
    branch had `{sessions}` only. Added `threads` to `SESSION_ONLY` here too, so the fold doesn't
    quietly deny the switchboard's own worktree calls (`module:threads` on
    `github.session.worktree`/`.cleanup`, first-party-checked same as everywhere else).
  - Tests: the `github.repos` module-caller test rewritten for `sessions` (not `threads`), plus a
    new assertion that `threads`, even first-party, is refused there since it was never named as
    a caller. New test for `github.session.worktree`/`.cleanup`: a wrong module name is denied, a
    right name without `firstParty` is denied, `threads` first-party succeeds, `sessions`
    first-party still succeeds too (the merge-safety case).
  - ADR 0041 updated throughout (the three narrowed tools, the table, the firstParty note, and
    the merge heads-up recorded explicitly so it isn't lost before the stage fold).

## Done (2026-09-28, from_thread on github.project - avatar carry-over)
- reviewer CLEARED fb31a36e, nothing open. Lead: one small addition for the user-approved
  avatar carry-over - an optional `from_thread` input on `github.project` that passes straight
  through to `projects.create` (`native-core` validates it there: an existing chat's UUID,
  normalised). The project then gets `avatar_seed` = that chat's id and the chat is filed into
  it, so "New project from a GitHub repo..." on a loose chat keeps its tile.
  - `github.project`'s input gains `from_thread?`; when given, it's spread into the
    `projects.create` call untouched (`...(named(from_thread) ? { from_thread } : {})`, the same
    `named()` helper already used everywhere else here for "a non-empty string or leave it out
    entirely" - never sends `from_thread: undefined`). `github` does no validation of its own on
    it, by design; that's `projects.create`'s job.
  - Stays people-only, no change to callers.
  - Can only be tested where `projects.create` is actually reached, which needs a real clone
    (same limitation as every other `github.project` happy-path assertion) - added to
    `index.live.test.js`'s existing real clone: passes a `from_thread` UUID and asserts the fake
    `projects.create` call captured it.
  - ADR 0041 decision 4, step 3, updated with the new input and what it does.
  - Tested on testbox (temp `HOME`, never locally): see the commit for the numbers. Sending to
    reviewer, integrator and launch, then pausing.

## Done (2026-09-28, reviewer CLEARED 9cf93817; orphan-clone LOW)
- reviewer CLEARED 9cf93817 (from_thread passes straight through, projects.create validates it,
  stays people-only). One LOW: a bad `from_thread` used to fail only after the clone, leaving an
  orphan folder under `projectsDir` - true of any `projects.create` failure today, `from_thread`
  just made it easy to trigger with a plain typo.
  - New `checkedThreadId(from_thread)`: shape-checks it as a UUID before ever cloning (never
    whether the chat exists, that's still `projects.create`'s job). A malformed value now fails
    immediately, no repo resolution, no clone, no GitHub API call at all.
  - New `removeOrphanClone(path)`: best-effort `fs.rmSync`, called from both `github.project`
    (on a `projects.create` error) and `github.project.add-repo` (on a `projects.add-workspace`
    error) after the clone already happened. Swallows its own failure - the original error is
    what the caller actually needs to see.
  - Tests: a malformed `from_thread` fails before any tool call (`index.test.js`, no network
    needed). The actual orphan-cleanup proof needs a real clone to exist first, so that's in
    `index.live.test.js`: a new live test injects a `projects.create`/`.add-workspace` failure
    after a real clone and asserts `projectsDir`'s listing is unchanged after - proving the
    failure really did happen post-clone (not a shortcut) and that nothing was left behind.
  - ADR 0041 decision 4 step 3 updated with both the shape check and the cleanup.

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
2. Send `reviewer` and `integrator` this sha (detect, add-repo, repos paging) per the lead's ask.
3. Send `launch` the final tool contract (below, under Changed contracts): `github.repos` paging,
   `github.project.detect` (per workspace), `github.project.add-repo`. No link/unlink, ever -
   don't build a link-proposal/confirm UI.
4. Once sessions builds the start/end hook: verify `github.session.worktree`/`.cleanup` end to
   end from a real session (needs sessions' side to exist first).
5. 0.1.2 design-only items (not started): PRs from chat, issues as goals, per-project git
   settings, Touch ID on big moves, the GitHub App replacing the OAuth App's broad `repo` scope,
   a worktree for an added (non-primary) repo.

## Needs from others
- sessions: review the gitWithAskpass diff; build the session-start/end hook once they're ready
  (`thread.started` for start, `thread.stopped`/`.finished` for cleanup - their choice which).
- launch: Settings, onboarding, the repo picker and "add a repo to this project" screens,
  whenever they pick this up. Tool shapes are stable: `github.repos` (paging),
  `github.project.detect` (per workspace, no confirm ever), `github.project.add-repo`. No link.
- integrator: fold `lib/git-safe.js`'s `gitWithAskpass` addition (currently only in this
  worktree, built against main's copy of the file) at the stage/0.1.1 assembly, alongside
  whatever sessions lands. Also review/fold detect, add-repo and the repos paging (this sha).
- reviewer: detect (per-workspace), add-repo, and the repos paging change, this sha.

## Changed contracts
- `lib/git-safe.js` gains `gitWithAskpass(dir, args, { token, username?, timeout?, stdin? })`
  (new export, additive - `gitAsync`/`gitSync`/`safeGitArgs`/`safeGitEnv` unchanged).
- `core/github/git.js` gains `originFullName(url)`, `remoteUrl(dir, name)`, `listRemotes(dir)`,
  `folderGitState(dir)` (all local-only, no network, no token). `readOrigin`/`remoteAdd`, built
  for `.link`, were added then removed the same day once `.link` itself was dropped.
- `github.repos`'s return shape changed (not yet shipped to a real surface - `launch` hadn't
  started the picker): was a bare array, now `{ repos, page, limit, more }`, plus a new `page`
  input alongside the existing `account`/`q`/`limit`. The row shape inside `repos` is unchanged.
- `github.project` narrowed: dropped its `project?` input and the "attach to an existing project"
  branch it used to have (that branch used to write the `github_projects` primary-repo row for a
  non-primary repo, a real bug against the settled model - see ADR 4). It now only ever makes a
  brand-new project.
- New tool `github.project.add-repo {project, repo, account?, folder?}` (people only): adds a
  repo to an existing project as a brand-new workspace. Never sets the project's primary repo.
- New tool `github.project.detect {project}` (people + `module:launch`), per workspace: `{
  project, workspaces: [{ folder, isRepo, remotes: [{ name, url, full_name, match }] }] }`.
- `github.project.link`/`.unlink` and their events (`github.project.linked`/`.unlinked`) do NOT
  exist: built, tested, held, then reverted the same day per the user's decision (no explicit
  link - see ADR 0041 section 4a and Rejected).
- `scripts/lib/docs/check.js`'s `OWNERS` list gains `"github"` (was missing; the only owner used
  anywhere in `docs/adr/` that wasn't on it, which failed `docs-check` on ADR 0041 for reasons
  unrelated to this change). `docs/nav.json` gains the ADR 0041 entry it was also missing.
- `core/vault/providers.js` gains a `github-oauth` entry (`how: "oauth"`) alongside the existing
  pasted-PAT `github` entry.
- `core/projects/index.js`'s `MAPPING_ALLOWED` (was `SYNC_ALLOWED`) now includes `module:github`
  (federation's change, sha 624edc76).
