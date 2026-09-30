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

## Done (2026-09-28, correction: from_thread checked before cloning, clone never auto-deleted)
- The lead and the reviewer corrected e723df32's own fix: `removeOrphanClone` deleted the clone
  when `projects.create`/`.add-workspace` failed after it - that breaks the user's binding
  no-auto-delete rule (the same rule `github.session.cleanup` already follows, section 5).
  Reverted, and replaced with the actually-requested shape:
  - `checkedThreadId(from_thread)` now checks BOTH shape (a UUID) AND existence, before ever
    cloning: `ctx.call("threads.get", { thread, limit: 1 })`, the same lookup `projects.create`'s
    own validation uses (`native-core`). A malformed or made-up id is refused immediately - no
    repo resolution, no clone, no GitHub API call at all.
  - `removeOrphanClone` is gone. If `projects.create`/`.add-workspace` still fails after the
    clone for any OTHER reason, the clone is left exactly as it is; the thrown error's
    `detail.path` names the folder, so a person decides what to do with it by hand (`fail()`
    gained an optional `detail` param for this - the real registry already supports passing
    `err.detail` through, `core/modules/index.js`'s `run()`).
  - Tests: `index.test.js` gained a fake `threads.get` (an `existingThreads` set) to `world()`,
    and the shape/existence rejection paths are proven without any network (both fail before a
    single other call). The "clone is kept, path is in the error" proof needs a real clone to
    exist first, so `index.live.test.js`'s orphan-cleanup test was rewritten into the opposite
    assertion: inject a `projects.create`/`.add-workspace` failure after a real clone, and check
    the clone is STILL there (`.git` exists) at the path the error named, for both `github.project`
    and `.add-repo`.
  - ADR 0041 decision 4 step 3 rewritten to match (the two-step check, and the no-auto-delete
    correction spelled out plainly, including that the earlier fix existed and why it was wrong).
  - Tested on testbox (temp `HOME`, never locally): see the commit for the numbers. Sending to
    reviewer and integrator, then pausing.

## Done (2026-09-30, 0.2 build wave 1: client id swap, github.session.push, any-repo worktrees)
- 0.2 charter shipped (new phase, different rules from 0.1.1 - see team/0.2/CHARTER.md and
  team/RULES.md's 0.2 additions: testbox and the user's other real machines are OFF LIMITS now;
  tests run in temp homes or on GitHub Actions runners only; land only via the integrator
  onto stage/0.2, which doesn't exist yet). Planning (team/0.2/plans/github.md, two revisions) and
  a full red-team (team/0.2/reviews/github.md) both landed before this build wave; verdict CLEARED
  FOR BUILD, two MEDIUM (N1, N2) to close before build steps 8-9 (the hosted-MCP allowlist and
  pr.open, not started yet - see Next).
- Lead rulings (CHAT.md, 30 Sep): (1) GitHub sign-in defaults to the short-code device flow under
  GitHub CLI's own public client id - "the user asked for GitHub's own managed app", least
  friction. Disconnect never revokes the app-wide grant (would sign the person's own real gh out
  everywhere). A pasted fine-grained PAT is the visible alternative. (2) Quiet local git history
  for a plain (non-GitHub) project moved to teammates (they own projects generally); github keeps
  only what's actually GitHub-specific.
- **Sign-in swap** (`core/github/connect.js`, `index.js`): client id is now
  `178c6fc778ccc68e1d6a` (GitHub CLI's own, declared safe to embed in their own source - verified
  by research before use, not assumed). `revoke()`/`REVOKE_URI` deleted entirely from connect.js
  (no secret to call that endpoint with, and per the lead's ruling we never try anyway).
  `github.remove` now only ever deletes Vyre's own local vault item and account row.
- **New `github.session.push {project, session, allow_secret?}`** (closes reviewer's H0a: no push
  path existed before, which would have meant a token reaching the agent's own shell to push by
  hand). Built on `gitWithAskpass` (fd-3 token only, same isolation `cloneRepo` already has). New
  `git.js` pieces: `scanOutgoing` (a small local secret-pattern scanner over the branch-vs-default
  diff: AWS keys, GitHub tokens, Slack tokens, private-key blocks, generic SECRET/API_KEY/
  PASSWORD-shaped assignments; refuses with file+line on a hit, `allow_secret: true` is the
  person's own override, no presence needed per the review's own fix) and `pushSession` (explicit
  refspec `refs/heads/vyre/<session>:refs/heads/vyre/<session>`, never `--force`, reports rather
  than overwrites a non-fast-forward remote). The account used for the push is always the one
  recorded on the project's own `github_projects` row, never read from `.git/config` (closes M7's
  worst case). People and MCP/agent callers both (new `PEOPLE_AND_AGENTS` group, distinct from the
  existing `PEOPLE_AND_MODULES` which is about cross-module calls, not model-reachability) - agent
  parity, no Gate-holding on push itself (the review's own fix list didn't ask for that here,
  only the credential isolation and the safety checks above).
- **Worktrees generalized to any git repo** (charter: "projects work with or without GitHub").
  New `git.js` `defaultBranchOf(repoDir)` (prefers `origin/HEAD`, falls back to whatever's
  checked out for a repo with no remote). `github.session.worktree`/`.cleanup` gained a `repoOf()`
  helper: uses the `github_projects` row when one exists (unchanged behavior), otherwise reads
  the project's own folder directly via `folderGitState`+`defaultBranchOf`. A project whose folder
  isn't a repo at all still answers `null`, exactly as before - giving it one is teammates' job
  now (local-init moved there per the lead's ruling above), not this module's.
- Tests: `git.test.js` +8 (defaultBranchOf, scanOutgoing, pushSession x3), `index.test.js` +6
  (any-repo worktree, not-a-repo-answers-null, push validation, push secret-block), `connect.
  test.js`'s revoke test removed (nothing left to test - the function's gone). 45 tests total
  (43 pass, 2 opt-in live tests unaffected, still skipped by default). Run locally in isolated
  temp dirs, per 0.2's "temp homes or GitHub runners" rule - not on testbox or the user's real server.
  `index.live.test.js`'s comments/skip messages updated from "testbox" to "GitHub Actions
  runner" throughout, matching the new rule (it still can't run here regardless - real network,
  real git, belongs in CI, never the Mac).
- Committed 3623113a on work/github. Not yet merged main (826 commits ahead of this branch's
  fork point); land only via the integrator onto stage/0.2 once it exists, per the lead's GO.

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

## Save point (2026-09-30, usage-limit restart)
work/github rebased onto origin/work/stage-0.2 and pushed, sha 57b485b4 (was 3623113a before the
rebase - same content, replayed on top of stage's own already-folded 0.1.1 history, one clean
module.json conflict resolved). Sent to reviewer (msg sent, no reply yet as of this save) and to
the lead. Nothing uncommitted; nothing else in flight. On resume: check CHAT.md/reviews/github.md
for the reviewer's clearance on 57b485b4, and whether vault's P17 Gate-provenance name or
mcp.connect/oauth.js status have posted (both block the Next list below).

## Next (0.2)
1. Close reviewer's N1/N2 (team/0.2/reviews/github.md's re-review) before starting build steps
   8-9: N1, `github.connect`/`.remove` for a model caller need the Gate's own-turn provenance
   binding (not caller-identity refusal) so a model can't swap in its own token or disconnect the
   person's GitHub unasked - exact API TBD with vault/gate, not guessed. N2, name the same
   provenance check for the hosted-MCP merge/file-write allowlist once it exists, and route any
   allowed MCP file write through `scanOutgoing` too, not just `github.session.push`.
