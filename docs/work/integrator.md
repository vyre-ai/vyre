---
title: integrator
summary: Merges onto stage/0.2, the 0.2 release pipeline, and the update channel.
audience: builders
owner: integrator
status: draft
---

# integrator (0.2)

Branch: work/integrator, off stage/0.2 · Worktree: ../vyre-integrator · Lands onto stage/0.2 in ../vyre.
Plan: team/0.2/plans/integrator.md. PLAN.md rows: R1, R4, R5, R7, Wave A (release pipeline), Wave A0 (box-image isolation, spike IM1), spikes I1 to I10.

## Scope

- **stage/0.2** (local branch in ../vyre, mirrored on GitHub as work/stage-0.2 for CI, because the pre-push guard accepts only main and work/*). Every team lands only through me, after reviewer or reviewer-2 clears the code shas, trailer-free, and the full CI suite is green on Node 22 and 24 plus sessions-sdk. main stays 0.1.1 until the release gate.
- **release.yml v2:**
  - multi-arch (amd64, arm64) box and computer images pushed to ghcr by digest;
  - cosign keyless signing and attestations;
  - minisign over SHA256SUMS from a protected GitHub environment;
  - release.json v2 (additive: `images`, `apps`);
  - vyre.run/box deployed from the same artifacts and checked byte for byte.
- **Box image changes (Wave A0, with sessions and watchers):**
  - a uid range and 0700 HOMEs for per-account isolation (P3);
  - a kernel rule that gives watchers' child uid no network;
  - spike IM1 on a hosted runner.
- The Node 24 teardown fix (sessions' work/sessions-node24), landed after review.
- The update gate scripts e2e2 runs: the 0.1.1 hop, fresh install, tamper, rollback, computers.

Never the test box (now the user's real server) and never the user's Mac. Tests run on GitHub hosted runners, or on DigitalOcean throwaways tagged vyre-test.

## Done

- 30 Sep: stage/0.2 cut from origin/main 9381ab15, mirrored as work/stage-0.2.
- 30 Sep: the platform test merge (work/platform-merge 3e1eef47) failed the full CI suite: 23 tests, where the default-deny for added modules breaks home-installed fixture modules. It is not landed.

## Doing

- The release.yml v2 design, and spikes I1 (arm64 build) and I3 (cosign verify on a box).

## Next

1. Land platform 84f901ce, plus vault's fixture move, plus the fixes for the 23 failures, once all are cleared and green on the full CI.
2. Land the Node 24 fix once reviewed.
3. release.yml v2 on a work branch, dry-run only; images go to a scratch ghcr name until the lead says go.
4. Box-image isolation changes and the IM1 spike, with sessions and watchers.

## Needs from others

- platform: the fixes for the 23 fixture failures, trailer-free.
- sessions: work/sessions-node24 sent to a reviewer; the uid-per-account contract (names, range).
- watchers: the watcher child uid, and which network it may reach (none).
- lead and user: a protected GitHub environment "release" (reviewers: the lead and me); a minisign key made by the user, with the backup printed offline (6A10); a scoped Cloudflare token for the site deploy (6A2).
