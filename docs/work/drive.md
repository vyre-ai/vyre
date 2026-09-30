# drive

Branch: work/drive · Worktree: ../vyre-drive · Owner session: drive teammate ·
Plan: [team/0.2/plans/drive.md](../../../team/0.2/plans/drive.md)

## Scope

The 0.2 charter has no Drive minimum; the lead narrowed 0.2's slice to two pieces (CHAT.md
01:41, 06:25): the `projects.access.check` boundary already flagged by federation as an open gap
(drive-onboarding.md, `docs/design/`), and the backend for Drive file search that the Capsule and
the Windows panel need (Windows panel local search is out for 0.2; searching the box's Drive
shares is in — CHAT.md's B2). Everything else in plans/drive.md (the picker, a real onboarding
step, the Windows/phone clients themselves) stays 0.2.x.

## Done
- **The access boundary, closed for real.** `core/files/drive.js`'s `files.drive.local` (Mac
  side) used to answer any caller with wherever a box path is mounted, no scoping at all — a
  named agent could ask "where is this box path locally" and learn a mount existed for a project
  it was never granted. Now it calls `reach()` (the same door `files.search`/`.stat`/`.preview`/
  `.fetch` already use, which resolves to `projects.access.check`) and answers `null` for a path
  outside the caller's own granted projects, the same "never confirm what you can't see" shape
  every other refusal in this module already has.
- **`files.drive.search`**, new, box side and a thin Mac-side forward:
  - Box: searches by name (`search.js`'s existing `walk`) and content (`rg`, same flags
    `files/index.js`'s own search already uses, gracefully degrading with a note if ripgrep is
    missing) across the box's *offered* Drive shares — not just `files.roots` — since a share
    can name any folder. Reuses the same per-share safety check sharing itself already runs
    (`folder()`), so nothing describeInShare() returns can be a secret, a denied place, or
    outside the share's own folder. Scoped exactly like `files.drive.status`: the owner searches
    every offered share, a named agent only the ones its own granted projects reach. An `share`
    param narrows to one named share; asking for one an agent has no grant on returns an empty
    result, never a refusal (an ungranted share's existence is never confirmed either way).
  - Mac: forwards to the box for the owner's own surfaces only. An agent's caller identity does
    not survive the hop to the box (the existing, documented limitation `files.search` etc.
    already carry), so for now an agent calling this tool on the Mac is refused outright with a
    pointer to `files.search` instead of being served unscoped. Flagged in plans/drive.md as a
    known gap, not silently different behavior.
  - `module.json`: `files.drive.search` added to `does.tools`, plus a `teaches.tips` entry.
  - `docs/reference/tools.md`/`modules.md`/`index.md` regenerated (`npm run docs:ref`).
- Tests: `core/files/drive.test.js`, 5 new (2 Mac-side, 3 box-side): name+content search across
  shares, the secret-scan boundary holding for search the same as for sharing, the per-agent
  narrowing, the Mac forward's owner-only rule, and `files.drive.local`'s new scoping. 82/82 (78
  pass, 4 pre-existing unrelated failures already on this branch's base commit before this work —
  `core/files/dirs.test.js`/`files.test.js`, `files.dirs is not open to added modules` and
  `not available`, confirmed via `git stash` against 3e1eef47, not touched here) on
  `core/files/**/*.test.js`. `test/boundaries.test.js`, `test/docs-index.test.js`,
  `test/hygiene.test.js`: 16/16 after `docs:ref`.

## Doing
Lead's order (30 Sep): picker, Windows, phone are all IN 0.2, in that order, each to reviewer-2.
1. Picker: built (core/files/picker.js; candidates, measure, offer; Mac forwards). Decision: NO
   editable exclusion list, because Taildrive serves the whole folder and an exclusion would be a
   promise the transport cannot keep; sharing less means a smaller folder. 109 tests pass on testbox.
2. Windows mount (next), 3. phone browse and read (after).

CI on work/drive after merging stage-0.2 (026dcaa5 plus a docs fix). reviewer-2 CLEARED H1/M1/L1 (30 Sep); the platform merge fixed files.test.js's fixture. Targeted files + docs tests: 156/156 on testbox.

## Next
- Send the sha to the integrator for review before it lands on stage/0.2 (RULES.md: land only
  through the integrator, after review).
- Once teammates/iq confirm the project-slug grant key (plans/drive.md section 4.1, posted to
  CHAT.md 06:08, unanswered as of this writing), revisit whether the Mac-side agent restriction
  on `files.drive.search` (forward refused, use `files.search` instead) should become a real
  local search over the Mac's own mounted shares instead of an outright refusal — deferred here
  as a documented limitation, not silently dropped.
- The rest of plans/drive.md (picker, Windows/phone clients, Capsule drop target, onboarding
  card) is 0.2.x, tracked there, not here.

## Needs from others
- windows: the Taildrive-over-WebDAV spike on a GitHub-hosted Windows runner (plans/drive.md
  section 6), before the Windows panel can actually call `files.drive.search` against a real box.
- No blockers on the two pieces above; both are complete and tested standalone.

## Changed contracts
- `files.drive.local` (Mac): now takes `meta.caller` into account; behavior is additive (was
  unscoped for everyone, now scoped for named agents only; the owner's own surfaces are
  unaffected).
- New tool `files.drive.search` (box and Mac), documented above. No existing tool's shape changed.
