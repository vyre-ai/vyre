# import

Branch: work/memory-iq · Worktree: ../vyre-memory-iq · Owner: memory-iq · Design: docs/design/import.md

## Scope

The device side of 0.1.1's flagship: discover this device's Claude Code sessions (metadata only),
let the person choose, and report the import stage by stage. Sending to a box is federation's.

## Done
- `import.scan`, `import.plan`, `import.status` (core/import), person surfaces only; tests in
  core/import/import.test.js on a temp home with fixture sessions.

## Next
- `import.start {plan, mode}` with federation's sender; local import (config transcripts and skip
  folders) where there is no box.
- Box side: the synced root, the machine on every derived row, `import.progress` events.

## Needs from others
- federation: the sender and per-file acks. launch: the onboarding steps. app-design: the screens.
