# relay/app

**app.vyre.run is retired.** The Vyre app on the web is web.vyre.run (relay/web), the same app as the Mac, Windows and Android apps, running the new first run. This folder's Worker only sends
every request on to web.vyre.run (a phone's old `/app/join` and `/app/pair` links go to `/join` and `/pair`), and serves one file, `/sw.js`: a service worker that clears what the old loader
cached, unregisters itself and moves any open window to web.vyre.run. It has no assets, keeps no state and sets no cookie. Deploy it with `relay-deploy.yml` (the `app` input, after the owner's go).

What still lives here is shared with web.vyre.run and the release: `manifest.js` (the signed manifest of every file's SRI hash) and `release.js` (seal and verify), used by
`scripts/build-app-out.mjs` and `scripts/build-web-out.mjs`. The old loader (`loader/`, `sw.js`, `testing/`) is no longer served; it is dead code until the boxes' `relay.web.*` tools and the
release's loader step are removed (team/BACKLOG.md).

| File | What it does |
|---|---|
| `worker.js`, `wrangler.toml` | The redirect Worker and the kill-switch `/sw.js`. |
| `manifest.js` | The signed manifest: canonical JSON of every file's SRI hash, Ed25519-signed. Shared with `release.js` and `relay/web`. |
| `release.js` | Seal a build and verify a sealed folder. |
| `pair/` | The page at `vyre.run/pair` that the old pairing QR opened. That code is gone: the page says so and names the next step (sign in with the space address, username and master password). It makes no request. The docs site publishes it. |
| `loader/`, `sw.js`, `testing/` | The old phone loader. Not served any more. |

Tests: `node --test relay/app/*.test.js`.
