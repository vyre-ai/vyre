#!/bin/sh
# build-site.sh: put what the box installer downloads under site/, next to the landing page.
#
#   scripts/build-site.sh [--src DIR]
#
#   --src DIR       the checkout to take the box files from and pack vyre.tgz from (default: this
#                   repo, which needs box/ in it).
#
# The Capsule is not here: a Mac builds it from the npm install (`vyre capsule install`).
#
# Writes (all generated, all gitignored):
#   site/install.sh               what `curl -fsSL https://vyre.run/install.sh | sh` runs
#   site/w                        scripts/install-windows.ps1, what `irm https://vyre.run/w | iex` runs
#   site/box/install-box.sh       the same file, beside the rest
#   site/box/compose.yml, compose.build.yml, vyre.env.example, vyre
#                                 the stack install-box.sh lays out in /srv/vyre
#   site/box/Dockerfile, dockerignore
#                                 how the image is built from vyre.tgz while none is published
#   site/box/vyre.tgz             `npm pack` of --src, until the package is on npm, with the web
#                                 app scripts/build-app.sh exports into <src>/apps/app/dist first
#   site/box/SHA256SUMS           sha256 of every file above, `sha256sum -c` format
#   site/setup/relay/, tokens.css the setup page's relay client and shared tokens
#   site/_redirects               /box to install-box.sh, and /download/mac (onboarding's Capsule
#                                 link) to /start#mac
#   <src>/build.json              version, commit and dirty, for vyre status and /v1/health
#
# Deploy afterwards with:
#   scripts/deploy-site.sh site --branch main        (refuses a folder with setup/config.json)
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
src=$here
while [ $# -gt 0 ]; do
  case "$1" in
    --src) src=$(cd "$2" && pwd); shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "build-site: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

for f in box/compose.yml box/compose.build.yml box/vyre.env.example box/vyre \
  box/Dockerfile scripts/install-box.sh package.json; do
  [ -f "$src/$f" ] || { echo "build-site: $src has no $f (point --src at a checkout with box/ in it)" >&2; exit 1; }
done

# A build that would ship a signing key nobody vouched for stops here (VYRE_ALLOW_PLACEHOLDER_KEY=1
# lets a dry run through; scripts/release.sh never passes it).
if [ -f "$src/scripts/check-release-key.mjs" ]; then node "$src/scripts/check-release-key.mjs" "$src" || exit 1; fi

out=$here/site/box
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
rm -rf "$out"
mkdir -p "$out"

cp "$src/box/compose.yml" "$src/box/compose.build.yml" \
  "$src/box/vyre.env.example" "$src/box/Dockerfile" "$out/"
# The wrapper is the RELEASE build: every test override of box/vyre cut out, the pinned release key and cosign image as constants
# (scripts/strip-wrapper.mjs). VYRE_TEST_UNSTRIPPED_WRAPPER=1 copies the source for the CI matrix that rehearses the overrides with a
# throwaway key; release.sh and release-check.sh refuse a build made that way.
if [ -n "${VYRE_TEST_UNSTRIPPED_WRAPPER:-}" ]; then cp "$src/box/vyre" "$out/vyre"
else node "$here/scripts/strip-wrapper.mjs" "$src/box/vyre" >"$out/vyre" || { echo "build-site: could not build the release wrapper" >&2; exit 1; }
fi
# Served without the leading dot: some hosts refuse dotfiles.
[ -f "$src/.dockerignore" ] && cp "$src/.dockerignore" "$out/dockerignore"
cp "$src/scripts/install-box.sh" "$out/install-box.sh"
# The Mac server installer, served beside it and covered by SHA256SUMS.
[ ! -f "$src/scripts/install-mac-server.sh" ] || cp "$src/scripts/install-mac-server.sh" "$out/install-mac-server.sh"
cp "$src/scripts/install-box.sh" "$here/site/install.sh"
# The Windows installer's one line, `irm https://vyre.run/w | iex`: the script itself, served as plain text (site/_headers). Generated here, never
# edited in site/ (like install.sh).
cp "$src/scripts/install-windows.ps1" "$here/site/w"

