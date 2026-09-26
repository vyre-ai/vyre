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

## Doing

- Paused on the lead's order (Mac load 34): no tests or processes, edits and commits only.

## Next

- Merge by the lead: work/dialog-fix. Fix commit 32780d7; related suites were green before the pause.
- After the merge, every team rebases so its deck/test/world.js carries VYRE_NO_DIALOGS=1 and the
  file keystore.
- Keychain: clean at last check (0 vyre-vault items). 33 deleted in all: 32 at the start, then 1
  (b0058401954f39b7) written by polish-cli's orphaned stress-drive vyred (pid 62783, which I
  stopped). No delete prompted or needed a password. The account list is in
  scratchpad/keychain-cleanup.txt.
- Hung-process check: no Vyre helper is running (vault, touchid, sight, hotkey, capsule).
  spindump (56994) and "Keychain Circle Notification" (56125, a system app) both started about
  19 min before this note. That was around the keychain cleanup, so the cleanup may have set off
  the notification app. Both are system processes, so I left them alone.

## Needs from others (open)

- polish-cli: stress-drive must write vault.keystore "file" and pass VYRE_NO_DIALOGS=1. Told twice,
  no reply yet.
- e2e: 4 orphaned journey vyreds (51999, 53170, 56736, 59570). They use the file keystore. Asked e2e
  to stop them.
- Lead: a custom VYRE_HOME now gets no dialogs at all. Add an env override for that?
