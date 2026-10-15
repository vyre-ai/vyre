# Archive

This branch lists the branches that were deleted from the repository on 16 Oct 2026, and why.

Every branch whose work is not in `main` was kept first as a hidden ref, `refs/archive/<branch name>`, at the same commit. To bring one back:

```
git fetch origin 'refs/archive/<branch name>:refs/heads/<branch name>'
```

Branches whose commits are already in `main` were deleted without an archive ref.

Kept: `main`, `archive`, `release/0.6`, `release/0.7` and every `work/0.6/*` branch.

## Summary

| Kind | Branches | Meaning |
|---|---|---|
| SUPERSEDED | 480 | every commit is in main or replaced by newer work |
| ARCHIVE | 112 | parked work that is not in the plans |
| EMPTY | 28 | notes or changelog only, no code |
| Planned item R051-11 | 2 | work that belongs to a planned item and is only partly in main |
| Planned item R051-02 | 2 | work that belongs to a planned item and is only partly in main |
| Planned item R052-08 | 2 | work that belongs to a planned item and is only partly in main |
| Planned item R051-18 | 2 | work that belongs to a planned item and is only partly in main |
| Planned item R051-15 | 2 | work that belongs to a planned item and is only partly in main |
| Planned item R051-14 | 1 | work that belongs to a planned item and is only partly in main |
| Planned item R051-10 | 1 | work that belongs to a planned item and is only partly in main |
| Planned item R052-11 | 1 | work that belongs to a planned item and is only partly in main |

The merged branches (about 1,200) are not listed.

## Parked work

