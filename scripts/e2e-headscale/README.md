# e2e on a private tailnet (headscale)

Walks the whole journey past Tailscale on the test server, with no real Tailscale account:
the onboarding, the first passkey, the Deck, the Vault, an agent, and pairing a Mac. Test harness
only; nothing here ships (the image's .dockerignore leaves out `scripts`).

What it runs, in compose project `vyre-e2e` at /srv/vyre-e2e (never /srv/vyre), every object
labelled `run.vyre.e2e`:

- headscale 0.29.4, with this policy (database mode, `headscale policy set`).
- the box: the tailscale service from box/compose.yml with `--login-server`, and vyred from
  `vyre-e2e:local` (built from the branch: `docker build -t vyre-e2e:local -f box/Dockerfile .`). Write a
  `build.json` (`{"commit":"<sha>","dirty":false}`) at the tree's root first, as a release does:
  without it every build is "v0.0.1", the Deck's service worker keeps the last run's files under
  the same cache name, and a page can load a stale module next to a fresh one.
- `alex-mac`: a tailscale node, headless Chrome and a vyred with `{"role":"local"}`, all in one
  network namespace, as on a Mac. `alex-phone` (profile phone): a second node and browser.
- `shim/tailscale` as the box's VYRE_TAILSCALE_BIN: headscale has no `tailscale cert` and no
  CertDomains, so the shim answers `cert` from a throwaway CA and passes everything else through.

One-time setup in /srv/vyre-e2e: copy these files there (headscale/, shim/), make `ca/ca.crt` and
`ca/box/vyre.tail0000.ts.net.{crt,key}` with openssl, and a Chrome NSS db that trusts only that
CA: `certutil -d sql:chrome/.pki/nssdb -N --empty-password; certutil -d sql:chrome/.pki/nssdb -A
-t C,, -n vyre-e2e-ca -i ca/ca.crt` (in a debian container with libnss3-tools).

Run: `./run1.sh` (prints the onboarding link), `./run2.sh <link>` (onboarding to the Deck, about
75 s), `./run3.sh` (Deck checks, then `vyre up` on the Mac and the phone approves with the passkey
synced from the Mac). `drive.mjs` holds each browser's CDP session on 127.0.0.1:19300 (Mac) and
19301 (phone), so its virtual authenticator lives as long as the run.

Do not restart headscale mid-run: its control URL is http on 8080, and a node that loses it once
retries on 443 with TLS ("forcing port 443 dial due to recent noise dial") until tailscaled
restarts. Real Tailscale is https on 443, so this is the harness's problem, not Vyre's.

Tear down: `docker compose --profile mac --profile phone down -v`, `sudo rm -rf /srv/vyre-e2e`,
`docker rmi vyre-e2e:local`.
