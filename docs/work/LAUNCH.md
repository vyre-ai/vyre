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
