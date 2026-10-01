#!/bin/sh
# release.sh: put the current main on vyre.run, so the one-liner always installs main.
#
#   scripts/release.sh [--ref REF] [--claude] [--skip-tests] [--dry-run]
#
#   --ref REF      what to release (default: main)
#   --claude       also run a real `claude -p --plugin-dir` session in the release check
#   --skip-tests   skip the suite and perf-check (the pack, install and site checks still run)
#   --dry-run      build and check everything, deploy nothing
#
# Steps, each skipped when there is nothing to do, so running it twice changes nothing:
#   1. check out REF into a scratch worktree (never this checkout's working tree)
#   2. scripts/build-site.sh: box files, vyre.tgz, SHA256SUMS, _redirects (the Mac installs from
#      npm and builds its Capsule there, so there is no Capsule zip)
#   3. scripts/release-check.sh against that tree
#   4. deploy site/ to Cloudflare Pages, unless vyre.run already serves the same SHA256SUMS
#   5. scripts/release-check.sh --live, and a summary
#
# The Capsule is not released here: a Mac builds it from the npm install (`vyre capsule install`).
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment (the vault's
# .env.vyre, loaded with set -a).
set -eu

ref=main
claude=""
skip=""
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref=$2; shift ;;
    --claude) claude=--claude ;;
    --skip-tests) skip="--skip-tests --skip-perf" ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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
cleanup() {
  git -C "$repo" worktree remove --force "$build/tree" >/dev/null 2>&1 || true
  rm -rf "$build"
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }

say "1. $ref at $short"
git -C "$repo" worktree add --detach --quiet "$build/tree" "$commit"
tree=$build/tree

say "1b. release key"
# Never overridable here: publishing with the placeholder key would put a key nobody vouched for on Macs.
env -u VYRE_ALLOW_PLACEHOLDER_KEY node "$tree/scripts/check-release-key.mjs" "$tree"

say "2. site"
[ -z "${VYRE_TEST_UNSTRIPPED_WRAPPER:-}" ] || { echo "release.sh: VYRE_TEST_UNSTRIPPED_WRAPPER is set; a release ships the stripped wrapper" >&2; exit 1; }
"$tree/scripts/build-site.sh"

say "3. release check"
# shellcheck disable=SC2086 # the flags are words
nice -n 10 "$tree/scripts/release-check.sh" $skip $claude

say "4. deploy"
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
  say "5. live"
  "$tree/scripts/release-check.sh" --skip-tests --skip-perf --live | tail -n 3
fi

say "summary"
echo "   released     $ref $short"
echo "   version      $(cat "$tree/site/box/VERSION")"
echo "   vyre.tgz     $(grep '  vyre.tgz$' "$tree/site/box/SHA256SUMS" | cut -c1-16)"
echo "   deployed     $deployed"
echo "   install      curl -fsSL $base/install.sh | sh"
echo "   Mac          npm install -g $base/box/vyre.tgz"
