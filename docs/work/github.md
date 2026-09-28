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

## Doing
- reviewer CLEARED work/github 3a72ea7f..84e76681; sent them acfcefd2 (the stdin fix) as a
  follow-up look. Pushed back (with evidence) on their LOW asking for
  `-c credential.interactive=never`: invalid value, and the real `false` value disables askpass
  entirely (confirmed empirically while building) - `GIT_TERMINAL_PROMPT=0`, already forced
  unconditionally, is what actually satisfies "no interactive credential prompt". Told the lead
  the same; waiting on either side to confirm this is settled (no new sha expected for item 1).
- Sent launch the full tool contract for Settings/onboarding (sign-in flow, event names, account
  list, disconnect, error codes). Waiting on their questions/build.
- Pinged sessions: does acfcefd2 clear their HIGH, and status on the start/end hook (offered to
  draft it as a diff against their file, their call).

## Next
1. Send `sessions` the actual gitWithAskpass diff (lib/git-safe.js + lib/git-safe-askpass.test.js)
   now that it's built and tested, for their review as a new-file diff, per their ask.
2. Settings (launch) and onboarding (launch) UI: device code + verification link, connected
   state with avatar, disconnect. Not this team's code; hand off the tool shapes (already stable:
   `github.connect`, `.accounts`, `.remove`, `.repos`, `.project`) once launch is ready.
3. Once sessions builds the start/end hook: verify `github.session.worktree`/`.cleanup` end to
   end from a real session (needs sessions' side to exist first).
4. Run the full suite on testbox once there's a natural checkpoint (nice -n 15, check load first).
5. 0.1.2 design-only items (not started): PRs from chat, issues as goals, per-project git
   settings, Touch ID on big moves, the GitHub App replacing the OAuth App's broad `repo` scope.

## Needs from others
- sessions: review the gitWithAskpass diff; build the session-start/end hook once they're ready
  (`thread.started` for start, `thread.stopped`/`.finished` for cleanup - their choice which).
- launch: Settings and onboarding screens, whenever they pick this up. Tool shapes are stable.
- integrator: fold `lib/git-safe.js`'s `gitWithAskpass` addition (currently only in this
  worktree, built against main's copy of the file) at the stage/0.1.1 assembly, alongside
  whatever sessions lands.

## Changed contracts
- `lib/git-safe.js` gains `gitWithAskpass(dir, args, { token, username?, timeout?, stdin? })`
  (new export, additive - `gitAsync`/`gitSync`/`safeGitArgs`/`safeGitEnv` unchanged).
- `core/vault/providers.js` gains a `github-oauth` entry (`how: "oauth"`) alongside the existing
  pasted-PAT `github` entry.
- `core/projects/index.js`'s `MAPPING_ALLOWED` (was `SYNC_ALLOWED`) now includes `module:github`
  (federation's change, sha 624edc76).
