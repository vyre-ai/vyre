# sweep (caller label sweep, part A)

## Scope
TAILSCALE-removal step 2, additive only: `device`, `space` and `agent` next to `tailnet` in every caller list and class; `lib/caller.js` parses the new labels; golden, reach and docs reference regenerated. Nothing deleted, no behaviour change for existing callers. Branch work/caller-sweep off work/kernel.

## Done
- callerAllowed: `device` entry admits exactly `device:<id>`; bare `tailnet`, `device`, `space`, `agent` are never a caller (CLASS_ONLY).
- caller lists extended (see the diff); approvals, vault reveal and vault forwarding got `device` only.
- lib/caller.js: isDevice, isSpaceMember, with tests for look-alikes.

## Doing
Golden regeneration, reach files, docs reference, tests and the boot check on a test server.

## Next
Report to platform.

## Needs
