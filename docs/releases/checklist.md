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
2. **Build.** The release workflow builds `vyre.tgz`, `release.json`, the box files, `shell.json` (`scripts/shell-hashes.mjs`, the hash of every file the phone's service worker caches) and `manifest.json`.
3. **Sign.** The sign job writes the final `SHA256SUMS` (every file above is listed) and `SHA256SUMS.sig`: Ed25519, with the release key, over the line `vyre-release-sums` and then the exact `SHA256SUMS` bytes. The private key is a protected secret of the workflow and is never on a machine.
4. **Publish.** The GitHub release carries the assets as signed, unchanged: `vyre.tgz`, `SHA256SUMS`, `SHA256SUMS.sig`, `shell.json`, `manifest.json` and the rest. Publishing never rebuilds `SHA256SUMS`.
5. **Prove the update path.** On a throwaway server, `vyre update` installs the release and says "signature checked against Vyre's release key"; the same release with its signature removed is refused. A Mac does the same.
6. **vyre.run.** Deploy the site and the install files (`scripts/build-site.sh`, then the Pages deploy it prints).
7. **phone.vyre.run.** Built and deployed with the first signed release, with the owner's approval, and never before it:

   ```sh
   node scripts/build-phone.mjs --tag vX.Y.Z --out phone-site
   npx wrangler pages deploy phone-site --project-name <the Pages project> --branch main
   ```

   The build refuses unless the signature verifies and every file of the signed `shell.json` is in the site, so the origin serves exactly what was signed. Check that `https://phone.vyre.run/release/SHA256SUMS.sig` answers and that a phone that opened the page before shows the new shell after one reload.
8. **Announce** only after steps 5 to 7 pass.

Naming (Lumen, Vyre Memory) waits for its own clearance before it goes on vyre.run.
