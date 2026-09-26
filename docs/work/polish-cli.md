# polish-cli

Branch: work/polish-cli · Worktree: ../vyre-polish-cli · Owner session: polish-cli

## Scope

Driving Vyre from the terminal feels as native as Claude Code's own. Owns `core/cli/screen/`,
`core/cli/kit.js`, `scripts/stress-drive`, and the consistency pass over `core/cli/commands/*`.

1. `vyre` with no arguments: one live screen. Inbox (held drafts, open asks), projects, sessions
   and agents on the left; the selected session's output streaming on the right.
2. Every command: same verbs, `--json` on every read, exit codes 0/1/2, errors that name the
   next step, no stack traces, `vyre help <cmd>`.
3. `scripts/stress-drive`: 4 headless threads for 30+ minutes on the fake Claude.

## Done

## Doing

- all three, in parallel

## Next

## Needs from others

- tailnet: `link.health` shape for the status line (asked).
- connectors: `vyre connect` conventions and any tool the screen should show (asked).

## Changed contracts
