#!/bin/sh
# release.sh: put the current main on vyre.run, so the one-liner always installs main.
#
#   scripts/release.sh [--ref REF] [--claude] [--skip-tests] [--mac] [--dry-run]
#
#   --ref REF      what to release (default: main)
#   --claude       also run a real `claude -p --plugin-dir` session in the release check
#   --skip-tests   skip the suite and perf-check (the pack, install and site checks still run)
#   --mac          rebuild the Capsule zip even if local/capsule has not changed
#   --dry-run      build and check everything, deploy nothing
#
# Steps, each skipped when there is nothing to do, so running it twice changes nothing:
#   1. check out REF into a scratch worktree (never this checkout's working tree)
#   2. the Capsule zip: rebuilt only when REF's local/capsule tree differs from the one the live
#      zip was built from (vyre.run/box/Vyre-mac.source), then uploaded to R2 under its hash
#   3. scripts/build-site.sh: box files, vyre.tgz, SHA256SUMS, _redirects
#   4. scripts/release-check.sh against that tree
#   5. deploy site/ to Cloudflare Pages, unless vyre.run already serves the same SHA256SUMS
#   6. scripts/release-check.sh --live, and a summary
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (the vault's
# .env.vyre, loaded with set -a). The Capsule steps need macOS.
set -eu

ref=main
claude=""
skip=""
mac=0
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=$2; shift ;;
    --claude) claude=--claude ;;
    --skip-tests) skip="--skip-tests --skip-perf" ;;
    --mac) mac=1 ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "release: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

repo=$(cd "$(dirname "$0")/.." && pwd)
base=${VYRE_SITE:-https://vyre.run}
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ "$dry" = 1 ] \
  || { echo "release: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set" >&2; exit 1; }

commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
short=$(git -C "$repo" rev-parse --short "$commit")
build=$(mktemp -d "${TMPDIR:-/tmp}/vyre-release-build.XXXXXX")
zip=$build.Vyre-mac.zip
cleanup() {
  git -C "$repo" worktree remove --force "$build/tree" >/dev/null 2>&1 || true
  rm -rf "$build" "$zip"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }

say "1. $ref at $short"
git -C "$repo" worktree add --detach --quiet "$build/tree" "$commit"
tree=$build/tree

say "2. the Capsule"
capsule_src=$(git -C "$repo" rev-parse "$commit:local/capsule")
live_src=$(curl -fsS "$base/box/Vyre-mac.source" 2>/dev/null || true)
mkdir -p "$tree/site/box"
mac_note=""
if [ "$mac" = 0 ] && [ "$live_src" = "$capsule_src" ]; then
  # Unchanged: carry the live zip's URL and checksum into this build.
  curl -fsS "$base/box/Vyre-mac.url" -o "$tree/site/box/Vyre-mac.url"
  curl -fsS "$base/box/Vyre-mac.zip.sha256" -o "$tree/site/box/Vyre-mac.zip.sha256"
  echo "   unchanged since the live zip (local/capsule $capsule_src)"
  mac_note="unchanged"
elif [ "$(uname -s)" = Darwin ]; then
  nice -n 10 "$tree/scripts/build-mac-zip.sh" "$zip"
  mac_note="rebuilt"
else
  echo "   local/capsule changed, and the zip builds only on macOS; keeping the live zip" >&2
  curl -fsS "$base/box/Vyre-mac.url" -o "$tree/site/box/Vyre-mac.url"
  curl -fsS "$base/box/Vyre-mac.zip.sha256" -o "$tree/site/box/Vyre-mac.zip.sha256"
  capsule_src=$live_src
  mac_note="stale (needs a Mac)"
fi

say "3. site"
if [ "$mac_note" = rebuilt ]; then
  up=""
  [ "$dry" = 1 ] || up=--upload
  "$tree/scripts/build-site.sh" --mac-zip "$zip" $up
else
  "$tree/scripts/build-site.sh"
fi
printf '%s\n' "$capsule_src" >"$tree/site/box/Vyre-mac.source"
# Vyre-mac.source is written after build-site; add its line so SHA256SUMS still covers every file.
(cd "$tree/site/box" && { if command -v sha256sum >/dev/null 2>&1; then sha256sum Vyre-mac.source; else shasum -a 256 Vyre-mac.source; fi; } >>SHA256SUMS \
  && LC_ALL=C sort -k2 SHA256SUMS -o SHA256SUMS)

say "4. release check"
# shellcheck disable=SC2086 # the flags are words
nice -n 10 "$tree/scripts/release-check.sh" $skip $claude

say "5. deploy"
deployed="no"
if curl -fsS "$base/box/SHA256SUMS" 2>/dev/null | cmp -s - "$tree/site/box/SHA256SUMS" \
  && curl -fsS "$base/start/" 2>/dev/null | cmp -s - "$tree/site/start/index.html"; then
  echo "   $base already serves exactly this build"
  deployed="already live"
elif [ "$dry" = 1 ]; then
  echo "   dry run: would deploy $tree/site"
  deployed="dry run"
else
  (cd "$tree" && npx --yes wrangler@4 pages deploy site --project-name vyre-site --branch main \
    --commit-hash "$commit" --commit-message "release $short" 2>&1 | grep -v -i token | tail -n 2)
  deployed="yes"
  # Pages takes a moment to switch the production alias over.
  i=0
  until curl -fsS "$base/box/SHA256SUMS" 2>/dev/null | cmp -s - "$tree/site/box/SHA256SUMS" || [ $i -ge 30 ]; do i=$((i + 1)); sleep 2; done
fi

if [ "$dry" = 0 ]; then
  say "6. live"
  "$tree/scripts/release-check.sh" --skip-tests --skip-perf --live | tail -n 3
fi

say "summary"
echo "   released     $ref $short"
echo "   version      $(cat "$tree/site/box/VERSION")"
echo "   vyre.tgz     $(grep '  vyre.tgz$' "$tree/site/box/SHA256SUMS" | cut -c1-16)"
echo "   Capsule      $mac_note, $(cat "$tree/site/box/Vyre-mac.url")"
echo "   deployed     $deployed"
echo "   install      curl -fsSL $base/install.sh | sh"
echo "   Mac          npm install -g $base/box/vyre.tgz"
