#!/bin/sh
# build-app.sh: the web export of the one app (ADR 0027), which vyred serves at /app/.
#
#   scripts/build-app.sh [--src DIR]
#
#   --src DIR       the checkout (default: this repo)
#
# Writes <src>/apps/app/dist (gitignored): `expo export -p web`, then scripts/precache.mjs's
# dist/precache.json, the list /app/sw.js caches. package.json "files" ships that folder in
# vyre.tgz, so build-site.sh, release.yml and box-image.yml run this before `npm pack`. A
# checkout with no apps/app has no app to build: it says so and exits 0.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
src=$here
while [ $# -gt 0 ]; do
  case "$1" in
    --src) src=$(cd "$2" && pwd); shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "build-app: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

app=$src/apps/app
if [ ! -f "$app/package.json" ]; then
  echo "build-app: $src has no apps/app; vyre.tgz ships without /app/"
  exit 0
fi

cd "$app"
rm -rf dist
npm ci --no-audit --no-fund --loglevel=error
EXPO_NO_TELEMETRY=1 npx expo export -p web --output-dir dist
node scripts/precache.mjs dist /app/
[ -f dist/index.html ] || { echo "build-app: the export has no dist/index.html" >&2; exit 1; }
[ -f dist/precache.json ] || { echo "build-app: precache.mjs wrote no dist/precache.json" >&2; exit 1; }
files=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("dist/precache.json","utf8")).files.length))')
echo "build-app: apps/app/dist is $(du -sh dist | cut -f1), $(find dist -type f | wc -l | tr -d ' ') files, $files precached"
