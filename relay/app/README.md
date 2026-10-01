# relay/app

What serves the hosted web app at `app.vyre.run`, and what keeps it honest (ADR 0026 section 10,
ADR 0027 section 4). The mobile team builds the app itself (the Expo web export). This folder
holds what serves that build and pins it.

| File | What it does |
|---|---|
| `loader/` | The fixed entry page, `loader.js` and `loader.css`. The loader pairs or connects through the relay with `relay/client/`, asks the box which build it trusts (`relay.web.release`), checks that build's signed manifest and hash, then loads its entry files under Subresource Integrity. The app finds the connection at `globalThis.vyre`. |
| `manifest.js` | The signed manifest: canonical JSON of every file's SRI hash, Ed25519-signed. It is shared by the loader (browser) and `release.js` (Node). |
| `sw.js` | The service worker. It installs a loader only when the loader's signature and every hash check out and the release is not older than the one it holds. It serves the loader from that cache. |
| `worker.js`, `wrangler.toml` | The Cloudflare Worker: static assets with a strict CSP (no inline script, no `eval`, connections only to the relay and `*.ts.net`) and the other security headers. `/v/<sha>/` is immutable. Any other path gets the loader. |
| `pair/` | The page at `vyre.run/pair` that a QR code opens. It checks the fragment and offers the app (`vyre://pair#...`) or the web app (`app.vyre.run/pair#...`), and it makes no request. The docs site publishes it. |
| `release.js` | The release steps, below. |

## A release

```sh
node relay/app/release.js keygen ~/release.key        # once; the private key never enters the repo
export VYRE_RELEASE_KEY=~/release.key
node relay/app/release.js loader --release 1.0.0      # only when the loader changes
node relay/app/release.js build <expo-dist> --release 0.4.2
# prints {"release":"0.4.2","sha":"...","manifest":"..."}: append it to core/relay/releases.json
node relay/app/release.js verify app-out/v/<sha> --pub ~/release.key.pub
cd relay/app && npx wrangler deploy                   # after the lead approves
```

In the release workflow this is one step: `scripts/build-app-out.mjs --dist apps/app/dist --release <x.y.z>` seals the loader and the build with the release key (the release environment's secret, in the environment, never a file; it refuses a key that is not the pinned `RELEASE_KEY`), verifies every folder, and the workflow uploads `app-out` as an artifact. `--throwaway` signs with a fresh key for a dry run and the tests; the deploy's pinned-key check refuses that. `scripts/deploy/fetch-app-out.sh` takes only that artifact from a successful `release` run on the commit being deployed.

A box loads a new build only once its `releases.json` names it (it ships with the box), or once
the owner pins one with `relay.web.pin`.

## The honest limit

The browser refetches `sw.js` at least once a day, so if the origin itself turns hostile it
can replace the worker, and then the loader. The pin stops an asset changed at the CDN. Every
change the page accepts is a signed, published release, and every build a box loads is one the
box named. The native app and the Deck on the tailnet do not fetch their code on each visit.

Tests: `node --test relay/app/*.test.js` (run them on testbox).
