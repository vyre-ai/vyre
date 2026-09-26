# Launching the parallel sessions

The main session owns `main`: it merges finished work, keeps the shared core and the contracts, and
watches every stream. Each workstream runs in its own Claude Code session, in its own worktree,
on its own branch. The streams never edit each other's folders.

## Wave 1: start now

| Session | Brief | Worktree |
|---|---|---|
| vault | `docs/work/vault.md` | `../vyre-vault` |
| watchers | `docs/work/watchers.md` | `../vyre-watchers` |
| box | `docs/work/box.md` | `../vyre-box` |
| switchboard | `docs/work/switchboard.md` | `../vyre-switchboard` |
| deck | `docs/work/deck.md` | `../vyre-deck` |
| capsule | `docs/work/capsule.md` | `../vyre-capsule` |
| learning | `docs/work/learning.md` | `../vyre-learning` |

Wave 2 (`computers`, `gate-chat`) starts when the switchboard and the vault have merged.

## Start one

From the main repo:

```
git worktree add -b work/<stream> ../vyre-<stream> main
cd ../vyre-<stream>
claude -n "vyre <stream>"
```

Then paste, with `<stream>` replaced:

> You are the **<stream>** workstream of Vyre. Work only in this worktree, on branch
> `work/<stream>`. Read `docs/SPEC.md`, `docs/MODULES.md`, `docs/work/README.md` and your brief
> `docs/work/<stream>.md`, then the existing `core/` code to match its style. Use subagents for
> independent pieces. Follow spec section 14: tests beside the code, a temp `VYRE_HOME` in every
> test, real data once before merge, CHANGELOG under your own heading, conventional commits by
> path, no personal data anywhere in the repo. Touch only the folders your brief owns; if a
> shared file must change, make the smallest change, test it, and write it under "Changed
> contracts" in your brief. Keep the Done / Doing / Next / Needs sections of your brief current
> and commit them. Don't merge to main and don't push. When you reach something only the user
> can give (an account, a token, a machine), stop and say so.

## How the main session watches

- `git log --oneline main..work/<stream>` and each worktree's `docs/work/<stream>.md`.
- `ListAgents` shows every local session by name (`vyre <stream>`); the main session can message
  one directly when a contract changes.
- A stream is merged when its done-when is met and `npm test` is green on the merge.
