# app-walk: the app check against a real vyred

`scripts/app-walk.mjs` opens every screen of the app that is wired to the box, does that screen's main action in a real browser (Playwright Chromium), screenshots it, and
fails on sample data, on an error the box did not say, or on a console error. It is the integrator's app check.

## Run it

On a test box (never on a person's Mac):

1. Build the web export WITHOUT the mock: `cd apps/app && npm ci && npm run export:web` (never `export:web:mock`; that builds the sample world and the walk would be a walk of nothing).
2. Have Playwright where `PW_FROM` points (default `~/shots/`, as `apps/app/scripts/shots.mjs` does).
3. `node scripts/app-walk.mjs --dist apps/app/dist --socket <home>/.vyre/vyred.sock --out walk-out`
   - `--socket` is the box's own socket (the dev box: `~/devbox/home/.vyre/vyred.sock`), or `--box-url http://host:port` for a box that listens.
   - `--only memory,drive` runs the steps whose names contain those words. `--presence` runs the steps that need a person's proof (see below).

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
