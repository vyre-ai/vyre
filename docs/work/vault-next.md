# vault-next

Branch: work/vault-next · Worktree: ../vyre-vault-next · ADR: 0028 (docs/adr/0028-vault-everywhere.md)

## Scope

Import on day one (preview, duplicates by content, Apple Passwords), agent logins (one agent,
one login, one origin, a log of every use), rotation reminders through the planner, and autofill
on every device through the OS's own autofill UI (iOS, Android, Mac, browsers, agent computers).
Owns core/vault/ changes for these, modules/vault-extension/, and the autofill extension code on
mobile and the Capsule (through their owners).

## Done

- ADR 0028 written (proposed). Number claimed in docs/work/README.md.

## Doing

- Waiting on the lead's reply to the ADR summary; starting import (ADR 0028 decision 1).

## Next

1. Import: vault.import.preview with a file-bound token, duplicates by origin+username, conflicts
   skip|update, renames, apple-csv, CLI --preview.
2. Agent grants: vault_agent_grants, vault.agent.grant/grants/revoke, vault.uses.
3. Rotation reminders via planner.add (daily, dedup in vault_marks).
4. Fill window 30 min from proof; Firefox build of the extension.
5. vault.agent.fill with computers.fill.begin/end.
6. Android, iOS, macOS providers (GitHub Actions builds).

## Needs from others

- mobile: confirm ADR 0018 (native Swift + Kotlin) or the Expo "0027" the lead named; an app
  group / keychain access group for a VyreAutofill extension target.
- computers (glass-live?): computers.fill.begin/end (internal), Chrome under its own uid, ptrace
  blocked, closing agent CDP websockets on begin.
- capsule-pro: a credential provider extension target in the Capsule app (after Apple team).
- planner: planner.add from module:vault (already allowed), planner.done on items it added.
- polish-cli: CLI keeps a fresh proof per call; fills never ride a CLI window.
- pwa: Deck import sheet (preview), Grants place and "Used by" rows.
- user: a paid Apple Developer team for the AutoFill Credential Provider entitlement (iOS, macOS).

## Changed contracts

- (none yet)
