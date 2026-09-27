# vault-next

Branch: work/vault-next · Worktree: ../vyre-vault-next · ADR: 0028 (docs/adr/0028-vault-everywhere.md)

## Scope

Import on day one (preview, duplicates by content, Apple Passwords), agent logins (one agent,
one login, one origin, a log of every use), rotation reminders through the planner, and autofill
on every device through the OS's own autofill UI (iOS, Android, Mac, browsers, agent computers).
Owns core/vault/ changes for these, modules/vault-extension/, and the autofill extension code on
mobile and the Capsule (through their owners).

## Done

- ADR 0028 written (proposed), in nav.json. Number claimed in docs/work/README.md.
- Import preview with a file-bound token, duplicates by origin+username, Apple Passwords (782ab9d).
- Agent grants + vault.uses log, the 30-min fill window, Firefox extension build (WIP commit at
  resume after logout 3; tests green).
- Step 1, .env import: core/vault/detect.js (types + ~40 providers, fixed words only),
  core/vault/envfiles.js (spans, item names, folder scan, rewrite, git state). A .env file is one
  env-set; only secrets move; folder scan; `rewrite` to vault:// refs; CLI `--rewrite` + per-file
  preview. Tests: detect.test.js, env-import.test.js. vault + CLI suites on testbox: 264 pass, 0 fail.

- Step 2: `vyre run -- cmd` (core/cli/commands/run.js): reads ./.env refs when nothing is named.
  No vault.env.resolve needed: sessions already reads claude-setup-token / anthropic-api-key through
  a module grant (ctx.vault.fetch). Told sessions; asked whether owned sessions' Bash should resolve
  project refs (my default: no).

- Step 3 typed credentials (core/vault/kinds.js, details column, Watchtower expired/expiring,
  passkey never released, CLI put flags). kinds.test.js 4/4; the full vault suite rerun is pending
  (testbox load was 16 from other teams).

## Doing

- Step 3 verification: rerun core/vault + core/cli suites when testbox load < 8.
- Step 4 import sources (subagent: parsers in core/vault/import-more.js).

## Next (the approved order, sizes sent to the lead 2026-09-27)

4. Import sources (L): LastPass, Dashlane, Keeper, NordPass, Proton Pass, Enpass, KeePass XML/CSV,
   Edge/Brave/Arc, Firefox. KDBX4 later (box is Node 22, no argon2).
5. Google Authenticator migration QR (multi-part) + otpauth (M); the client decodes the image.
6. vault.codes: current + next + remaining (S).
7. Leak sweep + rotation (L): auto for AWS, GCP SA, Cloudflare, Twilio, GitLab, Tailscale; guided
   otherwise; ADR 0028 decision 4 reminders.
8. `vyre vault ssh setup` (S). 9. vault.agent.fill (M, needs computers). 10. Passkeys (L).
11. Cards + addresses (M). 12. Emergency access (M). 13. Autofill: extension, Android service,
   Glass, simulator-only iOS/macOS providers (L).

## Needs from others

- mobile: confirm ADR 0018 (native Swift + Kotlin) or the Expo "0027" the lead named; an app
  group / keychain access group for a VyreAutofill extension target.
- computers (glass-live?): computers.fill.begin/end (internal), Chrome under its own uid, ptrace
  blocked, closing agent CDP websockets on begin.
- capsule-pro: a credential provider extension target in the Capsule app (after Apple team).
- planner: planner.add from module:vault (already allowed), planner.done on items it added.
- polish-cli: CLI keeps a fresh proof per call; fills never ride a CLI window.
- pwa: Deck import sheet (preview), Grants place and "Used by" rows.
- user: a paid Apple Developer team (NOT approved for now: iOS/macOS providers stay simulator + CI).
- lead: refs stay vault://item/field; accept vyre://vault/... as an alias? Who builds the Deck/phone vault board (Direction A): pwa + mobile, or vault-next?

## Changed contracts

- vault.import on a .env file now makes ONE env-set (named after the file's path), holding only
  secrets, instead of one secret per variable. vault.import/preview take a folder and `rewrite`.
