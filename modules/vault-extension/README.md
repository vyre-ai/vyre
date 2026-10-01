# Vyre Vault extension

A small MV3 extension that fills logins, cards and addresses and answers passkey requests from your own Vyre Vault in Chrome, Arc, Edge, Brave and
Firefox, from one source. It talks to one address only, the vyred fill listener you configure,
and it never sends page content. (One named exception: with the API-key offer on, `keychip.js` reads
the text a page shows locally, looking for one key-shaped value; only a matched value, and only
after you tap Save, ever leaves the page. See "API keys a page shows".) The design and threat model are in
`docs/adr/0010-vault-autofill.md`; the fill window and the per-browser plan are in
`docs/adr/0028-vault-everywhere.md` (decisions 5 and 6).

Browsers give extensions no access to their own autofill dropdown, so the extension cannot put
Vyre logins or passkeys in the list the browser shows under a field. The small inline chooser and
the passkey prompt it draws (in closed shadow roots) are the Vyre UI in browsers.

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

## API keys a page shows

Create-key pages (a provider's console, a token settings page) show a key once. With page access
allowed and the popup's **Offer to save API keys pages show** on (it is on by default once page
access is granted), `keychip.js` looks at the text the page shows and at what you select to copy,
and when you click a Copy button it looks at the box beside it. A value counts when it has a
provider prefix (`sk-ant-`, `ghp_`, `xoxb-`, `AKIA`, the rows of `core/vault/detect.js`), or when
it is a long high-entropy string in an element labelled key, token or secret. UUIDs, git and file
hashes, base64 images, placeholders such as `sk-xxxxxxxx` or `YOUR_API_KEY`, and anything in a
password input (login save's) never count. The detection is `keyfind.js`, pure functions with
table-driven tests.

- **One tap.** A small chip in a closed shadow root asks "Save this Anthropic key to Vyre?". Save
  stores it ready to use through `/v1/fill/save-key`: kind and provider come from `detect.js`
  (the box classifies the value again and refuses anything that is not a secret), the name is the
  page's host plus the label (`console.example.com-api-key`), the page's origin is recorded, and
  when the provider is in the catalog the item is a connection, granted to a module whose need
  names it when vyred was given a `connect` hook. There is no draft and no second dialog. The chip
  then shows **Undo** for 10 seconds; undo removes only the item this tap made.
- **What leaves the page.** Before the tap, only a fingerprint (not the value) and whether the
  match was generic. The value goes to vyred on the tap, over the same paired, session-bound
  channel as `/v1/fill/save`, never to a third party, never logged. The worker records which
  origin the chip was raised on and vyred refuses a save whose page origin differs.
- **Once per value.** A value is offered once per tab, however many times the page shows it.
  Nothing appears while Vyre is locked.

## Cards and addresses

Items of kind `card` and `address` fill checkout and address forms. They are not tied to a site,
so the list is the same on every page (`/v1/fill/cards`, names and descriptions only; the page's
origin goes to the audit row and nowhere else).

- **Popup.** Under **Cards and addresses**, each card and address has a **Fill** for the active
  tab's top frame (`/v1/fill/card.fill`, `/v1/fill/address.fill`).
- **Suggestions on pages.** With suggestions on, focusing a payment field offers "Fill card:
  Northwind Bakery Visa", and focusing a field of an address form (one with a street, city or
  postal code field) offers the addresses. Same closed shadow root, same trusted-click rule.
- **A card asks every time.** A card is `reprompt` unless set otherwise, so its fill needs a proof
  made in the last 60 seconds, not just an open fill window. Otherwise the answer is "This card
  asks every time. Unlock again from the toolbar button." Addresses fill inside the window.
- **What goes where.** Holder, number, expiry (as MM/YY, and month and year apart) and security
  code. A card's PIN never leaves the vault for a page.
