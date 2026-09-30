# platform

Branch: work/platform · Worktree: ../vyre-platform · ADR 0033

## Scope
Hackable Vyre (ADR 0033): a stable, versioned module API; extension points for every part; user modules and overrides that survive updates; `vyre update` from GitHub releases; `vyre module new/add/remove`; the boundary ratchet toward a thin kernel.

## 0.2: the module contract v1 (30 Sep, resume from here)
- ADR 0047 (docs/adr/0047-module-contract-v1.md), docs/MODULES.md, docs/build/AGENT-BRIEF.md, plan at <team-dir>/0.2/plans/platform.md.
- Owners agreed in CHAT.md 06:09-06:16: vault, iq, sessions, assistant, watchers, app-design. reviewer-2 red team (<team-dir>/0.2/reviews/platform.md): no BLOCKER, all HIGH/MEDIUM/LOW folded at 65c7bc74; re-check asked.
- Proof on this branch (not merged; the integrator merges after the person approves): v1 schema and checker, testing.js, conform.js, examples/modules/bakery, test/module-api-compat.test.js, v1 scaffold with AGENTS.md, `vyre module test`.
- Done on this branch: loader accepts v1 (ca17b36e), one declaration per ctx door (c937cfc1), reviewer-2's rules in harness and loader (2175ac24, 9a8552f5: fetch GET/HEAD, not_declared default-deny, no replaces for added modules, slot taps to a Gate card, updatePlan, one write per Gate item), changelog and reference (e1d722a0). 167/167 targeted tests, run locally in temp dirs.
- APPROVED by the lead (30 Sep) with the person's compatibility rule (ADR 0047 section 8), built in 616f1e74..d31fd54d. Ready to merge at the head of work/platform: 181/181 targeted tests. Next: build steps in the plan's section 7; docs owner to move first-module.md and module-contract.md from apiVersion to vyre.

## SAVE (30 Sep, paused for the usage limit)
- Branch HEAD 9aaa402d (plus this note) is pushed as work/platform-contract. The old remote work/platform has pre-rewrite history, and we never force-push.
- CI running on work/platform-contract: node https://github.com/vyre-ai/vyre/actions/runs/36660039136 , sessions-sdk https://github.com/vyre-ai/vyre/actions/runs/36660039123 , box-image https://github.com/vyre-ai/vyre/actions/runs/36660039153
- Code review: reviewer-2 cleared 84f901ce on the condition that the vault fixture move lands with it (41fffb54). N1 is fixed (69690f9e). N2 and N3 wait for the host build. The integrator's 23 failures are fixed via firstPartyRoots (b59e893f, 9aaa402d).
- Next: (1) if CI is green, SendMessage the lead one line with the green node run URL, then send the integrator the sha (trailer-free, checked). (2) If red, compare against main's own failures. The subagent found these also failing on pre-merge main 9381ab15: files.test (3), google next ordering (1), sessions and sessions-turns (5), and vault-cli/vault-next (presence.methods missing on test/helpers `present`, owner to agree the one-line fix). Fix any that are ours. (3) Ask reviewer-2 to re-check the diff 84f901ce..HEAD (firstPartyRoots is new loader surface).

