# dialog-fix

Scope: stop Vyre dialogs and login-keychain writes from anything but the real `~/.vyre`, and clean
the leftovers from the user's login keychain.

## Done

- Cause: dev worlds, demos and stress runs start a real vyred on a temp `VYRE_HOME` outside
  `node --test`. The vault's guard (`guarded`) only looked at `NODE_TEST_CONTEXT`, so a home with no
  `vault.keystore` used the login keychain on macOS (built the keychain helper, wrote items).
  Seen live: `deck/test/world.js` earlier today and polish-cli's `scripts/stress-drive` home
  (log: "vault key created in the keychain keystore").
- Root fix: `core/config/dialogs.js` gains `realHome()` / `isRealHome()`; `dialogsAllowed()` is false
  for any other `VYRE_HOME`. `Vault` picks the file keystore for any other home unless config says
  `vault.keychain: true`; an explicit `keystore: "keychain"` there is refused. `keys.js`
  `keystore()` / `secretKeyStore()` take `login` and refuse the login keychain without it.
  `vyre up` on a real Mac install writes `vault.keychain: true`.
- Scripts: world.js, vault-shots.js, vyred-present.js, release-check.sh set `VYRE_NO_DIALOGS=1` and
  the file keystore.
- Keychain: 32 `vyre-vault` items deleted from the login keychain, no prompt. Accounts listed in the
  session scratchpad `keychain-cleanup.txt`.

## Changed contracts

- `config.vault.keychain` may now be `true` (opt in to the login keychain) as well as a keychain file.
- `keystore({ login })`, `secretKeyStore({ login })`: new option, default false.
- `dialogsAllowed(env)`: also false for a non-real `VYRE_HOME`.

## Needs from others

- polish-cli: `scripts/stress-drive` (not on main yet) should write `vault: { keystore: "file" }` and
  set `VYRE_NO_DIALOGS=1`; after this merge it gets the file keystore anyway.
