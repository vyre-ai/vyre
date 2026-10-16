# relay/web

What serves **web.vyre.run**: the Vyre app on the web (the owner's ruling of 13 Oct: two products, the app and the server). It is the same app as the
Mac, Windows and Android shells, the Expo web export (`apps/app`), and it is where a person signs in with their account and does setup, install and
regular operations. A server is installed only from a terminal and pairs to this app with the code it prints.

## How it differs from app.vyre.run

`relay/app` (app.vyre.run) is a loader: it pairs with a person's box first and then loads the build **that box** names. It cannot serve a first run,
because on a first run there is no box. web.vyre.run serves the release's own build directly, so the first screen is the app's own first run
(`/u/install`, the onboarding), and it reaches servers over the relay (`wss://relay.vyre.run`) exactly as the Mac app does. app.vyre.run is left as it
is for phones already paired through it, and its passkeys stay good.

## What is served, and from where

Never a branch build. The release workflow builds the web export (`app-web`), and its release job seals and signs it with the release key
(`scripts/build-app-out.mjs`, the `app-out` artifact). `scripts/build-web-out.mjs` takes that artifact, verifies the signed manifest against the
`RELEASE_KEY` pinned in `core/vyre-core/release.js` (it refuses the placeholder and any other key) and every file against the manifest, then lays the files
under `web-out/app/` (the export is built with base URL `/app`) and writes `web-out/vyre-build.json`: release, folder, manifest sha256, signature,
the sha256 of `index.html`, and the CSP hash of every inline script and style the page carries.

`worker.js` serves `web-out` with `run_worker_first`: `/app/*` are the app's files (a missing one is a 404, never the page), `/vyre-build.json` is the build
record, every other path is the app's page (the app routes itself; the URL fragment never leaves the browser).

## Policy

`default-src 'none'`; `script-src 'self'` plus the hash of each inline script; `style-src 'self' 'unsafe-inline'` (the app's component library writes its style sheet and element styles at run time, which a hash cannot name; the rehearsal showed a blank page under a hash-only policy; with `default-src 'none'` nothing can be reached from a style); `connect-src` only `'self'`, `relay.vyre.run`, `names.vyre.run` and `*.ts.net`;
no frames, no `base`, no form posts. HSTS 2 years with preload, `nosniff`, `no-referrer`, COOP and CORP same-origin, no cookies, no third-party script,
no request logs. The app's page and `vyre-build.json` are `no-cache`; `/app/_expo/static/*` (content-hashed) is immutable.

## Passkeys

A passkey belongs to its relying party, which is the host. `passkeyRp` (apps/app/src/identity/passkey.js) now accepts `https://web.vyre.run` (rp
`web.vyre.run`) beside `https://app.vyre.run` (rp `app.vyre.run`), so a person creates or signs in to their identity at web.vyre.run. **web.vyre.run is the
canonical place to make one.** app.vyre.run is not redirected: a passkey made there is good only there, and a redirect would strand it. If nobody holds
one, app.vyre.run can be redirected to web.vyre.run later; that is a decision for the lead, not made here. The Mac and Windows shells keep their own keys.

## Deploy

`.github/workflows/web-deploy.yml`, from main, on a published stable release (or by hand with the release run's id). A dry run reads nothing secret; the
real deploy waits for the `deploy` environment's reviewer, then runs `scripts/check-web-live.mjs` against the live site and the release: the exact bytes of every
file against the signed manifest, `index.html`, the headers, and in a fresh headless browser the first screen (a heading, the splash gone, a secure context
with WebAuthn, no policy violation, no page error). `web-rehearse.yml` does the same on every push that touches the app or this folder, with the branch's own export
signed by a throwaway key and served by this Worker's code on a local port, so a policy that breaks the app is found before a release.

### What the lead has to do once (Cloudflare, not in the repo)

1. The zone `vyre.run` is on the same Cloudflare account as the Workers `vyre-app`, `vyre-relay` and `vyre-names`. Nothing is needed if `web.vyre.run` has no
   existing DNS record: the Worker's `custom_domain = true` route creates the record and the certificate on the first deploy. If a `web` record or an old
   Pages/Worker route exists from the earlier web.vyre.run, delete it first (a custom domain refuses to attach over an existing record).
2. The API token in the `deploy` environment (`CLOUDFLARE_API_TOKEN`) already has Workers Scripts Edit and Workers Routes/Custom Domains for the account and
   Zone DNS Edit for vyre.run (relay-deploy uses it for the same kind of route). No new secret or variable.
3. HSTS preload: `vyre.run` is already sent with `preload` by the other Workers. Submitting the domain to the preload list is a separate step on hstspreload.org and is not needed for this deploy.
4. Approve the `deploy` environment run when `web-deploy` waits.

Tests: `node --test relay/web/web.test.js` (testbox or CI, never a Mac).