| Branch | Why parked |
|---|---|
| `work/022-accounts` | parked work from 2026-10-02, not in the plans (0 of 179 added lines in main); "docs: use an example address in the AI accounts changelog entry" |
| `work/022-claim-retry` | parked work from 2026-10-02, not in the plans (0 of 152 added lines in main); "passkey claim: app-design's copy" |
| `work/022-copy` | parked work from 2026-10-02, not in the plans (9 of 753 added lines in main); "fix(copy): tests and docs anchors follow the new wording (#22)" |
| `work/022-gate` | parked work from 2026-10-02, not in the plans (6 of 186 added lines in main); "docs: the held-page line says it needs sessions to report what a sessi" |
| `work/022-history-import` | parked work from 2026-10-02, not in the plans (12 of 242 added lines in main); "setup: the history step says to open Lumen to choose what to import (r" |
| `work/022-link-sleep` | parked work from 2026-10-02, not in the plans (18 of 57 added lines in main); "link: relay thread.tool; a sleeping Mac says goodbye and wakes with a " |
| `work/022-media-drive` | parked work from 2026-10-02, not in the plans (0 of 26 added lines in main); "docs: changelog for the Generated size and storage line" |
| `work/022-names-lows` | parked work from 2026-10-02, not in the plans (1 of 11 added lines in main); "names: clear the old route's moved note; document how to make the admi" |
| `work/022-native-android` | parked work from 2026-10-03, not in the plans (1491 of 2625 added lines in main); "native-android: apksigner prints 'V3.0 Signer: certificate SHA-256 dig" |
| `work/022-onboard-name` | parked work from 2026-10-02, not in the plans (3 of 26 added lines in main); "onboard: a claimed address is not replaced by the person's name (#50)" |
| `work/022-plat-trust` | parked work from 2026-10-02, not in the plans (16 of 910 added lines in main); "trust: the test-child label rule needs a home under the temp folder, n" |
| `work/022-provider-blocks` | parked work from 2026-10-02, not in the plans (0 of 89 added lines in main); "fix(sessions): an edit ask's file path is the tool's own location, not" |
| `work/022-send-feedback` | parked work from 2026-10-02, not in the plans (0 of 62 added lines in main); "feat(chat): Sending mark until the box answers, clear queued text, fiv" |
| `work/022-setup-log` | parked work from 2026-10-02, not in the plans (0 of 41 added lines in main); "setup: the panel keeps logging every step after the install (#21)" |
| `work/022-setup-recover` | parked work from 2026-10-02, not in the plans (0 of 79 added lines in main); "changelog: #57" |
| `work/022-star` | parked work from 2026-10-02, not in the plans (0 of 79 added lines in main); "feat(deck): the star button, one tap to star vyre-ai/vyre" |
| `work/022-taint-coverage` | parked work from 2026-10-02, not in the plans (2 of 89 added lines in main); "fix(threads): judge a shell command's network use on the raw command, " |
| `work/022-terminal-stop` | parked work from 2026-10-02, not in the plans (5 of 28 added lines in main); "harness: a hook with no verified session may not name a terminal sessi" |
| `work/022-uninstall-name` | parked work from 2026-10-02, not in the plans (0 of 83 added lines in main); "uninstall: offer to hand the name back, so the recovery code takes it " |
| `work/022-win-first-install-sig` | parked work from 2026-10-02, not in the plans (68 of 223 added lines in main); "fix(install): announce a test release key taken from the environment" |
| `work/022-win-pair-timeout` | parked work from 2026-10-02, not in the plans (0 of 19 added lines in main); "fix(windows): pairing waits 90 seconds for the box's handshake" |
| `work/023-companion-transport` | parked work from 2026-10-02, not in the plans (1 of 36 added lines in main); "link: the box signs its link.companion.hello answer with the key pinne" |
| `work/023-shell` | parked work from 2026-10-03, not in the plans (0 of 9 added lines in main); "0.2.3: pwa-shots: the v2 screens add Agents, an agent, Memory, Vault, " |
| `work/023-shell-shots` | parked work from 2026-10-03, not in the plans (0 of 9 added lines in main); "0.2.3: pwa-shots: the v2 screens add Agents, an agent, Memory, Vault, " |
| `work/023-win-local-core` | parked work from 2026-10-02, not in the plans (67 of 2903 added lines in main); "docs(windows): the join proof on the Win11 VM (refs #26)" |
| `work/023-wink-deploy` | parked work from 2026-10-02, not in the plans (13 of 318 added lines in main); "Merge remote-tracking branch 'origin/work/rc-0.2.2' into work/023-wink" |
| `work/038-own-surfaces` | parked work from 2026-10-02, not in the plans (21 of 52 added lines in main); "threads: a person's own surfaces are one participant and never lock ea" |
| `work/040-mcp-socket` | parked work from 2026-10-03, not in the plans (45 of 126 added lines in main); "boundaries: the Vyre MCP config helper is lib/mcp-config.js, so switch" |
| `work/042-default-account` | parked work from 2026-10-02, not in the plans (16 of 28 added lines in main); "sessions: a provider's only account is its default; an empty identity " |
| `work/043-computers` | parked work from 2026-10-02, not in the plans (7 of 103 added lines in main); "fix(#43): an older install with no DOCKER_GID takes the docker group f" |
| `work/058-planner-tz` | parked work from 2026-10-02, not in the plans (6 of 81 added lines in main); "fix(planner): read times in the person's own zone (device tz from cont" |
| `work/agent-core-auth` | parked work from 2026-10-10, not in the plans (15 of 58 added lines in main); "Merge remote-tracking branch 'origin/work/lead-031-w' into work/agent-" |
| `work/agent-core-guards` | parked work from 2026-10-10, not in the plans (43 of 91 added lines in main); "vyre: guards green (R031-00 item 0): classify the new tools, restore t" |
| `work/agent-core-img` | parked work from 2026-10-10, not in the plans (10 of 52 added lines in main); "Merge remote-tracking branch 'origin/work/lead-031-w' into work/agent-" |
| `work/agent-core-login` | parked work from 2026-10-10, not in the plans (12 of 92 added lines in main); "fix(sessions): login-direct decided per run, and one outgoing scrub fo" |
| `work/agent-core-ts` | parked work from 2026-10-10, not in the plans (82 of 246 added lines in main); "Revert "fix(switchboard): a session's stdio pipes are released two sec" |
| `work/app-design-shots2` | parked work from 2026-10-01, not in the plans (3 of 24 added lines in main); "docs: the Sites shot retaken from native-core 9ecc3ec6" |
| `work/app-design-sites-shots` | parked work from 2026-10-01, not in the plans (97 of 525 added lines in main); "docs: Sites deck files from native-core 49816196 (Recently forgotten r" |
| `work/approvals-app-031` | parked work from 2026-10-10, not in the plans (0 of 45 added lines in main); "vyre: the phone app's Now list reads approvals.items (R031-00c part 3," |
| `work/capsule-02-migrate` | parked work from 2026-09-30, not in the plans (0 of 398 added lines in main); "capsule: the Mac pieces of the 0.1.1 to 0.2 migration (R6)" |
| `work/capsule-02-spec` | parked work from 2026-09-30, not in the plans (0 of 339 added lines in main); "capsule: extract spec/capsule parity vectors (C2)" |
| `work/capsule-pro` | parked work from 2026-09-28, not in the plans (2 of 4 added lines in main); "capsule-pro: the IQ tests get 40 s on slow runners, so a timed-out wai" |
| `work/capsule-reach` | parked work from 2026-10-01, not in the plans (0 of 4 added lines in main); "Merge remote-tracking branch 'origin/work/plat-reach-own' into work/ca" |
| `work/capsule-sight` | Chrome control spike (capsule era); reference for R052-15/17 but not a base |
| `work/capsule-sight-caller` | Chrome fill spike (capsule era) |
| `work/capsule-spoken-fix` | parked work from 2026-10-01, not in the plans (11 of 41 added lines in main); "voice: spoken() uses [ \t] in every line-anchored pattern (no stall on" |
| `work/chat-03` | parked work from 2026-10-04, not in the plans (7 of 218 added lines in main); "feat(stream): stream.follow, a chat's stream over the peer wire" |
| `work/chat-03-daemon` | parked work from 2026-10-04, not in the plans (4 of 11 added lines in main); "feat(daemon): the stream's view of the kernel sessions (ctx.kernelSess" |
| `work/chat-login-rel` | parked work from 2026-10-10, not in the plans (293 of 525 added lines in main); "fix(sessions): Codex and Grok subscription logins run direct with the " |
| `work/chat-lumen` | parked work from 2026-10-11, not in the plans (6 of 102 added lines in main); "fix(capsule): the pinned chat is asked only through this computer's ow" |
| `work/cleanup-tailnet-2` | parked work from 2026-10-09, not in the plans (212 of 1566 added lines in main); "feat(records): a Gmail send made through a Connection is logged on the" |
| `work/connectors-scope-fix` | parked work from 2026-10-01, not in the plans (0 of 27 added lines in main); "fix(mcp): a stored scope that will not read is the default, not open, " |
| `work/design-homename` | parked work from 2026-10-11, not in the plans (1 of 2 added lines in main); "fix(spaces): the personal Space on a computer is named My Home at the " |
| `work/docs` | parked work from 2026-09-28, not in the plans (7 of 85 added lines in main); "docs: vyre server alias decision (ADR 0038); terminology rule warns, n" |
| `work/flows-ready` | parked work from 2026-10-11, not in the plans (0 of 33 added lines in main); "fix(flows): Flows tools wait for the host's record types, then say Flo" |
| `work/flows-ready-3` | parked work from 2026-10-11, not in the plans (0 of 42 added lines in main); "fix(flows): the could-not-set-up-records refusal tells the person what" |
| `work/integrator` | parked work from 2026-10-04, not in the plans (153 of 345 added lines in main); "docs(integrator): 0.3 resume notes, 4 Oct" |
| `work/integrator-loop` | parked work from 2026-09-27, not in the plans (3 of 11 added lines in main); "fix(daemon): loop.sh starts a killed vyred again under dash instead of" |
| `work/j9a` | parked work from 2026-10-11, not in the plans (16 of 42 added lines in main); "chore: regenerate space-tools.generated.js after the cross-Space twins" |
| `work/kernel-platform-draft` | parked work from 2026-10-04, not in the plans (7 of 81 added lines in main); "draft, superseded by work/kernel-allow" |
| `work/link-hardening-hang-22` | parked work from 2026-10-10, not in the plans (73 of 177 added lines in main); "fix(runner): a reader killed or finished takes its whole process tree " |
| `work/link-placefile` | parked work from 2026-10-10, not in the plans (42 of 154 added lines in main); "place-file: reviewed through 6274aad6d" |
| `work/mac-shell` | parked work from 2026-10-04, not in the plans (13 of 254 added lines in main); "fix(mac): the page bridge's comment says server, not the daemon's name" |
| `work/mac-shell-next` | parked work from 2026-10-04, not in the plans (8 of 249 added lines in main); "fix(mac): MW-6 stream path and query checked as a whole, MW-7 non-200 " |
| `work/memory-chat` | parked work from 2026-10-05, not in the plans (352 of 589 added lines in main); "kernel: a chat's folders stored sealed (ids and ciphertext only); per-" |
| `work/memory-shim-removal` | parked work from 2026-10-04, not in the plans (2 of 134 added lines in main); "Merge branch 'work/memory-access' into work/memory-shim-removal" |
| `work/native-core-b4fix` | parked work from 2026-09-27, not in the plans (2 of 4 added lines in main); "fix(settings): claudeHome for Claude Code's folder; settings-keys.css " |
| `work/native-core-sites` | parked work from 2026-10-01, not in the plans (0 of 15 added lines in main); "fix(memory): Sites shows a family by name and real count, and keeps to" |
| `work/network2-carry` | parked work from 2026-10-05, not in the plans (0 of 226 added lines in main); "fix(kernel): carry tests follow the per-file check" |
| `work/network2-carry-clean` | parked work from 2026-10-05, not in the plans (0 of 233 added lines in main); "feat(kernel): carryFiles skips and reports what the mover may not read" |
| `work/network2-srv` | parked work from 2026-10-05, not in the plans (2 of 248 added lines in main); "fix(wink): a waiting prefix read scans only what is new on each poll" |
| `work/one-mechanism-031` | parked work from 2026-10-10, not in the plans (59 of 104 added lines in main); "vyre: readers move onto approvals.items; cards carry named facts, wait" |
| `work/one-way` | parked work from 2026-10-05, not in the plans (28 of 174 added lines in main); "Merge origin/work/devbox into work/one-way (generated docs regenerated" |
| `work/operations-042` | parked work from 2026-10-10, not in the plans (1 of 7 added lines in main); "Merge remote-tracking branch 'origin/work/lead-031-w' into work/operat" |
| `work/operations-sign` | parked work from 2026-10-11, not in the plans (4 of 225 added lines in main); "docs: signing links are on the Space's own address; changelog" |
| `work/pairing-words` | parked work from 2026-10-05, not in the plans (0 of 3 added lines in main); "fix(wink): use the const in the device record check" |
| `work/plat-trust` | parked work from 2026-10-01, not in the plans (3 of 278 added lines in main); "presence: prune the terminal asks to the 30 tools that raise power or " |
| `work/pwa-copy` | parked work from 2026-10-02, not in the plans (0 of 15 added lines in main); "copy: the phone apps and Files view say your server, not box or vyred" |
| `work/pwa-v2` | parked work from 2026-10-02, not in the plans (0 of 425 added lines in main); "feat(phone): a kept place is a swipe page and More's first tile, no si" |
| `work/rc1/chat-own-account-always` | parked work from 2026-10-12, not in the plans (5 of 50 added lines in main); "refactor(switchboard): one line less in index.js" |
| `work/rc1b/agents-roster` | parked work from 2026-10-12, not in the plans (77 of 132 added lines in main); "merge planner-rows ff67e3898 into agents-roster" |
| `work/rc1b/planner-rows` | parked work from 2026-10-12, not in the plans (77 of 132 added lines in main); "records: the protected-types set is never staler than the store's defi" |
| `work/rc1b/vault-timeline-test` | test branch carrying member Skills screen commit (duplicate of work/next/member-space) and vault timeline tests |
| `work/rc1c/agents-row` | parked work from 2026-10-12, not in the plans (1 of 50 added lines in main); "feat(agents): the member door's roster row (agents.roster), roster fie" |
| `work/rc2/lentreturn-notice` | parked work from 2026-10-12, not in the plans (1 of 16 added lines in main); "fix(runner): when the owner's chat never settles for the hop back, the" |
| `work/rc3/hotfix-addserver` | small fix: first-run Add a server on a server-client Mac with no Personal space; not in plans |
| `work/rc3/needs-you` | Needs-you screens merge branch; Needs-you follow-ups are under Later in the 0.5.2 plan |
| `work/rc3/planner-off` | planner off in release behind one list; not in plans |
| `work/rc3/presence-key-tidy` | parked work from 2026-10-12, not in the plans (3 of 36 added lines in main); "fix(relay): a presence key offered at a bearer (classic QR) redeem is " |
| `work/rc3/records-io` | small fix: quote formula text in CSV export; not in plans, not in main |
| `work/rc3/scope-computers` | member computers tools limited to computers of agents they made; not in plans |
| `work/rc3/shell-design-4` | parked work from 2026-10-13, not in the plans (9 of 89 added lines in main); "Merge remote-tracking branch 'origin/work/rc3/stage' into work/rc3/she" |
| `work/rc3/sync-allowlist` | security fix: upload only agent-home transcripts, no project agent config; allowlist absent from main, worth cherry-picking |
| `work/rc3/sync-no-creds` | earlier form of work/rc3/sync-allowlist (upload allowlist); worth cherry-picking the later branch |
| `work/rc3/web-host` | web.vyre.run serves the signed web export; not in plans |
| `work/rc4-native-mount` | native Finder mount (drive changes, move, trash, mount tools); listed under Later in 0.5.2 plan |
| `work/rc4-vault-reader` | vault.me.shared.list for members; not in plans |
| `work/refuse-kernel-off` | parked work from 2026-10-04, not in the plans (0 of 42 added lines in main); "feat(kernel): MA-5 as ruled: a release build always runs with the kern" |
| `work/s3-patch-031` | parked work from 2026-10-10, not in the plans (123 of 284 added lines in main); "fix(gate,names): a held item's approver is the caller; a domain check " |
| `work/s6-patch-031` | parked work from 2026-10-10, not in the plans (10 of 143 added lines in main); "release: 0.3.1 notes name the S6 fix" |
| `work/setup-why-031` | parked work from 2026-10-10, not in the plans (219 of 442 added lines in main); "fix(relay,install): if the server can't start pairing, the install lin" |
| `work/site-copy` | parked work from 2026-09-28, not in the plans (17 of 715 added lines in main); "docs(site-copy): deploy log, Wink commit held for 0.1.1" |
| `work/site-mac-download` | parked work from 2026-10-02, not in the plans (1 of 42 added lines in main); "site: every Mac 'built on your Mac' line follows MAC_DMG (home, llms, " |
| `work/store-auto` | parked work from 2026-10-05, not in the plans (0 of 5 added lines in main); "feat(box): a server home defaults to VYRE_STORE=auto, falling back to " |
| `work/tailnet-hang` | parked work from 2026-09-30, not in the plans (12 of 30 added lines in main); "fix(names): watch the directory only when a name is held or being reco" |
| `work/tailnet-reach-2` | parked work from 2026-10-01, not in the plans (1 of 20 added lines in main); "Merge remote-tracking branch 'origin/work/plat-reach-own' into work/ta" |
| `work/trust-rg-031` | parked work from 2026-10-10, not in the plans (189 of 416 added lines in main); "fix(vault): the Flows connector catalog at start-up makes no vault key" |
| `work/typed-web` | parked work from 2026-10-05, not in the plans (18 of 45 added lines in main); "fix(spaces): honour the hooks.membership seam on a development build o" |
| `work/ui-customize` | parked work from 2026-10-04, not in the plans (0 of 24 added lines in main); "Revert "feat(app): vyre://join?link= opens the join card (verified by " |
| `work/vault-patch-031` | parked work from 2026-10-10, not in the plans (127 of 351 added lines in main); "fix(vault): an agent inside the person's CLI is held to a credential's" |
| `work/vault-words-030-2` | parked work from 2026-10-09, not in the plans (27 of 69 added lines in main); "fix(app): Vault in plain words" |
| `work/windows-home` | Windows home (vyre-seal.exe sealing service); Windows home is under Later in 0.5.2 plan |

