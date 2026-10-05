# app-walk: the app check against a real vyred

`scripts/app-walk.mjs` opens every screen of the app that is wired to the box, does that screen's main action in a real browser (Playwright Chromium), screenshots it, and
fails on sample data, on an error the box did not say, or on a console error. It is the integrator's app check.

## Run it

On a test box (never on a person's Mac):

1. Build the web export WITHOUT the mock: `cd apps/app && npm ci && npm run export:web` (never `export:web:mock`; that builds the sample world and the walk would be a walk of nothing).
2. Have Playwright where `PW_FROM` points (default `~/shots/`, as `apps/app/scripts/shots.mjs` does).
3. `node scripts/app-walk.mjs --dist apps/app/dist --socket <home>/.vyre/vyred.sock --out walk-out`
   - `--socket` is the box's own socket (the dev box: `~/devbox/home/.vyre/vyred.sock`), or `--box-url http://host:port` for a box that listens.
   - `--only memory,drive` runs the steps whose names contain those words. `--caller deck` (the default) is the x-vyre-caller label the walk sends, which on a dev box with the stand-in is the owner (a socket with no label is anonymous). `--presence` runs the steps that need a person's proof (see below).

The script serves `dist/` at `/app` and forwards `/v1/*` to the box, so the browser is at "the box's own address" and needs no sign-in beyond what the socket gives (the owner's
own read access). It does not pair a device, it does not touch the live relay or the live names directory.

## What each step judges

- PASS: the page showed real data or an honest empty state, with no sample text and no console error.
- HONEST: the box refused and the page said so in the box's words (a module the box does not have, a human-only call). The report names the tool and its code.
- SKIP: not run, and the reason is by name (needs presence; the box has no publish module; no Flow to open).
- FAIL: sample-world text on screen (`SAMPLE` in the script), an error state with no refusal from the box behind it, a console or page error, a missing expected marker, or the step threw.

Exit code 0 means nothing FAILED. `walk-out/report.json` has every step; `walk-out/<step>.png` is the screenshot.

## Presence

Steps marked `needs: "presence"` (Reveal in Vault, a new recovery code, a theme write, approving a Flow or a publish) are skipped by name until a presence stand-in
exists on the dev box. With one, pass `--presence`; the script then runs them.

## Keeping it honest

Add a step when a screen goes real. Add to `SAMPLE` any text only the sample world shows. A step that has to be skipped says why in its name's reason, so the skip list
is the list of what is not yet proven.

## The stand-in phone (approvals)

`scripts/standin-phone.mjs` answers the cards a browser asks the owner's phone for, in a development-kind home. It is a second client of the box's socket (caller `local`), never part of the app or the daemon, and refuses on a release-kind build.

One-time enrolment of a walk home (a throwaway home only; the daemon must be stopped):

1. Start the daemon once and stop it, so the home has `kernel/space.json`.
2. `node scripts/dev-enrol-software-key.mjs --home <abs .vyre dir>` (puts the owner's software presence key in the sealing process and writes `dev-owner-key.json`, 0600).
3. Start the daemon with `VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1` and WITHOUT `VYRE_KERNEL_FILE_KEY`. With the file key there is no sealing process to check the proof, and every yes answers `no_presence`. (Switching an existing home from the file key to the sealing process moves its kernel key once.)

Then `node scripts/standin-phone.mjs --home <abs .vyre dir> --answer yes|no|ignore --once` answers the next card. `scripts/app-walk-approval.mjs --socket <home>/.vyre/vyred.sock [--timeout]` runs the app's own ask code (`heldAsk`, `askYes`) against it: yes, no, and with `--timeout` a card nobody answers (5 minutes).

Not walked: spending an approved card. The box reads an approval only from a paired device caller, so it needs a browser paired through the relay. Also, RC1 hides Reveal in a browser on purpose (screens/vault/RealVault.tsx), so no page starts this flow for a vault item.

Run both scripts from an ssh login shell, in the foreground: the stand-in phone signs in with `signin.dev`, which the daemon allows only for a caller it already counts as the owner, and a detached process (setsid, nohup in the background) is not one. `--timeout` makes the run take about five minutes.

## awbox's own setup (app-wire), kept here so it can be rebuilt

- Unit `vyre-aw` runs the pinned tree in `~/awbox/src` with `~/awbox/env`: `VYRE_KERNEL=1`, `VYRE_KERNEL_PATH_RULE=1`, `VYRE_NO_DIALOGS=1`, `VYRE_SEAL_DEV=1`, `VYRE_SEAL_SOFTWARE=1`. `VYRE_KERNEL_FILE_KEY` is not set (a file key leaves no sealing process, so the stand-in phone's proof cannot be checked). The home is `~/awbox/home/.vyre`, enrolled with `scripts/dev-enrol-software-key.mjs`. `~/awbox/env.bak-filekey` is the old env.
- Unit `vyre-aw-relay` runs `~/awbox/relay.mjs`, a plain Node relay (`relay/node/server.js`, `createRelay().listen(8791)`) on `ws://127.0.0.1:8791`. The box is not pointed at it yet: `relay.enable` and `relay.pair.start` need a person's proof, and the dev stand-in only covers `vault.put` and `vault.reveal` (`STAND_IN_AUTO` in core/presence/index.js), so they answer `presence_required` headless.

## Paired devices on awbox (app-wire, 5 Oct)

- awbox's relay is on: `relay.enable` at `ws://127.0.0.1:8791`, signed with the software key (`dev-sign-proof.mjs --yes pair --tool relay.enable --input '{"url":"ws://127.0.0.1:8791"}' --header`). Before a signed call, send any call once with `x-vyre-presence: stand-in`: that trusts the sshd login leader (daemon `serverTrusted`); the signed header then carries the act's own proof.
- `scripts/app-walk-paired.mjs` pairs a headless browser by the `relay.pair.start` offer (it pairs: "Paired with awbox", the box lists the device). `scripts/app-walk-paired-device.mjs` does the same from Node with the relay client and runs the approval steps.
- What a device paired by that offer cannot do: the offer enrols whoever redeems it without the owner's yes (`relay.pair.start` is not gated), so the pairing is not "confirmed by its owner" and `presence.person.pair-grant` refuses it: no person session (`start-paired`: "this device cannot sign in that way"), `person_session_required` on vault.reveal and records.define, and a `web` device is untrusted ("no tool rules.list"). A person session needs the pairing confirmed with the owner's yes (wink.phone.open then the code, `wink.code.ack`, or `wink.approve`).

Update (typed pairing): with platform-3's `work/typed-web` (wink.code.ack is a pair yes moment; a device paired by typed code and the owner's ack is confirmed by its owner; it signs `start-paired` with the P-256 presence key it reported), `scripts/app-walk-paired-device.mjs` now pairs by typed code and walks the whole approval: pair, person session, the device's `vault.totp` asks, the stand-in phone approves, the device spends the approval, a second spend is refused, a no ends refused (6 of 6 on awbox). It uses `vault.totp` because the dev stand-in answers a `vault.reveal` that offers no proof (STAND_IN_AUTO), so a reveal never asks on awbox. `records.define` from that session still answers "this call is not from a signed-in person" (the paired session is software strength and a person-only kernel act does not take it).

`scripts/app-walk-typed.mjs` walks the browser screens that take a typed code against awbox's relay (build the exports with `EXPO_PUBLIC_VYRE_RELAY=ws://127.0.0.1:8791`, the claim build also with `EXPO_PUBLIC_VYRE_BROWSER_CLAIM=1 EXPO_PUBLIC_VYRE_NAMES_DIRECTORY=/names`): A, the browser start screen types a code, shows the ack, the owner types it back (wink.code.ack, software-key yes) and the page goes on to Your spaces; C, a device with no name types a wink.phone.open code and ends up holding the name. Join a space by typed invite code is not walked: awbox's spaces live on this computer, which cannot invite. Wait 90 seconds between runs (the relay limits pairing tries per minute).
