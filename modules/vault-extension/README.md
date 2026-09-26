# Vyre Vault extension

A small Chrome (MV3) extension that fills logins from your own Vyre Vault. It talks to one
address only, the vyred fill listener you configure, and it never reads or sends page content.
The design and threat model are in `docs/adr/0001-autofill.md`.

## Install

1. Set `vault.fill` in `config.json` (for example `{ "host": "127.0.0.1", "port": 7788 }`) and
   restart vyred. On a box, put it behind `tailscale serve` and use the `https://*.ts.net` address.
2. Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick this
   folder.
3. Run `vyre vault unlock-passphrase` once to set the passphrase the extension will ask for.

## Pair

Run `vyre vault pair`. It prints an 8-character code that works once, for 5 minutes. Open the
extension, enter the vyred address and the code, and choose **Pair**. `vyre vault devices` lists
paired browsers; revoking one ends it at once.

## Use

Open the popup on a login page, unlock with the passphrase (or Touch ID through the Capsule,
then reopen the popup), and choose **Fill** next to a login. Only logins whose hosts include this
page's exact origin are offered or filled.

## What it stores

- `chrome.storage.local`: the vyred address, the device id and name, and the device token. The
  token lists login names for a page and cannot reveal a value on its own.
- `chrome.storage.session` and the worker's memory: the session token, which ends after
  10 minutes idle, 12 hours at most, on **Lock**, or when the browser closes.

## Addresses

The manifest's CSP allows `http://127.0.0.1:*`, `http://localhost:*` and `https://*.ts.net`.
Any other address needs those two lines of `manifest.json` changed. No build step, no remote code.
Fills go to the top frame of the active tab only.
