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
# The app's own export:web (expo export -p web, then scripts/precache.mjs), into dist, which
# core/daemon/app.js serves. Metro reads repo folders through aliases, so this runs in a checkout.
# Between the two: Metro puts the icons of packages (expo-router, react-navigation) under
# dist/assets/node_modules/, and npm never packs a folder named node_modules, so vyre.tgz lost them
# and /app/sw.js failed to install on their 404s. They move to dist/assets/nm/ and the bundle's
# paths follow, before the precache list is made.
CI=1 EXPO_NO_TELEMETRY=1 npx expo export -p web
if [ -d dist/assets/node_modules ]; then
  mv dist/assets/node_modules dist/assets/nm
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    let n = 0;
    for (const f of walk("dist").filter(f => /\.(js|html|json|css)$/.test(f))) {
      const s = fs.readFileSync(f, "utf8"), t = s.split("/assets/node_modules/").join("/assets/nm/");
      if (t !== s) { fs.writeFileSync(f, t); n++; }
    }
    if (!n) { console.error("build-app: no file named assets/node_modules; the icons would not load"); process.exit(1); }'
fi
[ -z "$(find dist -type d -name node_modules)" ] || { echo "build-app: dist still has a node_modules folder, which npm will not pack" >&2; exit 1; }
node scripts/precache.mjs dist /app/
[ -f dist/index.html ] || { echo "build-app: the export has no dist/index.html" >&2; exit 1; }
[ -f dist/precache.json ] || { echo "build-app: precache.mjs wrote no dist/precache.json" >&2; exit 1; }
files=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("dist/precache.json","utf8")).files.length))')
echo "build-app: apps/app/dist is $(du -sh dist | cut -f1), $(find dist -type f | wc -l | tr -d ' ') files, $files precached"
