# launch

Branch: work/launch-onboard-fix · Worktree: ../vyre-launch · Plan: team/0.2/plans/launch.md

## Scope

Install, onboarding, updates, uninstall, export, import from other agents (team/0.2/CHARTER.md's
Ownership table). Works closely with tailnet, integrator, app-design, e2e2. Phase 1 (planning) is
done and folded into team/0.2/PLAN.md; this file tracks phase 2 (the actual build), started on the
lead's 0.2 BUILD GO.

## Done

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

- Nothing in progress; picking the next item below.

## Next

1. Install script v2's own build (VYRE_CODE env var never argv, the ghcr digest+cosign pull, the
   0.1.1 detection/migration step, R6/R7 from the plan) — this is `scripts/install-box.sh` v2 and
   is NOT gated on tailnet's setup-session design landing first; it can start now.
2. The setup-session client side (page key made and its fingerprint embedded in the code before
   the install line shows, C9/N1) once tailnet's relay-side primitive is far enough along to test
   against; watch CHAT.md for tailnet's own "Done" post.
3. `vyre uninstall`, unified across the systemd path and install-box.sh's own `--uninstall`/`--purge`.
4. Import readers (Claude Code first, reusing Recall's transcript parser if the spike confirms it
   fits; Codex and Gemini CLI from scratch), with iq per the plan's step 12/13.

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
