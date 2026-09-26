#!/bin/sh
# build-site.sh: put what the box installer downloads under site/, next to the landing page.
#
#   scripts/build-site.sh [--src DIR] [--mac-zip FILE]
#
#   --src DIR       the checkout to take the box files from and pack vyre.tgz from (default: this
#                   repo). Use a checkout with box/ in it; until box merges, that is ../vyre-box.
#   --mac-zip FILE  the packaged Capsule (Vyre.app, zipped with ditto) to offer as Vyre-mac.zip.
#                   Without it, a Vyre-mac.zip already in site/box/ is kept.
#
# Writes (all generated, all gitignored):
#   site/install.sh               what `curl -fsSL https://vyre.run/install.sh | sh` runs
#   site/box/install-box.sh       the same file, beside the rest
#   site/box/compose.yml, compose.build.yml, vyre.env.example, vyre
#                                 the stack install-box.sh lays out in /srv/vyre
#   site/box/Dockerfile, dockerignore
#                                 how the image is built from vyre.tgz while none is published
#   site/box/vyre.tgz             `npm pack` of --src, until the package is on npm
#   site/box/Vyre-mac.zip         the unsigned Capsule, when given
#   site/box/SHA256SUMS           sha256 of every file above, in `sha256sum -c` format
#
# Deploy afterwards with:
#   npx wrangler pages deploy site --project-name vyre-site --branch main
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
src=$here
zip=""
while [ $# -gt 0 ]; do
  case "$1" in
    --src) src=$(cd "$2" && pwd); shift ;;
    --mac-zip) zip=$2; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "build-site: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

for f in box/compose.yml box/compose.build.yml box/vyre.env.example box/vyre \
  box/Dockerfile scripts/install-box.sh package.json; do
  [ -f "$src/$f" ] || { echo "build-site: $src has no $f (point --src at a checkout with box/ in it)" >&2; exit 1; }
done

out=$here/site/box
keep=""
if [ -z "$zip" ] && [ -f "$out/Vyre-mac.zip" ]; then
  keep=$(mktemp)
  cp "$out/Vyre-mac.zip" "$keep"
fi
rm -rf "$out"
mkdir -p "$out"

cp "$src/box/compose.yml" "$src/box/compose.build.yml" \
  "$src/box/vyre.env.example" "$src/box/vyre" "$src/box/Dockerfile" "$out/"
# Served without the leading dot: some hosts refuse dotfiles.
[ -f "$src/.dockerignore" ] && cp "$src/.dockerignore" "$out/dockerignore"
cp "$src/scripts/install-box.sh" "$out/install-box.sh"
cp "$src/scripts/install-box.sh" "$here/site/install.sh"

# npm pack writes the tarball's name on its last line of stdout.
name=$(cd "$src" && npm pack --silent --pack-destination "$out" | tail -n 1)
mv "$out/$name" "$out/vyre.tgz"

if [ -n "$zip" ]; then cp "$zip" "$out/Vyre-mac.zip"
elif [ -n "$keep" ]; then mv "$keep" "$out/Vyre-mac.zip"
fi

# The version the tarball carries, for the /start page and the installer's messages.
node -e 'process.stdout.write(require(process.argv[1]).version + "\n")' "$src/package.json" >"$out/VERSION"

sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
(
  cd "$out"
  find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | while read -r f; do sum "$f"; done >SHA256SUMS
)

echo "site/box:"
sed 's/^/  /' "$out/SHA256SUMS"
echo "  version $(cat "$out/VERSION")"