## Planned item R051-02

| Branch | Why parked |
|---|---|
| `work/flows-lease-031` | a task credentials lent to its doer for the task life, via vault port; partly in main (152 of 285 lines) |
| `work/g10b` | standing approval covers connector Calls under the approver grant; not in main (0 of 115 lines) |

## Planned item R051-10

| Branch | Why parked |
|---|---|
| `work/rc2/g03-member-keys` | a member adds an API key, OpenRouter key or setup token as own AI account, private to their vault; not in main (12 of 400 added lines) |

## Planned item R051-11

| Branch | Why parked |
|---|---|
| `work/ci-peer-stress` | peer-stress CI reads the spec reporter; load-flake hardening; not in main |
| `work/files-flake` | redteam refusal tests made DNS-free and deterministic (flake hardening); not in main |

## Planned item R051-14

| Branch | Why parked |
|---|---|
| `work/rc1a/member-flows` | a member sets up, approves and starts Flows through their door, member runs; 139 of 217 lines in main, rest open |

## Planned item R051-15

| Branch | Why parked |
|---|---|
| `work/rc3/g08` | agent teammate task wake, per-agent daily turn bound, task grant ends on hand-in/stuck/expiry; not in main (15 of 1081); also touches R051-03 |
| `work/rc3/person-of-call` | personOfCall: one answer to who the person of a call is (handoff keeps original person); not in main |

## Planned item R051-18

| Branch | Why parked |
|---|---|
| `work/rc3/arch-05` | ARCHITECTURE.md front door and one page per 0.5 feature; docs not in main |
| `work/rc3/rules-05` | DEVELOPMENT-RULES.md and idle budgets spec/performance page; docs not in main |

## Planned item R052-08

| Branch | Why parked |
|---|---|
| `work/next/member-space` | carries the Skills screen for a member (and project files for members, tags); not in main as a screen |
| `work/rc3/member-store` | member Store branch; includes the Skills screen for a member commit (same as work/next/member-space) |

## Planned item R052-11

| Branch | Why parked |
|---|---|
| `work/rc3/g06` | tools_find one index: skills, learned operations and work_call operations found by search; paused at step 2a |

## Superseded and empty

These are archived under `refs/archive/` like the rest. List them with `git ls-remote origin 'refs/archive/*'`.