## Done
- ADR 0033 accepted by the lead (decisions recorded in the ADR). Inventory in its appendix.
- Team asks sent 2026-09-27: native-core (module settings into the registry: they pick "settings reads manifests" or an internal settings.register), sessions (providers shape frozen by the schema; hooks seam in canUseTool, P4), polish-cli (verb shapes, who writes module.js/update.js), app-design (card shapes, iframe tokens, slot placement), pwa (slot registry + sw caching of /m/<module>/), ci (lib/* in boundaries, the release workflow), chat (renderer slot heads-up).
- P0 written: packages/module-sdk (manifest.schema.json, manifest.js checkManifest, index.d.ts, package.json private, README), test/module-sdk.test.js, docs drift fixes in docs/architecture/spec.md and docs/build/module-contract.md.

## Doing (2026-09-27, after resume from logout 4)
- P0 for batch 4: work/platform e8e3d902 (merges main 7880dfa6; 101/101 targeted) sent to the integrator; the old b4 had the stale 2e6997dd.
- Store limits: work/platform-store-limits 67abc47f = c9f1d630 + a clean merge of native-core 19b92574 (48/48 on testbox). ADOPTED by native-core in 62abf2cf; e2e confirmed in its re-review.
- settings.write e4515fb6: HELD until e2e signs off native-core; only masking secret settings in settings.get is left. Then rebase e4515fb6 on it so settings.write returns the same masked value (asked native-core for a shared mask helper), e2e re-review, then integrator. Then hand to the integrator.
- Hub asks to native-core (hub file + live hand edits, per-key check tool, choices tool, prompt-layer toggle key): re-sent; no answer yet. They fold them into ADR 0035.
- P2 DONE on work/platform 54180bb5 (145/146 on testbox, 1 skip = shellcheck absent; shellcheck clean by hand): core/cli/commands/update.js + core/cli/update/releases.js (Mac), box/vyre update/rollback (box, APK + releases.sign), docs/using/box-care.md, draft docs/build/first-module.md. up.js exports health/waitFor/bring; bring compares against mineOf().version. Not tried end to end with a real npm install and restart; releases stay dry-run (VYRE_RELEASES unset).

- Batch 4 sha sent to the integrator: a1c3fbfc (includes e8e3d902 + 54180bb5, plus the cohesion/tips schema keys and tips.whatsnew in update). Branch CI runs cancelled (lead: Actions saturated; push only finished shas until "pushes open").
- Agreed with cohesion: P1 adds commands.list {surface}, events.catalog (aliases = one-release deprecations, plural canonical), registry.status() rows gain commands/connections/suggest/notices; Render type in index.d.ts. settings.changed resolved value asked of native-core.
- Agreed with docs: they add ctx.declaredTips in core/modules on work/docs (+ index.d.ts).

- ADR 0035 (native-core 799ad333, approved) reviewed: answers the four hub asks. Schema aligned locally in abc5e6da (device/session levels, check/choices {tool}, no device on confirm/security keys). Asked native-core: hub.json in vyre backup (update rollback depends on it), check/choices behaviour when the tool is off or slow, choices naming, rev returned by the store write, enforce session level. settings.write must bump rev once the hub store lands.
- Local, unpushed (pushes paused): 89120047, 339dee40, abc5e6da, this notes commit.

- settings.write: work/platform-settings-write 70242656 (local) merges native-core's local 3ae4fc93 (maskFor), returns secret keys masked; 64/64 settings+modules+presence-bypass on testbox. Waits for e2e's sign-off of native-core, then e2e re-reviews 70242656, then integrator. Later: rev + non-secret value on its settings.changed once the hub store lands.
- Agreed with native-core: settings.changed = rev + value at the changed level for non-secret keys. Schema: secret flag in 172da703 (local).

- ADR 0035 accepted (native-core b95cc4dc) with my five notes answered. Schema matched in 8c74d585 (choicesFrom, session needs tool store). validateDecls patch sent to native-core (scratchpad validateDecls-adr0035.patch; they apply + test). Waiting: their hub store step 1 sha (rev-returning write) to rebase settings.write.
- settings.write 70242656: e2e ok, handed to the integrator (merge after native-core 3ae4fc93).

- Cohesion ADR 0036 asks accepted for P1: meta.call from header X-Vyre-Call-Id (per-thread socket + MCP only, ^[A-Za-z0-9_-]{1,128}$, linking only, never for decisions); registry.status() rows gain use {calls, lastUsed} for person/agent callers only (not module:), in memory, flushed to a kernel table at most once a minute and at stop. Glue module 4 is `waiting`.
- P1 split: the settings-free part (call id, use counts, commands.list, events.catalog, status fields commands/connections/suggest/notices) can start on work/platform now; ctx.settings waits for native-core on main.

- P1 settings-free part DONE 382a8574: meta.call (X-Vyre-Call-Id on session paths), use counts (modules_use, 60 s flush), status fields, ctx.modules.status()/tools(), core/commands (commands.list), core/event-catalog (events.catalog). Sessions must send X-Vyre-Call-Id.
- End-to-end `vyre update` on testbox (npm path, throwaway): update 4.6 s, failed-health rollback 18 to 25 s, --rollback 5.4 s, RSS ~83 MB settled; found and fixed a prune bug (9343bc44). Box wrapper path not run (needs own compose project + no tailscale login).
- Combined targeted run 217 pass / 0 fail / 1 skip (shellcheck). Finished sha for the integrator: 9343bc44.

- Batch 4 red fixed: work/platform-b4fix 97686e1b (checkout build update downloads nothing), with the integrator.
- work/platform b7bbf5d8 (pushed): merges b4d + fix; ADR 0035 schema; P1 settings-free; vault needs.credentials loader diff (ctx.modules.status(), not .list); Render (7 kinds); statusline surface; ADR 0033 theme -> ADR 0035 (appearance.scheme). 393 pass / 0 fail / 16 skip.
- settings.write af5160dd (pushed) on native-core ac34c322: mirror() rev + said(); 74/74. e2e ok BUT held (local 691910b3 merges native-core 22d8fae9 + the hub.json secret test, NOT yet run: testbox on hold; native-core confirms cli over the socket is the person, test correct as written): lands after native-core fixes e2e MEDIUM (secret keys out of hub.json); then add an assert that a secret written via settings.write is not in hub.json in the clear, new sha to integrator.
- Reviewed connectors af11226d meta.firstParty: OK (merge after b7bbf5d8). Vault told to read ctx.modules.status().
- Testbox runs on hold until the integrator reports batch 4 (lead).

- Lead: event renames (PLANNED in core/event-catalog) wait until after 0.1.0; lead routes them then, aliases for one release.

- Local, unpushed (waiting for the testbox hold to lift, then one targeted run and push as a finished sha): 9d9354f8 PLANNED renames, 7d548e64 + b5145ee1 Render in polish-cli shapes (flat prompt). Tell polish-cli when pushed.

- RC from platform: work/platform e75a6a11 (402/0/16) + settings-write d62792d0 (on native-core fa349d31; 81/81; hub.json secret test; now runs the check tool like change(); e2e glancing). Both with the integrator.

- vyre module new/check/add DONE a79d58f1 (176/176), sent for the RC. Open: loader reads `replaces` (P1 second half); real local restart inside add not under test.

- SAVE (restart): handed off to the integrator for the RC: work/platform a79d58f1 (vyre module + everything before), settings-write d62792d0 (after native-core fa349d31; e2e glancing at the checked() addition). b4fix 97686e1b landed in b4. Waiting on: e2e ok for d62792d0; integrator's RC report; loader `replaces` + ctx.settings (P1 second half) once native-core is on main; event renames after 0.1.0 (lead routes). No testbox processes running.

## Next
0. After tonight's deploy (lead): end-to-end `vyre update` on a testbox throwaway stack, never /srv/vyre.
1. When native-core says store limits are in and e2e signs off: hand settings.write e4515fb6 to the integrator.
2. P1 once native-core's settings are on main (loader adopts packages/module-sdk/manifest.js, apiVersion, ctx.api/log/paths.data/settings, watches.on + needs.tools, replaces + disable, registry.status commands, core/cli/commands/module.js with polish-cli review).
3. P2 follow-ups: an end-to-end update on testbox against a throwaway stack (not /srv/vyre) with ci's dry-run dist/ as the release; update.available daily check in vyred (update.auto notify); `vyre box update` from the Mac offering the Mac the same version; the systemd rollback race (restore while systemd restarts vyred).
4. Compile phase: tests and polish for P0/P2; merge first-module.md with writing-a-module.md later (ADR 0033 Section 7).

## Needs from others
- ci: release.yml on work/ci 4b49ecf5. APK asset is android-<version>-<sha7>.apk and android.json's `file` is rewritten to match. Dry run only until repo variable VYRE_RELEASES=go. Its dist/ artifact is the P2 test fixture shape; waiting on the dry-run result.
- (decided) first tag 0.1.0 after the native-core milestone; Cloudflare token for the mirror asked at 0.1.0. Both recorded as open in ADR 0033.
- mobile (answered, work/mobile cb4e988c): android.json {version, versionCode, sha, sha256 (unsigned), size, minSdk>=24, built, file}; tool `releases.sign {}` (callers cli/local/module, idempotent, errors no_release/release_mismatch); folder config releases.android default <home>/releases/android/, APK first then android.json atomically last; signed copies never deleted. P2 wrapper: host fetch+check, compose cp in, keep android.json.prev, `vyre call releases.sign` in the container.
- polish-cli: reviews core/cli/commands/module.js and update.js (module.js gets aliases ["modules"], remove `modules` from daemon.js, add both to GROUPS). They write the P4 does.commands dispatcher; wants the shape { verb, tool, summary, args? }.
- integrator: "open" for testbox, then P0 into batch 4.
- native-core: a way for modules' manifest `settings` to join the registry (registry reads `modules.list` manifests, or a `settings.register` internal tool), and `ctx.settings` scoped to the module's own keys.
- sessions: `does.providers` shape stays as on work/sessions; `does.hooks` (brief/enrich/pretool/stop) placement vs the SDK driver's canUseTool.
- polish-cli: `vyre module ...` and `vyre update` verbs next to `vyre config`.
- app-design, pwa: the slot grammar (view, settings, now, renderer, slash) and the sandboxed iframe for third-party UI.
- ci: `lib/*` as shared pure code in the boundary test; a tag-triggered release workflow.

## Changed contracts
- New: packages/module-sdk/manifest.schema.json is the manifest contract. test/module-sdk.test.js fails on any module.json key not in it (x- keys are free). Teams adding a manifest key add it to the schema and index.d.ts in the same commit.

- 30 Sep resume: 12a09627 is green on CI (node, box-image) and its sha went to the integrator. Fail closed for reviewer-2: insideClaude flags an incomplete chain `unreadable` (docker exec, a process whose parent is itself, stays unknown), above() takes unreadable as a model's; empty-read test in peer-race. peer + peer-race 26/26, 3 repeats clean. Next: lock.js matches the real vyred identity.
- lock.js: holds() now uses isVyred (node on daemon/main.js, or `vyre daemon`), not /vyre/ anywhere in the command line; lock tests use a child running a real daemon/main.js, plus a negative case. lock+main tests 5/5. Fail-closed commit b10191d5; lock commit follows. CI not yet run (push when the lead opens it).
- reviewer-2 follow-up: an unreadable answer is a model's for the call but never kept for the connection (asTaken definite excludes unreadable); tests for the cache and for a named server keeping its label. peer+peer-race 27/27 x2.
- Forger under load (30 Sep): root cause found by logging every non-model answer over a 300-run loop with 8 busy loops: all 65 had pid == vyred's own pid on a destroyed socket. readPeerPid captured the fd number once and retried later with it; after a forger closed, the number was another descriptor (the helper's own stdout socketpair) so the "peer" was vyred. Fix: fd read per attempt, no helper on a destroyed socket, answer dropped if the socket closed meanwhile. Regression test in peer-race (fails without the fix).
- reviewer-2 defence in depth: above() refuses a peer pid == process.pid unless deps.self (in-process seam). Not the parent-is-self clause: tests host vyred in the test process and spawn person clients, and in production vyred's own children are models anyway. peer/peer-race/daemon tests 54/54 (+1).
- 2nd forger fail-open: zombie forger/fake claude have args (node) (ps) or empty (proc): walk read 'no claude above' (found via chain log in the loop; failed by run 3-4). insideClaude now takes such a chain as unreadable (model). Test added. Also daemonctl.stop waits for the pid to exit (upgrade.test node 22 in drive CI: new vyred saw the old one's lock). Clean 250x pending on this commit.
- Positive proof of the person built (30 Sep, reviewer-2's four changes): readable/uid/start-order chain, agent-host deny list, anchors = trusted login or strict shared ancestor of a terminal-started vyred; reaching vyred or its child = model; ps/proc rows carry uid+start; VYRE_TEST_HOSTED for tests hosting vyred. Tests: peer, peer-race. Needs full CI + peer-stress on Linux and macOS runners.
- Person surfaces (30 Sep): root allowed anywhere in a chain (login and sshd priv sit mid-chain; my first cut refused them, a Terminal.app regression caught before landing). Tests: Terminal.app (darwin) and console login = person; iTerm, ssh to a Mac server = named server (proven once, as before); Capsule.app itself = person via pinned cdhash (checked before the walk answer), other label or other binary = model. Deck via browser/relay, Windows app, phones: not through this check (route() runs asTaken only on the unix-socket server; network listeners set policy.caller from device identity).
- reviewer-2 F2: hosting is setPeerHosting() (helpers call it); env fallback only under NODE_TEST_CONTEXT with a live non-init/launchd/systemd parent. Login anchor: a root-owned /usr/bin/login link ends the chain as the person (iTerm2 like Terminal.app). Capsule cdhash applied to the top for a vyre child it spawned. Root allowed anywhere (reviewer-2 accepted over the narrower tail rule). Tests: peer, peer-race 33/33.
- F3 (reviewer-2, forgeable login on macOS): LOGIN_PATHS empty on darwin; only the SIP Terminal binary tops a chain there; iTerm2 = named server on macOS, person on Linux via root login. F2b: env hosting fallback only over a home that is not ~/.vyre. Tests: forged login mid-chain and as a top (darwin), peerHosting home cases. peer + peer-race 33/33.
- CI on 14bf629a: mobile world failed (its world seeds through a child of vyred, now a model's: worlds call setPeerHosting(true)), docs-check/terms failed (generated reference stale for the new env var: regenerated, VYRE_TEST_HOSTED described); hands-chrome is not ours. Local 250x on 14bf629a: 250/250 clean.
- # tag mechanism built locally (unpushed): manifest field + checks + registry (one provider per kind, status rows, CALL_AS mentions replays the asking person to provider search tools only) + core/mentions (kinds, search, resolve) + tests 5/5 + docs/MODULES.md. Provider resolve tools must be reach modules and accept only module:mentions; amendment posted in CHAT.
- Capsule view contract built locally (steps 1 and 2 of Part 2): capsule-view.js checker, core/capsule (frames, views), tools folded into local/capsule as capsule.commands/view/act (a module named capsule already exists there), registry capsuleMayCall + CALL_AS, docs. Tests: core/capsule/capsule.test.js (7). Open: hub Tools command (11), install consent card (12), settings overrides for alias/hotkey/enabled (native-core), the asked-send handshake in the Gate (vault).
