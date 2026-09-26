#!/bin/sh
# build-site.sh: put what the box installer downloads under site/, next to the landing page.
#
#   scripts/build-site.sh [--src DIR] [--mac-zip FILE [--upload]]
#
#   --src DIR       the checkout to take the box files from and pack vyre.tgz from (default: this
#                   repo, which needs box/ in it).
#   --mac-zip FILE  the packaged Capsule (Vyre.app, ad-hoc signed, zipped with ditto) to offer at
#                   vyre.run/box/Vyre-mac.zip. It is over Pages' 25 MiB file limit, so it lives in
#                   the R2 bucket vyre-downloads (served as dl.vyre.run) under a key named by its
#                   hash, and Pages redirects to it. Without --mac-zip, the last one is kept.
#   --upload        put --mac-zip into R2 with wrangler (needs CLOUDFLARE_API_TOKEN and
#                   CLOUDFLARE_ACCOUNT_ID in the environment).
#
# Writes (all generated, all gitignored):
#   site/install.sh               what `curl -fsSL https://vyre.run/install.sh | sh` runs
#   site/box/install-box.sh       the same file, beside the rest
#   site/box/compose.yml, compose.build.yml, vyre.env.example, vyre
#                                 the stack install-box.sh lays out in /srv/vyre
#   site/box/Dockerfile, dockerignore
#                                 how the image is built from vyre.tgz while none is published
#   site/box/vyre.tgz             `npm pack` of --src, until the package is on npm
#   site/box/Vyre-mac.zip.sha256  the Capsule zip's checksum, and site/box/Vyre-mac.url its URL
#   site/box/SHA256SUMS           sha256 of every file above and of Vyre-mac.zip, `sha256sum -c` format
#   <src>/box/Vyre-mac.sha256     the zip's sha256 alone, packed into vyre.tgz
#   site/_redirects               /box to install-box.sh, /box/Vyre-mac.zip to R2, and
#                                 /download/mac (onboarding's Capsule link) to /start#mac
#
# Deploy afterwards with:
#   npx wrangler pages deploy site --project-name vyre-site --branch main
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
src=$here
zip=""
upload=0
while [ $# -gt 0 ]; do
  case "$1" in
    --src) src=$(cd "$2" && pwd); shift ;;
    --mac-zip) zip=$2; shift ;;
    --upload) upload=1 ;;
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
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
keep=$(mktemp -d)
trap 'rm -rf "$keep"' EXIT
if [ -z "$zip" ] && [ -f "$out/Vyre-mac.url" ]; then cp "$out/Vyre-mac.url" "$out/Vyre-mac.zip.sha256" "$keep/"; fi
rm -rf "$out"
mkdir -p "$out"

cp "$src/box/compose.yml" "$src/box/compose.build.yml" \
  "$src/box/vyre.env.example" "$src/box/vyre" "$src/box/Dockerfile" "$out/"
# Served without the leading dot: some hosts refuse dotfiles.
[ -f "$src/.dockerignore" ] && cp "$src/.dockerignore" "$out/dockerignore"
cp "$src/scripts/install-box.sh" "$out/install-box.sh"
cp "$src/scripts/install-box.sh" "$here/site/install.sh"

if [ -n "$zip" ]; then
  hash=$(sum "$zip" | cut -d' ' -f1)
  key=capsule/$(printf '%s' "$hash" | cut -c1-16)/Vyre-mac.zip
  if [ "$upload" = 1 ]; then
    npx --yes wrangler@4 r2 object put "vyre-downloads/$key" --file "$zip" --content-type application/zip --remote >/dev/null
  fi
  printf '%s  Vyre-mac.zip\n' "$hash" >"$out/Vyre-mac.zip.sha256"
  printf 'https://dl.vyre.run/%s\n' "$key" >"$out/Vyre-mac.url"
elif [ -f "$keep/Vyre-mac.url" ]; then cp "$keep/Vyre-mac.url" "$keep/Vyre-mac.zip.sha256" "$out/"
fi
{
  printf '/box /box/install-box.sh 200\n'
  # Onboarding links here for the Capsule, which the Mac builds from the npm install.
  printf '/download/mac /start#mac 302\n'
  [ -f "$out/Vyre-mac.url" ] && printf '/box/Vyre-mac.zip %s 302\n' "$(cat "$out/Vyre-mac.url")"
} >"$here/site/_redirects"

# The package carries the zip's checksum, so `vyre capsule install` can pin the zip it fetches to
# the version installed. Written into --src before packing; gitignored there.
if [ -f "$out/Vyre-mac.zip.sha256" ]; then cut -d' ' -f1 "$out/Vyre-mac.zip.sha256" >"$src/box/Vyre-mac.sha256"
else rm -f "$src/box/Vyre-mac.sha256"
fi
# npm pack writes the tarball's name on its last line of stdout.
name=$(cd "$src" && npm pack --silent --pack-destination "$out" | tail -n 1)
mv "$out/$name" "$out/vyre.tgz"

# The version the tarball carries, for the /start page and the installer's messages.
node -e 'process.stdout.write(require(process.argv[1]).version + "\n")' "$src/package.json" >"$out/VERSION"

(
  cd "$out"
  {
    find . -type f ! -name SHA256SUMS | sed 's|^\./||' | while read -r f; do sum "$f"; done
    # The zip is served from R2 through a redirect, not from here, but it is listed like the
    # rest: `vyre capsule install` checks it against this file.
    [ -f Vyre-mac.zip.sha256 ] && cat Vyre-mac.zip.sha256
  } | LC_ALL=C sort -k2 >SHA256SUMS
)

echo "site/box:"
sed 's/^/  /' "$out/SHA256SUMS"
echo "  version $(cat "$out/VERSION")"
