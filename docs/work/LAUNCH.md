# launch

Branch: work/launch-onboard-fix · Worktree: ../vyre-launch · Plan: team/0.2/plans/launch.md

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