2. Build the hosted-MCP toolset allowlist and `github.project.pr.open`/`.status`/`.comments`,
   `github.project.issue.list`/`.get` (plans/github.md build steps 7-9) - blocked on vault's
   `mcp.connect`/oauth.js landing for real (not confirmed built yet as of this session; check
   team/0.2/plans/vault.md and CHAT.md before assuming it exists).
3. Run spike 1 (DCR check for GitHub's hosted MCP) and confirm whether the PAT is the hosted-MCP
   credential too, before building the allowlist against an assumption.
4. Merge main into this worktree before any PR to the integrator (826 commits ahead as of this
   session; core/github/ itself has drifted very little, but the rest of the tree has moved a
   lot under the new module contract v1 work - check for conflicts, don't assume none).
5. 0.2.x/deferred: a worktree for an added (non-primary) workspace repo; the GitHub App replacing
   the device-flow's broad `repo` scope, if that's ever revisited.

## Needs from others (0.2)
- **The lead**: is there a real API yet for "this call is bound to the person's own turn" (N1/N2's
  provenance check)? Point at it or say who to ask, so N1/N2 aren't guessed.
- **vault**: confirm whether `mcp.connect`/oauth.js exists yet and whether GitHub's hosted MCP
  needs a real client (spike 1) or the PAT covers it - blocks build steps 7-9 either way.
- **sessions/teammates**: the review-comment-as-ask and issue-as-goal shapes (plans/github.md
  section 8, unchanged since the plan) - still open, still needed before build step 10.
- **integrator**: stage/0.2 doesn't exist yet as of this session; this branch (work/github,
  3623113a) is ready to land once it does and once N1/N2 close.

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

## Changed contracts (0.2, this session, 3623113a)
- `core/github/connect.js`: `revoke()` and `REVOKE_URI` removed entirely (no export left). The
  device-flow client id constant (in `index.js`, not exported) is now GitHub CLI's own
  `178c6fc778ccc68e1d6a`, not a Vyre-owned app id.
- `github.remove`'s return shape changed: was `{ removed, revoked, warning? }`, now always
  `{ removed: true }` (or `{ removed: false }` if the account wasn't there). No more server-side
  revoke attempt at all.
- New tool `github.session.push {project, session, allow_secret?}` (people + `mcp`/agent
  callers). New error codes: `not_found` (no primary repo), `no_account` (recorded account not
  connected), `secret_found` (with `detail: { pattern, file, line }`), `non_fast_forward`.
- `github.session.worktree`/`.cleanup`'s internal behavior changed (no input/output shape
  change): they now resolve a project's repo via a new `repoOf()` helper that falls back to
  reading the folder directly (`folderGitState`/`defaultBranchOf`) when there's no
  `github_projects` row, instead of only ever working for a project `github.project`/`.add-repo`
  cloned.
- `core/github/git.js` gains `defaultBranchOf(repoDir)`, `scanOutgoing({ repoDir, branch,
  defaultBranch })`, `pushSession({ repoDir, session, defaultBranch, token, allowSecret? })` (all
  new exports, additive).

## 2026-10-01 restart
- Answered native-core's PR review and multi-file diff card field names in CHAT.md (09:10 github -> native-core): tools are github.project.pr.merge/.review keyed by {project, pr}, payload shape listed there. pr.get/.merge/.review added to the PR step (not built yet).
- Built github.project.pr.get / .merge / .review (core/github/pr.js, REST with the project's recorded account token). Merge and review: person always runs, an agent needs meta.asked (Gate's P17 field, from said_intents) or is held with code "held". Not yet declared as object entries (outward: asked) in module.json, waiting on platform's docs tooling on the stage base. 3 new tests, 46/46 in core/github, docs suites green after docs:ref.
- Next: pr.open + hosted-MCP allowlist once vault posts oauth.js; local-only projects (github.project.local-init); wire meta.asked to vault's confirmed field; rebase onto stage/0.2 tip before landing.
- Lead ruling: pr.get is a read, never held (already true). Merge/review clear on meta.asked OR a standing permission ("let kit merge green PRs here"); held only when neither. That check is the Gate's, not mine: the goal is to declare outward: asked in module.json and drop core/github's own requireAsked so the registry decides. origin/work/stage-0.2 has no Gate or standing-permission code yet (grepped core/lib), so requireAsked stays as a fail-closed stopgap. Not pushing until the base has the registry and no CI run is in progress.
- Built github.project.local-init (git.js localInit): git init -b main + starting commit minus .env/keys (excluded via .git/info/exclude, listed in left_out); existing commits untouched; nested-repo refused; people, agents, module:projects/sessions/threads. 47/47 in core/github, docs green. Next: pr.open + allowlist (vault), object-entry declarations and drop requireAsked when the Gate lands, rebase before landing.
- Built github.session.history/.undo/.redo (git.js): undo saves the tip as refs/vyre/undone/<session>/<n> then resets the session worktree only (never main, never a remote); dirty refused; redo is ff-only. 48/48 core/github. Hook proposal to sessions posted in CHAT.md. Note: worktreeSafety checks refs/heads only, so undone commits are kept by the ref, not by the cleanup check.
- Lead tweaks done: undo never refuses a dirty tree (commits it as a marked WIP commit, saves the tip under refs/vyre/undone, redo restores it as uncommitted); github.session.cleanup gained deleted:true for thread.deleted (keeps commits and unsaved work under the ref, removes the worktree; ignored files such as .env still stop it and go to cleanup-needed). 49/49 core/github.

## 2026-10-01 resume (after the usage-limit restart)
- Undo mid-turn: github.session.undo calls threads.interrupt-in {cwd} on the session's worktree
  first; a refusal other than "tool missing" stops the undo. Test in index.test.js.
- Unarchive: github.session.worktree now accepts an existing branch (checks it out as is, keeps
  its commits) and returns an existing worktree unchanged. Test in git.test.js. Confirmed to sessions.
- requireAsked stopgap stays until vault's Gate lands; then declare outward: asked and delete it.
- pr.open and the hosted-MCP allowlist still wait on vault.
- Rebased onto stage/0.2 (795a00b7) and pushed: work/github at 50ddcffb, range 795a00b7..50ddcffb (12 commits).
  Found on the rebase: the registry allows only two-part event names, so github.session.undone made
  vyred skip the whole module (switchboard ADR 0041 test caught it). Renamed to github.undone; added a
  test that runs module.json through the registry's validator. 100/100 on core/github + switchboard + modules.

## 2026-10-01 sign-in runs the real gh (lead ruling)
- connect.js no longer runs the device flow under gh's client id. It spawns `gh auth login --web
  --scopes repo --skip-ssh-key --insecure-storage` in a private folder (HOME + GH_CONFIG_DIR inside,
  minimal env, no GH_TOKEN), parses the code and address from gh's stderr, waits for a clean exit,
  reads `gh auth token` once, files it in the vault item github-<name>, deletes the folder.
  Verified the real gh's output shape once (code + URL on stderr, killed at once, no account used).
- No gh: error code gh_missing; PAT paste stays the fallback. Binary from ctx.config.gh, VYRE_GH_BIN or PATH.
- Tests: connect.test.js rewritten against a fake gh binary (9 tests). ADR 0041 decision 2 has a revision note.
- Needs: integrator adds gh to the box image and the Mac server installer (told). Vault agreed in CHAT.
- reviewer-2 M1/M2 (lead rulings): pushSession pushes to https://github.com/<full_name>.git built from
  the github_projects row (never origin/.git/config); refuses when url.*.insteadOf/pushInsteadOf
  matches or `ls-remote --get-url` differs (remote_changed); proxy/credential-helper detours forced
  off with -c; records origin/<branch> after a push so cleanup still sees it as on a remote.
  allow_secret counts only for a non-model caller or meta.asked. cloneRepo left (fresh dir, no local
  config: reviewer's LOW). Tests in git.test.js and index.test.js.
- reviewer-2 LOW on 622904e8: gh is resolved to an absolute path (config/VYRE_GH_BIN if absolute, else /usr/bin, /usr/local/bin, /opt/homebrew/bin, /bin, else a PATH folder the user cannot write); a planted gh in a writable PATH folder is never run.
- reviewer-2 include.path bypass + lead ruling: no more per-key config scanning. pushSession now pushes from a fresh throwaway bare repo (alternates to the project's objects, one ref, git defaults, no template), token only there, folder deleted after. Test poisons origin/pushurl/insteadOf/http.*/include.path/credential/gitProxy and asserts the temp repo has none of it.
- pr.open built (github.project.pr.open {project, title, session|head, base?, body?, draft?}): REST POST /pulls
  with the recorded account, head from vyre/<session> (pushed first with github.session.push) or a named
  branch. merge/review/open now declare reach: "asked" in module.json and requireAsked is deleted: the
  registry refuses an agent's unasked call with not_asked (core/github/registry.test.js boots a real vyred).
  Until vault's said-match wiring lands the registry refuses every model call to them (fail closed).
- Hosted MCP: vault's githubServer row (c78e6f9d on work/vault-next, api.githubcopilot.com/mcp/, bearer from
  github-<login>.token). Wiring mcp.add on connect (grant the item to mcp first) waits for that to reach
  stage; pr.status/comments/issue reads are next.
- "#" mentions provider (lead, 1 Oct): module.json `mentions: [{kind: "github", label, search, resolve}]`, tools
  github.mentions.search {q, kinds?} -> {results:[{kind, id, name, hint, icon}]} (repos by name, open PRs and
  issues via /search/issues involves:<login>, across connected accounts; names only) and github.mentions.resolve
  {id} -> {kind, id, name, url, text, outside:true, note}. ids: repo:o/n, pr:o/n#N, issue:o/n#N, strictly parsed.
  Callers: people plus module:mentions/platform/sessions/threads (firstParty). Platform owns the field's schema
  and the fan-out; unknown keys are ignored until it lands.
- Hosted MCP wired (vault's githubServer row is on stage): connecting an account grants its vault item to mcp
  and mcp.adds api.githubcopilot.com/mcp/ (bearer from github-<name>.token; row "github", later accounts
  "github-<name>"; tools.deny create_or_update_file/push_files/delete_file, since pushes go through
  github.session.push and its secret scan; other writes are classified outward by the hub and held at the Gate).
  github.remove drops the row; github.mcp.sync (people) adds rows for accounts that predate this. Tests: index.test.js (fake hub) and registry.test.js (the real hub accepts the row, refuses another host).
- Read tools built: github.project.pr.status (checks, latest reviews, ready verdict; no outside text), .pr.comments (conversation + inline + review bodies, person/outside), .issue.list (state/q/limit, PRs filtered out), .issue.get. Agents may call them; reads need no Gate. Tests in index.test.js.
- Said-match binds the target (lead): manifest entries for pr.open/merge/review carry `target: "github.act.target"`; that internal tool (callers module:vyred/platform) answers the whole `to`: {to:["<tool>:owner/name#PR"]} for merge and review and {to:["<tool>:owner/name@branch"]} for open (lead ruling: one composite key). The registry is to pass it as-is to vault.said.match, so "merge it" about #12 never covers #40. Needs platform's `target` field; real-registry test follows when it lands.
- For sessions' pr.* intents: github.act.target also answers module:threads; new internal github.session.pr {project, session} -> {prs:[numbers]} (open PRs whose head is vyre/<session>; callers module:sessions/threads).
- reviewer-2 M-G3: every project tool an agent can call (pr.get/status/comments/open/merge/review, issue.list/get, session.push/history/undo/redo, local-init) checks meta.granted (the verified agent's project grant, "*" or slugs) and answers not_found for a project outside it (inGrant in index.js). act.target is asked by the registry as module:vyred, which carries no grant, so the tool itself is where the guard runs.
