# platform-3

Branch: work/kernel-declare (off work/kernel-reg bc6da3c96) · Worktree: ../vyre-platform3 · Owner session: platform-3

## Scope
Two jobs taken off platform. (1) What the registry defaults on work/kernel-reg break: run the suites on a test box, list every broken caller by owning team with the fix. (2) Declarations: `effect` on every tool, and a `callers` list wherever the body shows who may call a state-changing tool open to anyone. Lower the FROZEN count in test/registry-default.test.js with each batch.

## Done
- All 935 non-internal tools declare `effect` (manifest entry where it is an object, ctx.tool def where it is a string entry): FROZEN 906 to 4 (the four tools the test registers itself). One commit per module.
- Callers added or tightened where a body showed who calls it (see CHANGELOG and the per-module commits). Audit fixes inside: HD-1 onboard personOnly, HD-2 threads.start allow-list, HD-3 link.call origin, HD-4 harness.enrich, HD-5 hands resolveAgent, HD-7 session push/undo/redo own session, HD-9 agents.ask project cap, HD-10 charter draft/revert, memory.retrieve knobs.
- Suite run on testbox4, 640 files, one process per file: kernel-reg 534 pass 106 fail.

## Doing
- Separating pre-existing reds (base 58d3e8f54) from registry reds, then fixing tests and declarations the registry reds point at; per-owner lists in team/0.2/CHAT.md.

## Next
Re-run the red files on the branch, push, send the sha to reviewer-2. Then the DESIGN CHOICE list per owner (CHAT.md).

## Needs from others
Owners: each DESIGN CHOICE in CHAT.md. Not done: HD-6 (hands consequence guard, inverted to a safe set), HD-8 (memory.remember pending state), HD-4b (a label cannot say a person typed).

## Changed contracts
None. Effect is read from the manifest entry or the ctx.tool def (already supported by the registry); callers stay in code.
