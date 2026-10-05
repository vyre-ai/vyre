# launch

Branch: work/launch-onboard-fix · Worktree: ../vyre-launch · Plan: team/0.2/plans/launch.md

## 0.3 resume (launch, 4 Oct 2026, work/launch-03)

Done and pushed (sha d72038399 or earlier): env fix (VYRE_KERNEL and VYRE_STORE kept across a root-run update, compose kernel "1", packaged-boot update step, green on b9594691); appbuild.json now fetched by the installer and updater (was a 503 on /app/); SH-4 and SH-5; system.build and the counter and tree in appbuild.json (MW-5 daemon half; sw.js and the manifest are not signed, said in CHAT); path-triggered Mac and phone workflows (2295cc79a); installer closing line names the space (wink.server.pairing `paired` and `owner`); publish-fill verb with four tests; update-refusals candidate version fixed.
Real-box run on testbox4 DONE and reported in CHAT (4 Oct 01:55 UTC): RH-3, RH-7, SH-4 pass on a real packaged install with a real Twenty store; the box is free. It found that `vyre uninstall` left the helper units (fixed, test). CI: packaged-boot and box-image green on d72038399; update-refusals J2b failed on the install (`vyre up` raced the module start, fixed in 2a46c3660, waiting for its run); node on 2a46c3660 pending.
Open: the L-2 (c) reading is unclear (kernel/modules/rollback-presence.test.js covers no proof, other counter, other act, tampered, non-owner key, stranger, replay; it lacks a malformed or oversized proof header, which is the daemon header path); the onboard label item (core/onboard/index.js line 282 derives `mode` from a label, platform-2 FROZEN count 1, display only); node and docs reds on the branch are docs/work/chat.md rendering (chat's file, not mine); a "failed step leaves no space" is the device side (setup page), the server side creates nothing.

Open gap (4 Oct): the host `vyre <cmd>` execs as the vyre user (a plain terminal caller, never caller_unknown), but a person-only read on a packaged box needs a signed-in terminal (`vyre signin`) or a device. The proofs cannot assert that a call after `vyre signin` runs: a CI server has no owner and platform-3 knows no release-build path to a software-key owner. The rc-update proof therefore checks records at the home's database files when the read is refused. First real install should show whether terminalOf signs in for an exec call; if not, send the log to platform-3.

NEXT (4 Oct, stopped on usage): read the hosted rc-update and packaged-boot runs on the last pushed head (each runs twice: release and dev-owned). Dev-owned rc-update needs: stand-in owner (dev-presence-stand-in) read through docker exec (if refused, fix first), memory.me and memory.remember through the product, then step 5 (dev-enrol-software-key, vyre signin with a signed proof via scripts/packaged-probes/signin-approve.mjs, a person-only call after it); unknown: whether terminalOf gives a login key to a docker-exec process (send the log to platform-3). Dev-owned packaged-boot runs runner's sealed-turn and sessions' kill-and-resume blocks: none has run on a hosted box yet. Then the reds from run 37207177850: core/cli/commands/agents, core/hooks/hooks, core/cli/screen/screen-live, test/chrome-flags, test/onboard-page, test/within-hygiene (stdin-hygiene fixed, phone passed on my head). Release run known test red: test/install-box-v2 "vyre uninstall ... wrapper goes" fails on testbox on a clean head too. sessions: empty tmp of the vyre-sessions volume at start (their recover()).

Results on ac27258b1 (runs 37210479869 packaged-boot, 37210479910 rc-update): packaged-boot release PASSED (first green: anchor-reset, probes, tamper). packaged-boot dev-owned FAILED at the sealed-turn block: `chmod: cannot access '/home/vyre/fake-claude.mjs': Permission denied` (root in the container has no DAC_OVERRIDE and the home is vyre-owned 0700: copy the fake to /tmp, then `docker exec -u 1000` cp and chmod it into the home). rc-update: both runs failed in step 2, one with "the box never started its modules by itself after the update" (dev-owned: check the daemon log, the dev-kind candidate may fail its module list or the first-update finishing path) and one with "the data written before the update is gone" (likely a proof bug: `docker exec vyre-vyre-1 cat /home/vyre/.vyre/rc-marker` runs as root and cannot read the vyre-owned home; use -u 1000, same for the step 3 marker check). Job order inside each run was not matched to the two kinds.

## Scope

Install, onboarding, updates, uninstall, export, import from other agents (team/0.2/CHARTER.md's
Ownership table). Works closely with tailnet, integrator, app-design, e2e2. Phase 1 (planning) is
done and folded into team/0.2/PLAN.md; this file tracks phase 2 (the actual build), started on the
lead's 0.2 BUILD GO.

## Done

- Step 13: Codex and Gemini CLI import readers (`core/import/formats/`), converting to Claude Code's shape; allowlisted paths,
  no symlinks, credential files never opened (tests plant them). import.scan tags each source by agent.

- R8 (export encryption, BLOCKER 3 in reviewer's red-team): `vyre backup`/`vyre restore`
  (`core/names/backup.js`, `core/cli/commands/up.js`) always seal the file under a passphrase now.
  New `core/names/seal.js`: passphrase sealing over raw bytes (scrypt N=2^17 r=8 p=1, AES-256-GCM,
  same shape as `core/vault/backup.js`'s own seal, kept as a separate small module rather than an
  import, since core/names -> core/vault is not a frozen boundary edge). `vyre backup` prompts
  twice, hidden, on a real terminal; reads one line from stdin when piped (scripted/e2e2 use).
  Provider sign-ins (`claude-setup-token`, `anthropic-api-key`, hardcoded locally, see "Needs from
  others" below) are excluded from the vault items a backup carries by default, both the
  `vault_items` row and its sealed file under `vault/items/`; `--with-provider-logins` opts back in.
  `vyre update`'s own internal pre-update backup and its automatic (and later, manual
  `--rollback --restore-data`) restore stay fully unattended: a random passphrase is generated per
  update run and kept beside the backup file as `<file>.key` (0600, same root-owned trust boundary
  as the rest of `<home>`), never surfaced to the person. `core/cli/commands/update.js` updated at
  all three call sites. Tests: `core/names/seal.test.js` (new, 7/7), `core/names/backup.test.js`
  (rewritten for the sealed format + the exclusion behavior, 12/12), `core/cli/commands/up-verbs.test.js`
  (passphrase piped through the child-process harness, 6/6), `core/cli/commands/update.test.js`
  (14/14, unchanged behavior asserted), `core/settings/hub.test.js` (1-line fix, 17/17),
  `test/boundaries.test.js` (58/58 total across this run; the new `seal.js` file is re-exported
  through `backup.js` instead of imported directly from up.js, so no new boundary file was needed).
  CHANGELOG.md entry added.
- N1 (reviewer's last blocker) and the tailnet fingerprint-in-code redesign, R6 (0.1.1 detection),
  R7 (digest+cosign pulls) and M1 (Mac boot path never as root before vyre-core) are answered in
  team/0.2/plans/launch.md's Review response; posted to CHAT.md and confirmed with cohesion-2/lead.
  No product code yet for these (N1/R6/R7/M1 are the SETUP SESSION and INSTALL SCRIPT v2 pieces,
  next below); this session's code work started with R8 since it had no dependency on tailnet's
  still-settling setup-session design.

## Doing

- Update button (R2h reopened 30 Sep): root path unit + request file + signed-release check + status file + card + setting, built and tested against a fake docker; proved on the test box's real systemd 30 Sep in a throwaway dir with a fake docker (signed release ok, other uid refused, link request dropped, unsigned refused; unit removed after); real Docker and the real image were not exercised and no release carries SHA256SUMS.sig yet: integrator must sign SHA256SUMS in release.yml with VYRE_RELEASE_SIGNING_KEY (base64 Ed25519 over the exact bytes) or automatic and button updates refuse every release. Also .import-stage hardening (reviewer-2 LOW).
- Charter minimums built on this branch (30 Sep): update module + Settings card (146acc9b), export with transcripts + Export/Uninstall cards (f6155797), uninstall removes images (4709f0cd), import end to end + three import faults fixed (9f220f5c). Open: real update button (needs the lead's call on R2h), Mac-side uninstall/export surfaces (capsule-pro's shell), rebase after tailnet-02.
- Update: core/update (update.status, update.check, update.available) and Settings' Update card are built and tested; the card SHOWS the command per R2h. Waiting on the lead about a real button (would need a host-side path unit and R2h reopened). Next: uninstall, export, import end to end.
- Own-domain naming: built in the setup page (flow.checkDomain, ui domain region), tested against a fake names.domain.check; not yet run against the real tool (tailnet-02). The box only checks DNS today; serving the domain is names' work. onboard test fixes are in 4a06eb43.
- Arrive-and-claim is built on tailnet's cc103f19 contract (dd21305c page + link, 705f31c9 fragment and passkey page with the claim grant, rp_id = the address the box answers). onboard.finish now calls relay.setup.end (module:onboard), so the session lives through the phone's claim after the computer's; untested against the real tool until tailnet-02 is on stage (3 onboard tests already fail on this base, same 3 without my change). Waiting on tailnet-02 for the rebase (drop cfd95c2b, box.test.js to the boot path), then own-domain naming.
- Setup page now goes found (words confirmed) -> named (recovery code saved) -> AI sign-in -> Tailscale. Still to build: devices/Wink, arrive and claim (relay.setup.end at the claim), land + cards, own-domain naming, Mac-as-server. After tailnet-02 lands on stage/0.2: rebase this branch onto stage, drop merge cfd95c2b, fix box.test.js to start setup through the boot path (relay.setup.begin is module:onboard/launch only in e426a549), and rerun setup-handoff.
- Setup page slices 1 and 2 (start, install with streamed progress, found with check words, open the setup channel, choose and claim the address, recovery code shown once) are built in site/setup. Next: the Tailscale step (names.connect and network.tailscale.* over the channel, reachability probe), AI sign-in (sessions' tool, open), devices/Wink, arrive and claim. Own-domain naming (names.domain.check) and the Mac-as-server choice are not in yet.
- Export v2 (project files by default, streamed, resumable, size up front, --skip-projects) built; see CHANGELOG. Open: a Mac has no /work, so its project folders need teammates/projects to name them (pass --work DIR for now); a Settings toggle for the skip flag belongs to the Settings card (step 10).
- Reviewer-2's HOLD and 4 MEDIUMs on fbff6d47/fc2723cf fixed; awaiting recheck.
- Install script v2 core is built and tested (10 new tests, look tests green): see the CHANGELOG entry.
  Still open in it: the terminal's own check code (B3) waits for tailnet's definition of the check
  code; the Mac path and Windows are anywhere's and windows' scripts.

## Next

1. (DONE fc2723cf) Install script v2's own build (VYRE_CODE env var never argv, the ghcr digest+cosign pull, the
   0.1.1 detection/migration step, R6/R7 from the plan) — this is `scripts/install-box.sh` v2 and
   is NOT gated on tailnet's setup-session design landing first; it can start now.
2. The setup-session client side (page key made and its fingerprint embedded in the code before
   the install line shows, C9/N1) once tailnet's relay-side primitive is far enough along to test
   against; watch CHAT.md for tailnet's own "Done" post.
3. (DONE, box side: `vyre uninstall` in box/vyre; app-side device revoke waits on windows/capsule-pro/pwa shells) `vyre uninstall`, unified across the systemd path and install-box.sh's own `--uninstall`/`--purge`.
4. (DONE, step 13 readers: Codex and Gemini CLI in core/import/formats, see CHANGELOG) Still open: an
   in-app picker copy for the new sources, and re-verifying the on-disk formats against a real Codex and Gemini
   install (checked against upstream source only), with iq per the plan's step 12.

## Needs from others

- sessions: `core/sessions/config.js`'s `CREDENTIALS` map is the single source for which vault
  item names are a provider sign-in; `core/names/backup.js`'s `PROVIDER_LOGIN_NAMES()` duplicates
  those two names by hand today (`claude-setup-token`, `anthropic-api-key`) because
  core/names -> core/sessions is not a frozen boundary edge (test/boundaries.test.js) and a new
  edge needs the lead's OK. A new provider (Codex, Grok) needs its vault item name added in BOTH
  places by hand until there is a shared kernel-level list. Flagged in CHAT.md.
- tailnet: the setup-session relay primitive and its C9 fingerprint-in-code handshake (CHAT.md
  02:11 on), before launch's client side of it can be built for real rather than against fixtures.
- anywhere: vyre-core's own phase for an unprivileged socket (M1), before the Mac box install path
  can truthfully offer "starts at boot with no login" rather than the "sign in first" fallback.

## Changed contracts

- Setup code handoff: install-box.sh writes `VYRE_SETUP_CODE=<43 chars>` into `$VYRE_DIR/vyre.env`
  (0600, already the vyre service's optional env_file, so no compose change). tailnet: vyred reads it at
  first start, and after the claim (or expiry) something must clear that line (proposal: `vyre` removes it
  on `relay.setup.end`). launch will not invent the check-code derivation; tailnet defines it.
- release.json's `images.box.ref` and `images.computer.ref` (integrator's release.yml) are now READ by
  the installer and must stay `ghcr.io/vyre-ai/<name>@sha256:<64 hex>` and also appear in the released compose.yml.

- `vyre backup`/`vyre restore` (up.js) and the library functions in `core/names/backup.js` now
  REQUIRE a `passphrase`; any caller not already updated in this commit will start throwing
  "a backup passphrase needs at least 12 characters". Checked: `core/cli/commands/update.js` (the
  only other in-repo caller) is updated. `core/cli/commands/box.js`'s own, unrelated `backup`
  (managing a REMOTE box's docker volumes over ssh from a Mac, `vyre box <name> backup`) is a
  separate mechanism entirely, does not call `core/names/backup.js`, and is NOT sealed under a
  passphrase, still plaintext-equivalent on disk (its own "keep it private: it holds your vault"
  comment is the only warning). That looks like the same BLOCKER-3 shape as R8, on a different
  surface; flagging it in CHAT.md rather than fixing it here since it's a different command
  (`box.js`, plausibly anywhere/capsule-pro's territory for Mac-to-box management) outside what
  cohesion-2's list asked launch to fix.
- New file `core/names/seal.js`, re-exported (`inspect`) through `core/names/backup.js` so no new
  entry in test/boundaries.test.js's ALLOW list was needed for up.js's import of it.

- integrator: `vyre uninstall` finds volumes by label run.vyre=1; the new vyre-accounts volume must carry it in compose.yml.

## v0.2.3 landings on work/rc-0.2.2 (launch, 2 Oct 2026)

Order of value; a branch lands only when its own head is green on hosted node and box-image. Never force-push the rc.

- Landed: glass-files 8ada13b9a, eval-guard 147ccdefe (also capsule-mac green), git-hooks 7a3a173f2, pwa-copy2 94c09abb5, 032-continue-here 2a310a945, 023-companion e448cd652 (not usable until a transport exists), eval-world 96c00ecf5, 023-app-relay-check 7fa12e885, paired-ask a7b1f5f9f (AgentDrive.swift conflict resolved by keeping both command blocks; the rc's capsule-mac run is the compile proof), lumen-import 5aeb18d52 (one-line delta over the earlier import), 023-relay-lows 157038706 (module.json for link and relay merged by hand: companion and pairing-window tools and events both kept; replaces pair-limit and device-names). Docs, reach and boundaries tests green on testbox for the merge.
- Waiting: paired-ask a7b1f5f9 (capsule-mac run 36966388152), 023-relay-lows 157038706 (replaces pair-limit and device-names), 023-app-relay-check 7fa12e885, lumen-import 5aeb18d52 (relay.test flake, re-run), app-feel 65338e16f (stale docs+terms, owner fixing), 011-setup pair (assistant moves the step list to a kernel folder, no boundary exception).
- Red, owners notified in team/0.2/CHAT.md: parallel-tabs a4081aae2 (reach-computed-calls reviewed list), strings b639c64d9 (box error-text internal-word count). chrome-standalone dispatched on parallel-tabs, run 36966395049.
- Not started: pwa-copy2, iq eval-world, e2e2 J1, 023-shell.
- Landed later: app-feel's 10 own commits cherry-picked (0d8a2edd1 carried a main merge, scripts/gen-og.sh and site files, so none of it came along; its node red was the phone add flake and the Chrome keychain-flag test on those main-only files), #11 011-setup-steps 74c319762 then 011-setup 1c34efdd3 (onboard/index.js: person-only name from steps, the rc's #50 held-address test kept).
- Waiting: assistant #41 0aff81ebc, pwa-fingerprint 9c3416645 (replaces pwa-window), then parallel-tabs, strings, 023-shell, e2e2 J1.
- Landed later still: pwa-expo-wait 31e680a6d, parallel-tabs 29b012841, strings 727a69182, fix-20-api-keys ed0964f5a (#20, #56), and a rc-side fix: artifacts.media.gallery and artifacts.media.usage declare projectArg (the rc's project-arg test was red). site/setup merge of #11 and #20 keeps both; the API-key flow test follows the new step order.
- Held: fetchsite 713304663 (reviewer-2 delta check), e2e2-harness cherry-picks, assistant #41 and the surface-name fix (arrive with the stage merge after v0.2.2), pwa-fingerprint, wink-deploy, the Lumen four (deep-glass, at-icons, mac-app, mac-release), 023-shell.
- Merged stage-0.2 at v0.2.2 (12b601daa) into the rc: #38, #40, #42, #39 and the surface-name fix now ride on it. core/sessions accounts.js/index.js: the endpoint columns (#20) and the one-account-default rule (#42) both kept.
- Landed: #41 as its 2 own commits (1caa6bceb, 0aff81ebc cherry-picked: the branch carried main-only files), fetchsite f4a267443 (artifact-sandbox green on chrome, safari, ios; reviewer-2 cleared), pwa-fingerprint 4f8d3003d (replaces pwa-window). Open: companion-transport 32be4b04f (node running), Lumen four and wink-deploy and e2e2-harness need the rc merged in (their node reds are the rc project-arg red, fixed on the rc), 023-shell.
- Landed: sessions boundary branches (claude-connectors 059260a77, cx-connectors 9602a0f17, purposes 4a66602c5, taint 12aba79f2; purposes merge keeps continued_from and taint in the thread summary) and e2e2 harness commits 493d3f178, afe330f30, 58a9a747c (node 24 red on f8003291b was only the perf-check probe, #71).
- Landed: deep-glass 2bc8f2791, at-icons 4537c9465, mac-app 0d70cb2c2 (node, capsule-mac, box-image green each), companion-transport fc9ae33a1, installer-signoff 9acbc2604. Waiting: mac-release 8ee5bbe44 (node red), wink-deploy (release-dist and app-boot after the release), 023-shell 4e186b64e (capsule-mac queued, pwa-shots).
- Landed: stage-0.2 793d28ce0 (#67, relay-deploy), mac-release 8ee5bbe44, vault-77-clock 54da0f220 (#77: injectable clock in the vault), 023-shell 4e186b64e (node, box-image, capsule-mac, pwa-shots green; app-boot cancelled by queue cancels). Waiting: wink-deploy df7fc86ae (app-boot), native-android (docs/terms red, vault fixing). rc node 4f54b4208 was red only in windows-socket-acl (the second-user connect was refused as intended; the step then died with exit code -1073741502), job re-run.
- Stopped for now (lead, 2 Oct): rc head after this push is the one in origin/work/rc-0.2.2. win-local-core 7ddf66079 (cleared sha; windows' 68293e609 not taken) merged; its content was already on the rc through companion-transport and wink-deploy df7fc86ae, so the merge only added stage's changes (Workers logs off, #70). capsule-win green on 7ddf66079; node and box-image green.
- Not landed: native-android f943b4e30 (native-android workflow red, app red, capsule-mac still running; vault to look), windows 68293e609 (unreviewed hooks), privacy-page (waits on #69, #70, #72), app-boot on wink-deploy/shell (cancelled each time by queue cancels, never proven).
- rc node on efbf40ec9: windows-socket-acl passed after its re-run; test (24) failed once on core/team/team.test.js "a vyre restart while a request is running fails it ..." (passes on testbox, re-run requested). No v0.2.3-rc.1 cut: the lead starts it with the user.
- Landed launch-matrix-fix (J1 follows the ten-step setup; J2c pins compose.yml via pin-release-compose and B7 uses the pinned line; matrix cosign job has id-token: write; rc-smoke step 8 --allow-unsigned; box/vyre restore_db reads an older release backup without a .key; app-boot is not cancelled on work/rc-*). matrix-j1, matrix-j1-variants and matrix-cosign-refusals green on the fix branch; the full matrix runs on this rc push. Open: mac job (iOS Safari OCR, NSPOSIXErrorDomain 60).

## Mac Twenty through Colima (5 Oct 2026)

Built (700a6e9be on work/launch-mac-twenty, based on work/spaces 50b75b00a): `stores/twenty/mac.js` `macStoreOptions({ home, log })` for `createStoreFor`: docker runs against Colima's socket (DOCKER_HOST, never `docker context use`), the preflight asks `vyre-runtime room N` and says its plain message when the VM is full, a new Space calls `makeRoom(N)` first ("Making room for a new space"), then `provisionSpace` as on a server (same pinned images and compose). Tests: `stores/twenty/mac.test.js` (fake docker plus FakeTwenty, 5/5).

Reaching Twenty from the Mac host (lead's ruling, option (a), 5 Oct): on a Mac only, `provisionSpace({ publish: "loopback", reach: "loopback" })` publishes Twenty on 127.0.0.1 at a random free port (picked at provisioning, kept in `.env` as TWENTY_HOST_PORT and recorded in `<space>/twenty/reach.json` and in the Space's store.json as `host` and `port`, so it survives restarts). One fact changed the shape: Docker cannot publish a port from an internal network, and the Space network is internal on purpose (Twenty gets no outbound). So Twenty's own containers keep the internal network alone and a tiny proxy container (alpine/socat 1.8.0.3, pinned by digest) sits on the internal network plus an ordinary one and carries the loopback port to `server:3000`. Never 0.0.0.0, never on Linux (no `publish`, no proxy, no extra network). Twenty still needs the Space's key on every call. Tests: stores/twenty/mac.test.js (Linux compose has no port; Mac compose binds 127.0.0.1 only; provisioning records the port).

## Status at the 5 Oct stop (launch)

Done and pushed: work/launch-03 (proofs: packaged-boot, rc-update release green; rc-update dev-owned proof fixes, no longer a gate), work/launch-mac-rc c720867b6 (mac-app packaging with version, web build, box-url for prereleases; vyre-runtime Colima sizing and resize; box/vyre image pin; first-run merge; relay origin test), work/launch-mac-twenty 8a65649c4 (Mac Twenty on 127.0.0.1 through a pinned proxy), work/launch-privacy 77a909df3, work/launch-site b03fe237e (network merged with privacy, roadmap, names, known gaps, docs rewrite, Tailscale and Deck and Glass docs removed, ratchet zero in docs/). The release checklist and the claim-gates table are in team/0.3/RELEASE-0.2.9.md.

Open: (1) reviewer-5's HOLD on work/launch-site: docs claims were fixed in b03fe237e, waiting for the re-review; the copy gates in RELEASE-0.2.9.md A2-0 (chats, backup, lending, memory temp_store, push, sizing) wait on other teams' merges. (2) The "Deck" to "the Vyre app" pass on about 30 docs pages waits for web's flip commit deleting deck/ (a watcher was polling origin/work/web, web2, devbox for deck/ to disappear); then add a no-Deck ratchet test like no-tailscale (docs/releases excepted) and check each claim against apps/app. (3) Sizing line changes to "One space runs on a 4 GB server; 8 GB leaves room for more automations. Vyre sizes itself, and checks before adding another space." when windows' small-server profile lands; ground it there. (4) Screenshots (86 stale) are release step C2: regenerate from the real app on a test box after the app merges settle. (5) Not mine: native-core to confirm the native-push gap wording; network to confirm the docs list sent to the lead.

Exact next step: when web's flip commit lands, run the Deck pass; then rebuild the 0.2.9 dmg from the final merged head (mac-app dispatch, version 0.2.9), then C2, then open the stage-to-main PR per RELEASE-0.2.9.md.

## 0.2.9 rulings docs (5 Oct): what is pending in code, never in the pages

Pages: docs/using/spaces.md, private-chats.md, time-zones.md, and "Reply to a message" in chat.md; test/docs-rulings.test.js. Grounded in apps/app on work/app-wire 61b29ddcd (screens/shell/basic.js, settings/PersonalHost.tsx, install/first-run.js, spaces/ZoneSection.tsx, src/time/show.js, src/api/client.ts, src/chat/reply.js, ChatRows.tsx) and, for chat keys, in lib/chat-keys.js and kernel/gateway/chat-sealed.test.js on work/memory-chat3 (8882c9fef, unmerged).

Pending (the page does not claim these): (1) the box side of the Personal backup line (memory.backup.status, memory-042 ac20200f2, unmerged; the app already shows "Backed up, encrypted, to <space>"); (2) chat keys wired in the daemon (memory-chat3 unmerged, reviewer-5 says on hold), so private-chats.md deploys only with it; (3) the AI brief's time line (lib/time timeLine exists but nothing in core calls it on app-wire) and message timestamps in chat showing both clocks (show.js is used by settings, assistants, memory, planner, artifacts, flows, drive; chat messages were not found); (4) the spaces.time-zone.set tool the Home time zone control calls was not found in core on app-wire; (5) the Personal to My Cloud upgrade (core/work/project-move-remote.js on hub-kernel-on) has no page; (6) windows' a94dad661 and 3903d602b: a device install is always Personal, Twenty only on a server install (the spaces page says so in plain words).

Pending from network (work/network 901a83bd4, not in this branch yet): `vyre up` on a server says "not paired yet. Pair this server from your Vyre app: run vyre call wink.server.code '{"qr":true}' here, then scan the QR or paste the long code." or "paired to <space>"; `vyre up --print-link` prints VYRE_PAIRED=<space> or VYRE_PAIR=<command>, never a link (924439443, 3f04ae52a). When that merges, update docs/using/cli.md (the `vyre up` line) and install.md. The install.sh last line no longer says "or open the link above" (bad361ad9), and the Twenty pull bug is fixed (f50498282).

## Draft, not published: "Move to My Cloud" (spaces.md, after the My Cloud section)

Publish only when windows' upgrade merges to devbox (A2-0 gate). Shapes from windows at origin/work/spaces aa1647d3f: spaces.upgrade.plan / spaces.upgrade.run (one proof), screen label "Move to My Cloud". Check each line against the merged build and the app screen first.

> ## Move to My Cloud
>
> When you get a server, a Personal space can move up to My Cloud. You keep your work: records, private chats and memory come with you, and your phones and browsers keep using the same space.
>
> **See the list first.** Vyre shows what will move, how many records of each type, and any fields My Cloud's types gain so your records fit. If something blocks the move, Vyre says what and does not offer the button.
>
> **One approval.** You approve once, and the approval covers exactly the list you saw. If anything changed since, Vyre stops and shows the list again.
>
> **After the move.** Vyre reports what moved. Personal stays readable but takes no new changes; new work goes to My Cloud. Anything that could not come along is named with the reason. Today that is the value of a sealed field: the record moves without it and the report says so.

Open: sealed field values (a bug-class gap until platform's reseal carries them; the page says what the report says, only if Personal types hold sealed fields); chats and memory carry only when their owners' upgrade tools exist (chats.upgrade.*, memory.upgrade.*), so the page claims them only after those merge; the real-Twenty re-run on testbox5 must pass.
