#!/bin/sh
# assemble-site.sh: the whole vyre.run folder for a deploy: the v2 pages in site/, plus everything build-site.sh adds on top of them
# (the installers and the setup page's copied files), taken from a release tag so what is served is what the release signed.
#
#   scripts/assemble-site.sh --out DIR [--tag v0.2.0] [--check URL]
#
#   --out DIR     the folder to write (replaced). Deploy it with scripts/deploy-site.sh DIR --branch NAME.
#   --tag TAG     the release to take the installers from (default v0.2.0). Its signed files come from the GitHub release assets:
#                 SHA256SUMS, SHA256SUMS.sig, manifest.json, release.json, vyre.tgz, the box files and the Windows installer.
#                 Everything else comes from the tag's own source, the way scripts/build-site.sh copies it.
#   --check URL   afterwards, fetch DIR's installer paths from URL (a deployed copy) and compare byte for byte.
#
# What it writes beside site/ (all of it generated, none of it committed; site/ itself is never changed):
#   install.sh, i, box, w          the install line, /box, and the Windows installer script (_redirects and a copy of the script)
#   box/*                          the release's box files, checked against its SHA256SUMS
#   box/install-mac-server.sh      the Mac server installer; install-box.sh fetches it from the same site on a Mac (not in the release assets)
#   setup/relay, deck, fonts, tokens.css, signin-hosts.json   the files the setup page loads, copied from the tag
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
tag=v0.2.0; out=""; check=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out=$2; shift ;;
    --tag) tag=$2; shift ;;
    --check) check=$2; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "assemble-site: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$out" ] || { echo "assemble-site: --out DIR is required" >&2; exit 1; }
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
cd "$here"
git rev-parse --verify "$tag^{commit}" >/dev/null || { echo "assemble-site: no tag $tag here (git fetch --tags)" >&2; exit 1; }
say() { printf '== %s\n' "$*"; }

say "pages"
node scripts/gen-site.mjs >/dev/null
rm -rf "$out"; mkdir -p "$out"
cp -R site/. "$out/"
for f in w i install.sh box _redirects; do [ ! -e "$out/$f" ] || { echo "assemble-site: site/ already has $f; it must stay generated" >&2; exit 1; }; done

say "release assets $tag"
mkdir -p "$out/box"
gh release download "$tag" -R vyre-ai/vyre --dir "$out/box" --clobber \
  -p SHA256SUMS -p SHA256SUMS.sig -p manifest.json -p release.json -p VERSION -p vyre -p vyre.tgz -p vyre.env.example \
  -p compose.yml -p compose.build.yml -p Dockerfile -p dockerignore -p install-box.sh -p 'Vyre*.exe'
(cd "$out/box" && sum -c --quiet SHA256SUMS) || { echo "assemble-site: the release files do not match their SHA256SUMS" >&2; exit 1; }
cp "$out/box/install-box.sh" "$out/install.sh"

say "from the tag's source"
git show "$tag:scripts/install-windows.ps1" >"$out/w"
git show "$tag:scripts/install-mac-server.sh" >"$out/box/install-mac-server.sh"
printf '/box /box/install-box.sh 200\n/i /install.sh 200\n/download/mac /start#mac 302\n' >"$out/_redirects"
mkdir -p "$out/setup/relay" "$out/setup/deck/js" "$out/setup/deck/vendor/vyrecode" "$out/setup/fonts"
for f in $(git ls-tree --name-only "$tag" relay/client/ | grep '\.js$' | grep -v '\.test\.js$'); do git show "$tag:$f" >"$out/setup/relay/$(basename "$f")"; done
git show "$tag:deck/css/tokens.css" >"$out/setup/tokens.css"
git show "$tag:deck/js/phone-code.js" >"$out/setup/deck/js/phone-code.js"
for f in $(git ls-tree --name-only "$tag" deck/vendor/vyrecode/ | grep '\.js$'); do git show "$tag:$f" >"$out/setup/deck/vendor/vyrecode/$(basename "$f")"; done
git show "$tag:deck/vendor/qrcode.js" >"$out/setup/deck/vendor/qrcode.js"
git cat-file -e "$tag:lib/providers/signin-hosts.json" 2>/dev/null && git show "$tag:lib/providers/signin-hosts.json" >"$out/setup/signin-hosts.json" || true
for f in instrument-sans/InstrumentSans-Regular.woff2 instrument-sans/InstrumentSans-SemiBold.woff2 jetbrains-mono/JetBrainsMono-Regular.woff2; do
  git show "$tag:apps/app/assets/fonts/$f" >"$out/setup/fonts/$(basename "$f")"
done

say "checks"
cmp -s "$out/install.sh" "$out/box/install-box.sh" || { echo "assemble-site: install.sh is not install-box.sh" >&2; exit 1; }
[ "$(cat "$out/box/VERSION")" = "${tag#v}" ] || echo "assemble-site: note: box/VERSION is $(cat "$out/box/VERSION"), the tag is $tag" >&2
for f in site/setup/index.html site/setup/page.js site/setup/flow.js; do cmp -s "$f" "$out/${f#site/}" || { echo "assemble-site: $f changed on the way" >&2; exit 1; }; done
echo "ok: $(find "$out" -type f | wc -l | tr -d ' ') files in $out; box version $(cat "$out/box/VERSION")"

if [ -n "$check" ]; then
  say "served at $check"
  bad=0
  for p in install.sh w box/VERSION box/SHA256SUMS box/SHA256SUMS.sig box/manifest.json box/release.json box/vyre box/vyre.tgz box/compose.yml box/install-box.sh box/install-mac-server.sh setup/tokens.css; do
    f=$(mktemp); curl -fsSL "$check/$p" -o "$f" || { echo "MISSING $p"; bad=1; rm -f "$f"; continue; }
    if cmp -s "$f" "$out/$p"; then echo "same    $p"; else echo "DIFFERS $p"; bad=1; fi; rm -f "$f"
  done
  for p in i box; do
    n=$(curl -fsSL "$check/$p" | wc -c | tr -d ' ')
    [ "$n" = "$(wc -c <"$out/install.sh" | tr -d ' ')" ] && echo "same    /$p serves install.sh" || { echo "DIFFERS /$p"; bad=1; }
  done
  [ "$bad" = 0 ] || exit 1
fi
