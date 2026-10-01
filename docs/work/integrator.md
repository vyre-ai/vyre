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

- 30 Sep: spikes on GitHub hosted runners (release-spike.yml, run 36659672015, all green):
  - **I1:** box/Dockerfile builds natively on linux/arm64 (ubuntu-24.04-arm) in 42 s uncached, 912 MB, and boots healthy. Node 22 and Claude Code 2.1.285 run on aarch64.
  - **S10:** the computer image builds on arm64 in 76 s, 1.2 GB. Debian's Chromium 154 runs headless.
  - **I3:** keyless cosign works. A box verifies with only a pinned cosign binary (v2.5.2, checksum-checked) against the release workflow's identity; a wrong identity and an unsigned image are both refused; one verify takes 264 ms online. But the binary is 127 MB, too big to fetch per box. Plan: verify from inside the running image on updates, and on a fresh install use the pinned cosign container by digest.
  - **IM1:** with the new image and compose topology, account uid 2000 can't read 2001's HOME, write into it, or read its /proc environ (nor can vyre-agent). The watchers' uid 3000 is refused to 1.1.1.1, a 100.x address, 127.0.0.1 and ::1, while uids 1000 and 2000 still connect. Caveat: tailscaled wasn't logged in, so the rule order under a live tailnet is checked again on e2e2's matrix.
- 30 Sep: box/Dockerfile and compose.yml have the per-account uids 2000-2063 (0700 HOMEs, vyre-accounts volume) and the uid 3000 OUTPUT REJECT (158b7dfa).

- 30 Sep: LANDED platform work/platform-contract 12a09627 on stage/0.2 as merge 795a00b7 (CI run 36667526975: node 22 and 24, box-image, sessions-sdk, capsule-mac green; two single-test flakes, computerd CDP identity on 22 and upgrade.test.js on 24, each green on rerun, neither touches platform files). Next in the order: tailnet-02, sessions-02, launch-onboard-fix.
- 30 Sep: tailnet-02 NOT landed. A test merge through 24fb61c2 plus c97dbf01 was red (15 failures), and the branch's own CI at c97dbf01 is red too (sdk types miss declaredSetupTools and coreKeys, tailnet.test.js:211, ten onboard tests). Stage reset to 795a00b7. Sent to tailnet; asked reviewer-2 about 34ccec9b, which has no clearance.
- 30 Sep landings on stage/0.2 (mirror work/stage-0.2): keychain flags 47dafe78, capsule sight flake fix ff2471f0, node.yml routing team branches to the self-hosted linux-heavy runners (4059d2c4, green); drive b4684a4d as e1a061cc (green after flake reruns). native-core 154bb822 merged as 0d3c0dee, CI rerun pending (perf-check CPU 13% on Node 22 once).
- Held, sent back: capsule-sight cce7f44e (15 failures after merge with stage), vyre-core 6de509a4 (one test, install-mac-server gh pinned download, fails on Ubuntu), tailnet-02 c97dbf01 (cleared, but red on its own CI).
- Recurring flakes on hosted runners: hands-chrome "Chrome did not print its DevTools port in time", computerd CDP identity, upgrade.test.js, clipboard timing. Sent to native-core (started after 47dafe78).
- Wrote team/0.1.5-ASSESSMENT.md (subagent draft): ship only as a beta prerelease.
- 30 Sep later: stage/0.2 = ae8a9aa0 (0d3c0dee + vyre-core 6b20be7c + hands-chrome 30 s wait + CI path filter 5885f777 + tailnet-02 0e3e3397 + sessions-node24 799e90e9 + native-core 0217a609 + drive 7c2bbf10). I reset stage once at 05:56 UTC without posting; posted in CHAT at 07:40 and will fix forward or revert from now on.
- OPEN: since 0e3e3397, Node 22 hangs after threads-sessions.test.js (handle leak) and perf-check fails at 13.25% CPU. Sent to tailnet and platform. Node 24 passes tests.
- Held: launch (conflicts, rebase asked), capsule-sight, glass, artifacts, teammates (after sessions-02), sessions-02, platform newer head.
- 30 Sep: stage = ab145ccf (+ sessions-02 e9a127f1 as 600c789a, tailnet b8bda0e1). CI: two setup.test.js failures (sessions now declares setupTools; tailnet fixing) and nondeterministic hangs (sessions.test.js under sessions-sdk at 120 s; Node runs cancelled at 30 min in two of three). platform's perf fix 3fd7f029 (recall_turns scan) works on Node 22 but platform-contract conflicts with stage in core/daemon/index.js and core/modules/index.js; platform merging.
- Queue: artifacts 20ae471a, glass, teammates (after sessions-02), capsule-sight (rebasing), launch (rebasing), platform.
- 1 Oct: stage/0.2 = 6731781b, fully green (node 22 and 24, test-windows, windows-socket-acl). Landed in order: platform-contract, tailnet, vyre-core, sessions (02, hang fix, start-mentions, heard-next, memory-person, acp-real), drive, native-core (cards, sites), github, connectors, vault, teammates, artifacts, assistant, windows, launch, capsule-sight through 9c537d35, iq-land and iq-s2 (site learning, ON by default), app-design (icons, shots), plus flake and CI fixes. Policies kept: two branches per run, touched tests before every push, no daemon tests on the Mac, fix forward or revert (no resets); the iq merge was reverted once (b88f1c6a) and re-landed.
- Held: capsule-sight past 9c537d35 (egress fail-open fix 7174ee79 still fails real Chrome). Not started: release.yml v2 (superseded by anywhere's single Ed25519 signing design), box-image isolation checks beyond sessions' acct-home.
- 1 Oct (paused, usage limit): stage/0.2 = 116f8455b (open reds: artifacts sandbox-chrome.mjs lacks CHROME_SAFE; iq-sitelive's computed call in local/hands-chrome-mac/index.js is not on test/reach-computed-calls.json). The lead froze stage and moved to the rc-0.2 candidate (draft PR #2) as the one path to stage; stage takes rc-0.2 in one merge, taking rc-0.2's side. My reverts on stage: plat-trust 8d6a8ff07 (c18f88255) and launch beb4a15f; launch's superset branch re-adds beb4a15f's files (merge it, do not revert the revert). Watchers 7d35ddc72 was merged and reverted (wall needs a test seam: watchers 604183096 has it). Main: 4e8e0c220 node-hosted.yml, 27e7bbf5f realuse + h2h workflows, 8afbd6268 relay-deploy.yml, f10ba1145 memory-eval-record.yml, 58e60480 and 793ba6b86 site. Helper scripts: /tmp/lm.sh, /tmp/rb.sh, /tmp/wait.sh (merge with docs-only conflict handling, gate, push, wait).

## Doing

- release.yml v2 on work/integrator: buildx multi-arch, push by digest, cosign sign and attest, minisign, release.json v2. Dry-run first.

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
