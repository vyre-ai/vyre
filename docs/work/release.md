# release

Branch: work/release · Worktree: ../vyre-release

## Scope

Owns `scripts/build-site.sh`, `scripts/build-mac-zip.sh`, `scripts/release-check.sh`,
`docs/GETTING-STARTED.md`, `site/start/`, `site/404.html`, and the package's "files" list. Made
the Mac branch of `vyre up` in `core/cli/commands/up.js` (`mac()`), agreed with box and install.

## Done

- The tarball carries what runs and nothing else. About 690 KB, checked by release-check.
- vyre.run serves the box files, `vyre.tgz`, `SHA256SUMS`, `/install.sh` and `/box`. The
  installer verifies every download against SHA256SUMS. Live `curl -fsSL https://vyre.run/install.sh | sh -s -- --yes`
  passed end to end in a fresh docker:dind on the server: it built the image from vyre.tgz and
  printed the onboarding link, and /onboard answered 200. A tampered file died on its checksum.
- The Capsule: `scripts/build-mac-zip.sh` builds Vyre.app, ad-hoc signs the whole bundle and
  zips it. The zip lives in R2 (`vyre-downloads`, `dl.vyre.run`) under a key named by its hash,
  and vyre.run/box/Vyre-mac.zip redirects there.
- `vyre up` on a Mac: find the box on the tailnet (or `--connect`), pair, then open the Capsule.
- `npm i -g https://vyre.run/box/vyre.tgz` works; the Harness works from the installed folder
  (a real `claude -p --plugin-dir` call).

## Release

```
set -a; . <vault>/.env.vyre; set +a
scripts/release.sh            # main; add --claude for a real Claude Code check
```

Run it after every main merge that touches install paths (core, bin, harness, box, scripts,
local/capsule, site), so the one-liner always installs current main.

## Needs from others

- capsule: sign the whole bundle in `vyre capsule build --app` (build-mac-zip does it for now).
- box: `pull_policy: build` in compose.build.yml quiets "pull access denied".
- The user: npm publish, a Developer ID with notarization, and a ghcr image.
