# Vyre Vault extension

A small MV3 extension that fills logins from your own Vyre Vault in Chrome, Arc, Edge, Brave and
Firefox, from one source. It talks to one address only, the vyred fill listener you configure,
and it never reads or sends page content. The design and threat model are in
`docs/adr/0010-vault-autofill.md`; the fill window and the per-browser plan are in
`docs/adr/0028-vault-everywhere.md` (decisions 5 and 6).

Browsers give extensions no access to their own autofill dropdown, so the extension cannot put
Vyre logins in the list the browser shows under a field. The small inline chooser it draws (in a
closed shadow root) is the one Vyre UI in browsers.

## Install

1. Set `vault.fill` in `config.json` (for example `{ "host": "127.0.0.1", "port": 7788 }`) and
   restart vyred. On a box, put it behind `tailscale serve` and use your `https://<you>.vyre.run` address (or the `https://*.ts.net` name).
2. Load the extension:
   - **Chrome, Arc, Edge, Brave**: open the extensions page (`chrome://extensions`,
     `arc://extensions`, `edge://extensions` or `brave://extensions`), turn on Developer mode,
     choose **Load unpacked** and pick this folder (or `dist/chrome`, below).
   - **Firefox 121 or later**: open `about:debugging#/runtime/this-firefox`, choose **Load
     Temporary Add-on** and pick `manifest.json` in this folder (or in `dist/firefox`). A
     temporary add-on is removed when Firefox quits; a signed build stays.
3. On a machine without Touch ID, run `vyre vault unlock-passphrase` once to set the passphrase
   the extension will ask for. With Touch ID through the Capsule you can skip it.

### One source, two packages

The folder loads in every browser as it is: Chrome uses `background.service_worker`, Firefox
uses `background.scripts` (an event page), and each ignores the other's key and shows a warning
for it. `node modules/vault-extension/build.mjs` writes `dist/chrome/` and `dist/firefox/`, each
with a manifest carrying only its own keys (the Firefox one keeps the gecko id `vault@vyre.sh`).
It is a plain copy with a manifest transform, no dependencies. `dist/` is not committed.

## Pair

Run `vyre vault pair`. It prints an 8-character code that works once, for 5 minutes. Open the
extension, enter the vyred address and the code, and choose **Pair**. `vyre vault devices` lists
paired browsers; revoking one ends it at once.

## Use

Open the popup on a login page, unlock with Touch ID through the Capsule (then reopen the
popup), or with the passphrase on a machine without Touch ID, and choose **Fill** next to a
login. Only logins whose hosts include this page's exact origin are offered or filled.

One proof opens a **fill window of 30 minutes**. Inside it, fills do not ask again. It counts
from the proof and does not extend with use; it also ends on **Lock** and
when the browser closes. `vault.fill.window` in `config.json` (minutes, 1 to 30) makes it
shorter, never longer.

## Suggestions on pages, keyboard fill, codes and saving

- **Keyboard fill.** Press Cmd+Shift+L (Ctrl+Shift+L elsewhere; change it at
  `chrome://extensions/shortcuts`). One login for the page fills at once; several open a chooser.
- **Suggestions on pages** (off by default). Turn on "Suggest logins on pages" in the popup and
  allow the browser's prompt. Focusing a login field then shows a chooser under it, drawn in a
  closed shadow root the page cannot read. It fills only on a real click (`isTrusted`), and only
  logins whose hosts include the page's exact origin. A one-time-code box offers the code
  (`/v1/fill/otp`). Turning it off removes the permission again.
- **Save and update.** With suggestions on, submitting a login form holds what you typed in the
  worker's memory for two minutes and asks "Save this login?" (or "Update the password?"). Only
  your click saves it, through `/v1/fill/save`: a new login gets this page's origin as its only
  host; an update keeps the replaced password in the item's sealed history (the last 5).

## What it stores

- `storage.local`: the vyred address, the device id and name, and the device token. The
  token lists login names for a page and cannot reveal a value on its own.
- `storage.session` and the worker's memory: the session token, which ends 30 minutes after the
  proof that opened it (or sooner, see above), on **Lock**, or when the browser closes.
- The worker's memory only: a login typed into a page, until you save or dismiss it, for two
  minutes at most.

## Addresses

The manifest's CSP allows `http://127.0.0.1:*`, `http://localhost:*`, `https://*.vyre.run` and `https://*.ts.net`.
Any other address needs those two lines of `manifest.json` changed. No build step is needed and
there is no remote code. In Firefox the fill listener answers the extension's `moz-extension://`
origin with CORS, so a fetch works even before the host permission is granted.
Fills go to the top frame of the active tab only.
