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
