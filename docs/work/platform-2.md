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
Resumed 4 Oct after the team restart. Item 3 re-applied on work/refuse-kernel-off 7e0c18fe5 (off origin/work/v0.3, which carries launch's env fix 6c20fffc7); kernel/devbuild + core/daemon tests pass on testbox, test/boundaries is red on v0.3 for core/daemon -> core/runner/homeproxy.js (runner's, not frozen).
Test integrity: work/test-integrity 38816d5fc (no force-exit, one process per file with a 300 s limit, counts guard); the hosted sweep (run 37168802529) found 11 hanging and 29 failing files, listed in CHAT.md. Reach classes: work/reach-classes 123d902b4. test/person-label-hygiene FROZEN: nothing lowered yet, 13 files listed in CHAT.md.

## Next
Record test/test-counts.json from the first full hosted run (artifact test-counts-run), triage failures by owner, lower FROZEN as owners fix.

## Needs
- platform: rule on the duplicate module name `chrome` (local/hands-chrome-mac and modules/hands-chrome). scripts/modules-manifest.mjs refuses it. Neither is renamed here; key the signed list by role or path. Delete the line in scripts/packaged-boot-known.txt when fixed.
- PH-1 (callerFacts) is not in this branch.
