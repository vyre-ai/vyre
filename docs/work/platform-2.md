# platform-2

Branch: work/kernel-allow · Worktree: ../vyre-platform2

## Scope
Four items from reviewer-2's review of work/kernel a148d874e: the golden allow file (BR-1, generated entries), the packaged daemon refusing a kernel-off start (MA-5), and a build-time duplicate-module-name test.

## Done
- Item 1: the six declared-anyone tools leave allow.json; golden re-recorded. Bridges tools refuse anonymous, guest, hook and module callers at the gate; spaces.invites.redeem and spaces.code.submit run only for relay and device callers.
- Item 2: scripts/gen-allow.mjs (npm run gen:allow) writes kernel/golden/allow.json from core/modules/agent-reach.js and the flows manifest, one reason per entry; kernel/golden/allow.test.js fails on a hand-written, person-only or unlisted entry and on drift. Stale flows approve, pause, resume, kit.remove, files.drive.access and threads.mode are gone.
- Item 3: a packaged daemon refuses to start with the kernel off (lib/build-kind.js, kernel/devbuild.js devSwitch); a development checkout starts as before. kernel/devbuild.test.js covers both.
- Item 4: test/module-names.test.js fails on a duplicate module name; the chrome pair is set aside in scripts/packaged-boot-known.txt.

## Doing
Merged origin/work/kernel 90bbaa725; running the test set on testbox2 before the push.

## Next
Push, send the sha to platform and reviewer-2, report to team-lead.

## Needs
- platform: rule on the duplicate module name `chrome` (local/hands-chrome-mac and modules/hands-chrome). scripts/modules-manifest.mjs refuses it. Neither is renamed here; key the signed list by role or path. Delete the line in scripts/packaged-boot-known.txt when fixed.
- PH-1 (callerFacts) is not in this branch.