- **Finding fields** (`cards.js`). The `autocomplete` attribute first (`cc-number`, `cc-exp-month`,
  `postal-code` and the rest), then English words in the field's name, id, label and placeholder
  (card number, expiry, MM/YY, CVC, security code, zip, postcode, city, state, province...). A
  split expiry is handled whether the month select says "07", "7" or "July" and the year "2029"
  or "29"; a country select matches by ISO code or by name. One field per kind is filled, in the
  form you were in. Hidden, disabled and read-only fields are skipped.
- **Known gap: payment iframes.** Card fields inside another site's frame (a payment processor's
  hosted fields) are not filled. Fills go to the page's top frame only.

## Passkeys

With **Use Vyre for passkeys** on (the default once the browser is paired and the extension is
allowed on pages), a site's passkey request can be answered by your vault instead of the
browser's own authenticator. The private key never leaves vyred; only signatures do
(`core/vault/fill-passkey.js`, `core/vault/webauthn.js`).

- **What runs.** Two scripts, registered for every page and every frame at document start:
  `passkey-page.js` in the page's own world stands in for `navigator.credentials.create` and
  `.get`, and `passkey-bridge.js` beside it draws the prompt (a closed shadow root) and talks to
  the worker. The page script turns the site's options into JSON (every byte field as
  base64url), and turns vyred's answer back into a `PublicKeyCredential` the site's own code
  accepts (`instanceof` passes, fields are ArrayBuffers, `toJSON()` gives the WebAuthn JSON).
- **Create.** "Save a passkey for harlow.test in Vyre?" with the account name. **Continue**
  makes the passkey in the vault (`/v1/fill/passkey.create`) as an item of kind `passkey`.
- **Sign in.** The bridge first asks which Vyre passkeys this site has. None: the browser's own
  authenticator answers and no prompt appears. One: "Sign in to harlow.test as alex@harlow.test
  with Vyre?". Several: a list to pick from. **Continue** signs (`/v1/fill/passkey.get`).
- **Only on a real click.** Every choice acts on a click whose event `isTrusted`. The origin
  vyred signs for is the frame's, from the browser's sender, never from the page's message; an
  rpId the origin may not claim is a SecurityError. A frame of another site gets a clientData
  with `crossOrigin: true` and the tab's `topOrigin`, and only when the parent's permissions
  policy allows passkeys in that frame (where the browser lets the script read it).
- **Other ways out.** **Use another device** hands the request back to the browser's own
  authenticator (Touch ID, a phone, a security key) with the site's original options. **Cancel**
  answers NotAllowedError, as the browser's own dialog does. The same fallback happens without a
  prompt when the browser is not paired, vyred does not answer, or the site asks for something
  Vyre does not do (a cross-platform security key, no ES256).
- **Locked.** A vault without a live fill window shows "Vyre is locked": unlock from the toolbar
  button (Touch ID or passphrase), then **Try again**.
- **Known gap: conditional mediation.** A `get()` with `mediation: "conditional"` (passkeys in
  the username field's autofill list) always goes to the browser, so Vyre passkeys do not appear
  in that list; the site's "Sign in with a passkey" button does reach Vyre. Silent and immediate
  mediation go to the browser too.
- **Firefox 128 or later.** Passkeys need a registered script in the page's world, which Firefox
  has from 128. On older Firefox the toggle is off and greyed, and passkeys stay the browser's own.

## What it stores

- `storage.local`: the vyred address, the device id and name, and the device token. The
  token lists login names for a page and cannot reveal a value on its own.
- `storage.session` and the worker's memory: the session token, which ends 30 minutes after the
  proof that opened it (or sooner, see above), on **Lock**, or when the browser closes.
- The worker's memory only: a login typed into a page, until you save or dismiss it, for two
  minutes at most.
- `storage.local`: `passkeys: false` if you turned passkeys off. Passkeys themselves live in the
  vault, never in the browser.

## Addresses

The manifest's CSP allows `http://127.0.0.1:*`, `http://localhost:*`, `https://*.vyre.run` and `https://*.ts.net`.
Any other address needs those two lines of `manifest.json` changed. No build step is needed and
there is no remote code. In Firefox the fill listener answers the extension's `moz-extension://`
origin with CORS, so a fetch works even before the host permission is granted.
Fills go to the top frame of the active tab only.