{
  printf '/box /box/install-box.sh 200\n'
  # The install line the setup page shows: curl -fsSL https://vyre.run/i | VYRE_CODE=... sh
  printf '/i /install.sh 200\n'
  # Onboarding links here for the Capsule, which the Mac builds from the npm install.
  printf '/download/mac /start#mac 302\n'
} >"$here/site/_redirects"

# The setup page (site/setup, checked in) runs the same relay client the phone app does, and the one token
# file every surface shares: both are copied here, never edited here (so the call-to-action colour changes in
# lib/theme/tokens.json alone).
rm -rf "$here/site/setup/relay"
mkdir -p "$here/site/setup/relay"
for f in "$src"/relay/client/*.js; do
  case "$f" in *.test.js) continue ;; esac
  cp "$f" "$here/site/setup/relay/"
done
cp "$src/deck/css/tokens.css" "$here/site/setup/tokens.css"
# The phone's ring (the same drawing the Deck uses for Wink) and the renderer it needs, kept in the folder shape
# its own imports expect.
rm -rf "$here/site/setup/deck"
mkdir -p "$here/site/setup/deck/js" "$here/site/setup/deck/vendor/vyrecode"
cp "$src/deck/js/phone-code.js" "$here/site/setup/deck/js/"
cp "$src"/deck/vendor/vyrecode/*.js "$here/site/setup/deck/vendor/vyrecode/"
cp "$src/deck/vendor/qrcode.js" "$here/site/setup/deck/vendor/"
# Where a provider's sign-in page may be (sessions' list); the page falls back to any plain https address until it exists.
rm -f "$here/site/setup/signin-hosts.json"
[ -f "$src/lib/providers/signin-hosts.json" ] && cp "$src/lib/providers/signin-hosts.json" "$here/site/setup/signin-hosts.json"
# The two fonts, self-hosted so the page loads nothing from another origin.
rm -rf "$here/site/setup/fonts"
mkdir -p "$here/site/setup/fonts"
# The app no longer bundles text fonts (the platform font everywhere), so the setup page's files come from the Deck's own copies when the app's are gone.
font() { # font TARGET-NAME APP-PATH DECK-FILE
  if [ -f "$src/apps/app/assets/fonts/$2" ]; then cp "$src/apps/app/assets/fonts/$2" "$here/site/setup/fonts/$1"
  elif [ -f "$src/deck/fonts/$3" ]; then cp "$src/deck/fonts/$3" "$here/site/setup/fonts/$1"
  else echo "build-site: no font for $1 (neither apps/app/assets/fonts/$2 nor deck/fonts/$3)" >&2; exit 1; fi
}
font InstrumentSans-Regular.woff2 instrument-sans/InstrumentSans-Regular.woff2 instrument-sans-latin.woff2
font InstrumentSans-SemiBold.woff2 instrument-sans/InstrumentSans-SemiBold.woff2 instrument-sans-latin.woff2
font JetBrainsMono-Regular.woff2 jetbrains-mono/JetBrainsMono-Regular.woff2 jetbrains-mono-latin.woff2

# A checksum an older build-site packed for the retired Capsule zip.
rm -f "$src/box/Vyre-mac.sha256"
# Which commit this is, so `vyre status`, /v1/health and system.info can say (core/daemon/build.js).
# dirty ignores the files this script itself writes (site/_redirects, site/install.sh, site/box,
# build.json), so a clean checkout stamps clean however often this runs.
if git -C "$src" rev-parse --verify HEAD >/dev/null 2>&1; then
  commit=$(git -C "$src" rev-parse HEAD)
  if [ -n "$(git -C "$src" status --porcelain --untracked-files=no -- . ':!site/_redirects' ':!site/install.sh' ':!site/box' ':!site/setup/relay' ':!site/setup/tokens.css' ':!site/setup/fonts' ':!site/setup/deck' ':!build.json' ':!box/Vyre-mac.sha256')" ]; then dirty=true; else dirty=false; fi
  printf '{"version":"%s","commit":"%s","dirty":%s}\n' \
    "$(node -p 'require(process.argv[1]).version' "$src/package.json")" "$commit" "$dirty" >"$src/build.json"
else
  echo "build-site: $src is not a git checkout; the package says no commit" >&2
  rm -f "$src/build.json"
fi
# The web app at /app/ (apps/app/dist), which vyre.tgz ships; nothing when --src has no apps/app.
sh "$here/scripts/build-app.sh" --src "$src"
# The build kind is part of what is signed: the package says "release", so its daemon ignores the developer switches (kernel/devbuild.js). The checkout keeps "development".
if [ -f "$src/lib/build-kind.js" ]; then
  kind_keep=$(mktemp)
  cp "$src/lib/build-kind.js" "$kind_keep"
  trap 'cp -f "$kind_keep" "$src/lib/build-kind.js" 2>/dev/null; rm -f "$kind_keep"' EXIT
  # Fails the build when the file does not say release afterwards (DP-1); the same two lines kernel/devbuild.js reads (lib/build-kind-text.js).
  node "$src/scripts/stamp-build-kind.mjs" "$src/lib/build-kind.js" || exit 1
fi
# npm pack writes the tarball's name on its last line of stdout.
name=$(cd "$src" && npm pack --silent --pack-destination "$out" | tail -n 1)
mv "$out/$name" "$out/vyre.tgz"

# The version the tarball carries, for the /start page and the installer's messages.
node -e 'process.stdout.write(require(process.argv[1]).version + "\n")' "$src/package.json" >"$out/VERSION"

# The signed list of first-party modules (kernel/modules/release-list.js): the hash of every module folder of the UNPACKED tarball, so the hashes are of what a box will hold,
# made here with no key and listed in SHA256SUMS below, so the release key's one signature covers it. The counter is made from the version (scripts/release-counter.mjs):
# it orders as semver does and so only ever goes up. A source without the kernel's list code (an older line) makes no list.
if [ -f "$src/scripts/modules-manifest.mjs" ] && [ -f "$src/kernel/modules/release-list.js" ]; then
  unpacked=$(mktemp -d)
  tar -xzf "$out/vyre.tgz" -C "$unpacked" --strip-components=1
  ver=$(cat "$out/VERSION")
  node "$src/scripts/modules-manifest.mjs" "$unpacked" --counter "$(node "$src/scripts/release-counter.mjs" "$ver")" --release "$ver" --out "$out/modules.json" || exit 1
  # The web app's files (lib/app-build.js): the daemon serves a file of /app/ only when it matches this list, so it is signed with the rest (MW-5). No apps/app/dist, no list.
  if [ -f "$src/scripts/appbuild-manifest.mjs" ]; then node "$src/scripts/appbuild-manifest.mjs" "$unpacked" --release "$ver" --counter "$(node "$src/scripts/release-counter.mjs" "$ver")" --out "$out/appbuild.json" || exit 1; fi
  rm -rf "$unpacked"
  # shell.json carries both lists as exact text (lib/release-shell.js): the one file every updater since 0.2 already fetches, verifies and publishes, so a server an OLD updater updates still receives
  # the module list. modules.json and appbuild.json stay in the release and in SHA256SUMS: the embedded text must hash to those lines.
  node "$src/scripts/shell-hashes.mjs" "$out" "$ver" --modules "$out/modules.json" $( [ -f "$out/appbuild.json" ] && echo "--appbuild $out/appbuild.json" ) || exit 1
fi

(
  cd "$out"
  find . -type f ! -name SHA256SUMS | sed 's|^\./||' | while read -r f; do sum "$f"; done | LC_ALL=C sort -k2 >SHA256SUMS
)

# A run that has the signing key (VYRE_SIGNING_KEY, only ever a publishing release's sign step) also
# writes manifest.json and signs SHA256SUMS (SHA256SUMS.sig, ADR 0040 section 5); the release workflow's
# build job never has it, its sign job runs scripts/sign-manifest.mjs on the finished files.
if [ -n "${VYRE_SIGNING_KEY:-}" ]; then node "$src/scripts/sign-manifest.mjs" "$out" "$(cat "$out/VERSION")" "${VYRE_CHANNEL:-}" || exit 1; fi

echo "site/box:"
sed 's/^/  /' "$out/SHA256SUMS"
echo "  version $(cat "$out/VERSION")"
