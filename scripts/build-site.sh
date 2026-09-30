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
#   site/box/install-box.sh       the same file, beside the rest
#   site/box/compose.yml, compose.build.yml, vyre.env.example, vyre
#                                 the stack install-box.sh lays out in /srv/vyre
#   site/box/Dockerfile, dockerignore
#                                 how the image is built from vyre.tgz while none is published
#   site/box/vyre.tgz             `npm pack` of --src, until the package is on npm, with the web
#                                 app scripts/build-app.sh exports into <src>/apps/app/dist first
#   site/box/SHA256SUMS           sha256 of every file above, `sha256sum -c` format
#   site/_redirects               /box to install-box.sh, and /download/mac (onboarding's Capsule
#                                 link) to /start#mac
#   <src>/build.json              version, commit and dirty, for vyre status and /v1/health
#
# Deploy afterwards with:
#   npx wrangler pages deploy site --project-name vyre-site --branch main
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
  "$src/box/vyre.env.example" "$src/box/vyre" "$src/box/Dockerfile" "$out/"
# Served without the leading dot: some hosts refuse dotfiles.
[ -f "$src/.dockerignore" ] && cp "$src/.dockerignore" "$out/dockerignore"
cp "$src/scripts/install-box.sh" "$out/install-box.sh"
# The Mac server installer, served beside it and covered by SHA256SUMS.
[ ! -f "$src/scripts/install-mac-server.sh" ] || cp "$src/scripts/install-mac-server.sh" "$out/install-mac-server.sh"
cp "$src/scripts/install-box.sh" "$here/site/install.sh"

{
  printf '/box /box/install-box.sh 200\n'
  # Onboarding links here for the Capsule, which the Mac builds from the npm install.
  printf '/download/mac /start#mac 302\n'
} >"$here/site/_redirects"

# A checksum an older build-site packed for the retired Capsule zip.
rm -f "$src/box/Vyre-mac.sha256"
# Which commit this is, so `vyre status`, /v1/health and system.info can say (core/daemon/build.js).
# dirty ignores the files this script itself writes (site/_redirects, site/install.sh, site/box,
# build.json), so a clean checkout stamps clean however often this runs.
if git -C "$src" rev-parse --verify HEAD >/dev/null 2>&1; then
  commit=$(git -C "$src" rev-parse HEAD)
  if [ -n "$(git -C "$src" status --porcelain --untracked-files=no -- . ':!site/_redirects' ':!site/install.sh' ':!site/box' ':!build.json' ':!box/Vyre-mac.sha256')" ]; then dirty=true; else dirty=false; fi
  printf '{"version":"%s","commit":"%s","dirty":%s}\n' \
    "$(node -p 'require(process.argv[1]).version' "$src/package.json")" "$commit" "$dirty" >"$src/build.json"
else
  echo "build-site: $src is not a git checkout; the package says no commit" >&2
  rm -f "$src/build.json"
fi
# The web app at /app/ (apps/app/dist), which vyre.tgz ships; nothing when --src has no apps/app.
sh "$here/scripts/build-app.sh" --src "$src"
# npm pack writes the tarball's name on its last line of stdout.
name=$(cd "$src" && npm pack --silent --pack-destination "$out" | tail -n 1)
mv "$out/$name" "$out/vyre.tgz"

# The version the tarball carries, for the /start page and the installer's messages.
node -e 'process.stdout.write(require(process.argv[1]).version + "\n")' "$src/package.json" >"$out/VERSION"

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
