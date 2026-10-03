---
title: Release checklist
summary: The steps that take a Vyre release from a green branch to every place it is served, in order, with who does each and what proves it.
audience: builders
owner: launch
status: draft
---

# Release checklist

The order matters: nothing is served before the release is signed, and everything served is built from the signed assets.

1. **Green.** `scripts/release-check.sh` passes: the suite, the idle budgets, the packed tarball, a temp install, the Harness, and the checksums in `site/box`.
2. **Build.** (Run the dry-run dispatch on a commit whose Windows build, `capsule-win.yml`, is already green: a tag build has a Windows installer, but the release job can race it.) The release workflow builds `vyre.tgz`, `release.json`, the box files, `shell.json` (`scripts/shell-hashes.mjs`, the hash of every file the phone's service worker caches) and `manifest.json`.
3. **Sign.** The sign job writes the final `SHA256SUMS` (every file above is listed) and `SHA256SUMS.sig`: Ed25519, with the release key, over the line `vyre-release-sums` and then the exact `SHA256SUMS` bytes. The private key is a protected secret of the workflow and is never on a machine.
4. **Publish.** The GitHub release carries the assets as signed, unchanged: `vyre.tgz`, `SHA256SUMS`, `SHA256SUMS.sig`, `shell.json`, `manifest.json` and the rest. Publishing never rebuilds `SHA256SUMS`.
5. **Prove the update path.** On a throwaway server, `vyre update` installs the release and says "signature checked against Vyre's release key"; the same release with its signature removed is refused. A Mac does the same.
5b. **Served matches signed.** After the deploy in step 6, `node scripts/check-served.mjs --origin https://vyre.run --release <the release's assets folder>` passes: the setup page and the install scripts vyre.run serves are the files the release's signed `setup.json` lists. It is a tamper check for what that one request gets, since an origin can answer another client or network differently: run it from more than one place.
6. **vyre.run.** Deploy the site and the install files (`scripts/build-site.sh`, then `scripts/deploy-site.sh site --branch main`, which refuses a folder that carries a staging `setup/config.json`).
7. **phone.vyre.run.** Built and deployed with the first signed release, with the owner's approval, and never before it:

   ```sh
   node scripts/build-phone.mjs --tag vX.Y.Z --out phone-site
   npx wrangler pages deploy phone-site --project-name <the Pages project> --branch main
   ```

   The build refuses unless the signature verifies and every file of the signed `shell.json` is in the site, so the origin serves exactly what was signed. Check that `https://phone.vyre.run/release/SHA256SUMS.sig` answers and that a phone that opened the page before shows the new shell after one reload.
8. **Announce** only after steps 5 to 7 pass.

Naming (Lumen, Vyre Memory) waits for its own clearance before it goes on vyre.run.

## What the released compose.yml must look like (pulled boxes)

A box that pulls its image checks the release before it pulls (`vyre update` in box/vyre, and install-box.sh). The release job must therefore write the released `compose.yml` with every `image:` line as the literal `image: <name>@sha256:<64 hex>`: no `${VYRE_IMAGE:-...}` variable, no tag, no trailing comment. `release.json` names the box image (and the computer image) by the same digest under `images`, and cosign signs each digest with the release workflow's identity. The wrapper installed on a server is the release build of box/vyre (scripts/strip-wrapper.mjs, run by build-site.sh): `release-check.sh` fails if it still names a test override, and `release.sh` refuses `VYRE_TEST_UNSTRIPPED_WRAPPER`.

## After 0.2.0 lands on stage: redeploy the site for vyre.run/w

`https://vyre.run/w` is `scripts/install-windows.ps1`, put at `site/w` by `scripts/build-site.sh` and served as plain text by `site/_headers`. It only exists once the site is redeployed from the commit that carries 0.2.0 (the site is built from main only; `scripts/deploy-site.sh`). Check afterwards: `curl -sI https://vyre.run/w` is 200 with `content-type: text/plain`, and `curl -s https://vyre.run/w | cmp - scripts/install-windows.ps1`. `release-check.sh --live` does both.

## The patch fast lane

Code that runs on a server still ships only as a signed release. A patch needs no more ceremony than that.

1. `node scripts/patch-release.mjs <fix commit>...` makes `hotfix/vX.Y.Z+1` off the newest stable tag, cherry-picks the fixes, moves every version place, writes `release/notes/X.Y.Z+1.md` from the commit subjects and commits it. Edit the first line of the notes (the summary) and push the branch (`--push` does it).
2. The branch's hosted runs are the gates. List any red with its reason.
3. With the user's go: set `VYRE_RELEASES=go` and tag the commit `vX.Y.Z+1`. `X, builds, and waits for the user's `release` approval, which is the one approval the release needs.
4. After the release run completes, `release-verify.yml` runs the release checks by itself (the folder against the previous release's pinned key, both signatures, both image digests with and without a login, and a real box on the previous release updating itself), and `site-deploy.yml` puts vyre.run on the new tag, waiting for the `deploy` approval. Both workflows run from main, so they are only live once they are on main.
5. The app deploy (`relay-deploy.yml` with `app=true` and the release run id) waits for the same `deploy` approval.

## Before the relay fix for GHSA-25xh-w9j7-7v28 counts as closed

The app no longer has a shared limit on `/v1/pair` or the setup mailbox, so cost is the edge's. Both of these are required, not recommended:

- [ ] Dispatch relay-deploy with `relay=true` and `relay_edge_rule=true` (a separate environment secret, `CLOUDFLARE_WAF_TOKEN`, scoped to Zone WAF Edit on vyre.run, used by this step only). It writes one per-address Cloudflare rate-limit rule on `/v1/pair` and `/v1/setup/mbx`, and prints the rules it wrote. Check the rule in the Cloudflare dashboard.
- [x] The relay's Workers and Durable Objects run on a paid plan (Workers Paid bought for vyre.run, 2 Oct 2026; confirm in the dashboard or by the account's plan in the API after the relay deploy). Every `/v1/pair` request reaches a ticket object and every random locator on the mailbox creates one, so on the Free plan's daily request cap an outsider could still stop pairing and installs until it resets. The edge rule limits one address; only the paid plan covers a distributed flood.
- [ ] The edge rule matches the host relay.vyre.run only. `workers_dev` is off in relay/worker/wrangler.toml, so the deployed Worker has no other public address; a staging copy of the Worker, or any other hostname, is not covered by it.
- [ ] `CLOUDFLARE_WAF_TOKEN` (Zone WAF Edit covers the whole zone) is an environment secret on the protected `deploy` environment with approval, used only by relay-deploy.yml, never a repository-wide secret, and the deploy token does not carry that scope.
- [ ] Release note, residuals: the edge rule blocks per address whatever the answer would be (a neighbour on the same address can still get it blocked, hits included); a flood from many addresses can still use up the account's Workers and Durable Object quota on the Free plan (a hit counts too), so the paid plan is required (bought 2 Oct 2026). The advisory stays private until released.
