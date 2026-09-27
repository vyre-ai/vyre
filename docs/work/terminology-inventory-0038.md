# "box" inventory for the 0.1.1 rename (ADR 0038)

Code only; docs/ is already swept (docs 125a0f54, d3b95fbe). Grouped by owning team, for the lead
to hand out. Config enum values (`role: "box"`) and machine-readable error codes stay per the ADR.

## Integrator (install/pairing CLI, ADR 0008)
- `core/cli/ending.js:16,18`, `core/cli/ssh.js:173`, `core/cli/index.js:41,48`
- `core/cli/commands/box.js` (~30 sites): usage strings, help prose, the subcommand name itself
- `core/cli/commands/up.js` (~15), `commands/phone.js` (~10), `commands/doctor.js:245,260`,
  `commands/link.js:66-80`, `commands/update.js:156`, `commands/assistant.js:47,80`,
  `commands/relay.js:78`, `commands/send.js:19`
- Open question: does `vyre box <sub>` itself become `vyre server <sub>` with an alias, per
  ADR 0038's migration section? That's a bigger call than the prose fixes; decide separately.

## box-deploy
- `core/cli/commands/projects.js:311,317`

## vault
- `core/cli/commands/vault.js:749,1380,1383`, `deck/views/vault-item.js:130`,
  `deck/vault/model.js:134`, `deck/views/vault-places.js:178`, `deck/views/vault.js:190,378`

## Unclear owner, ask the lead
- `core/link/mac.js` (~20), `core/link/box.js` (~10), `core/link/transport.js:110-174` (e2e or
  tailnet?), `core/daemon/index.js:329`
- `core/statusline/index.js:31` (`"box ok"`/`"box away"`, native-core or cohesion?)

## memory-iq
- No user-facing "box" strings found in core/recall/.

## polish-surfaces (deck/ views, onboard, glass, settings, chat — verify the polish-cli split)
- `deck/manifest.webmanifest:5` (PWA install description, highest visibility, appears in OS UI)
- `deck/onboard/onboard.js` (~8), `deck/onboard/device/device.js:96`, `deck/js/first-passkey.js:22,25`,
  `deck/js/pair-steps.js:51`, `deck/js/pair.js:122`, `deck/views/settings.js` (~15),
  `deck/views/connections.js:615,741`, `deck/glass/*.js` (~20), `deck/views/find.js:234,371,497`,
  `deck/views/pair.js:26`, `deck/js/api.js` (5 sites), `deck/js/health.js:89`, `deck/js/app.js:489`,
  `deck/js/lock.js` (5 sites), `deck/person/signin/signin.js:50`
- Chat (polish-cli?): `deck/chat/composer.js:443,479`, `deck/chat/index.js:74,207`,
  `deck/chat/folders.js:196,200`, `deck/chat/term.js` (~8), `deck/chat/newsession.js:44,171`,
  `deck/chat/need-rows.js:312`, `need-sheet.js:52,55`

## mobile (apps/ — iOS, Android, React Native)
- RN: `apps/app/app/pair.tsx`, `settings.tsx`, `places.tsx`, `settings/autofill.tsx`,
  `vault/index.tsx`, `src/ui/NotifyBar.tsx`, `SignInBar.tsx`, `src/auth/person.native.ts`,
  `person.ts`, `src/state/vault.ts`, `devices.ts`, `src/api/client.ts`
- iOS (~20 across FirstRunView, SettingsView, VaultView, FilesView, FindView, Common, ChatView,
  Client.swift, SignIn.swift, Push.swift, Needs.swift, VyreApp.swift)
- Android (~15 mirroring iOS: FirstRun.kt, Settings.kt, Vault.kt, Find.kt, Root.kt, Now.kt,
  Files.kt, Agents.kt, ApiError.kt, Client.kt, PushRegistration.kt)

## Notes
- Don't touch the literal route/command strings (`vyre.run/box/vyre.tgz`, `vyre box add`) until
  the CLI subcommand-rename question above is decided; they're routes, not prose.
- site/ already reviewed separately with launch (see docs/work/docs.md).
