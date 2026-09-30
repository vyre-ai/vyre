#!/bin/sh
# mac-bundle.sh: assemble the signed Vyre.app for macOS (PLAN.md C1): the Capsule, a pinned Node
# runtime, the runtime files of the vyre package, the CLI, and the LaunchAgent that runs the node.
# build.sh stays the Capsule-only compile; this takes its output and wraps it.
#
#   scripts/mac-bundle.sh [--capsule APP] [--tgz vyre.tgz] [--out DIR] [--cache DIR]
#
#   --capsule  the Capsule built by `local/capsule/native/build.sh app` (default: its .build/Vyre.app)
#   --tgz      the package to bundle, as `npm pack` makes it (default: npm pack this checkout)
#   --out      where Vyre.app is written (default: dist/mac-bundle)
#   --cache    where the Node tarball is kept between runs (default: $TMPDIR/vyre-node-cache)
#
# Signing: VYRE_SIGN_IDENTITY (a name or a SHA-1) and optionally VYRE_SIGN_KEYCHAIN. Without an
# identity everything is signed ad hoc, which is fine for a look inside but never for a release:
# TCC grants and vyred's capsule pin need the one CI certificate (docs/work/capsule-bundle.md).
#
# The layout:
#   Contents/MacOS/Vyre                              the Capsule
#   Contents/MacOS/node                              Node, from the official tarball (sha256 below)
#   Contents/Resources/vyre/                         the package: bin/, core/, local/, harness/, ...
#   Contents/Resources/vyre-launch.mjs               the LaunchAgent's entry: sets VYRE_HOME, starts vyred
#   Contents/Resources/bin/vyre                      the CLI, run by the bundled node
#   Contents/Library/LaunchAgents/sh.vyre.node.plist for SMAppService.agent(plistName:)
set -eu

NODE_VERSION=22.23.3
NODE_SHA256=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53 # node-v22.23.3-darwin-arm64.tar.gz

here="$(cd "$(dirname "$0")/.." && pwd)"
capsule="$here/local/capsule/native/.build/Vyre.app"
tgz=""
out="$here/dist/mac-bundle"
cache="${TMPDIR:-/tmp}/vyre-node-cache"
while [ $# -gt 0 ]; do
  case "$1" in
    --capsule) capsule="$2"; shift 2 ;;
    --tgz) tgz="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --cache) cache="$2"; shift 2 ;;
    *) echo "mac-bundle: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Darwin ] || { echo "mac-bundle: builds only on macOS (codesign)" >&2; exit 1; }
[ -x "$capsule/Contents/MacOS/Vyre" ] || { echo "mac-bundle: no Capsule at $capsule; run local/capsule/native/build.sh app first" >&2; exit 1; }

id="${VYRE_SIGN_IDENTITY:--}"
kc=""; [ -n "${VYRE_SIGN_KEYCHAIN:-}" ] && kc="--keychain $VYRE_SIGN_KEYCHAIN"
work="$(mktemp -d "${TMPDIR:-/tmp}/vyre-bundle.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# 1. Node: the official darwin-arm64 build, checked against the pinned sha256. Only bin/node and
# the license ship; npm, headers and docs stay out.
mkdir -p "$cache"
tarball="$cache/node-v$NODE_VERSION-darwin-arm64.tar.gz"
if [ ! -f "$tarball" ] || [ "$(shasum -a 256 "$tarball" | cut -d' ' -f1)" != "$NODE_SHA256" ]; then
  curl -fsSL -o "$tarball.part" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
  mv "$tarball.part" "$tarball"
fi
got="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
[ "$got" = "$NODE_SHA256" ] || { echo "mac-bundle: node tarball sha256 is $got, expected $NODE_SHA256" >&2; exit 1; }
tar -xzf "$tarball" -C "$work" "node-v$NODE_VERSION-darwin-arm64/bin/node" "node-v$NODE_VERSION-darwin-arm64/LICENSE"
nodedir="$work/node-v$NODE_VERSION-darwin-arm64"

# 2. The package: exactly the files npm publishes (package.json "files"), so the bundle and
# `npm i -g vyre` never disagree on what is runtime.
if [ -z "$tgz" ]; then
  tgz="$work/$(cd "$here" && npm pack --silent --pack-destination "$work" | tail -n 1)"
fi
mkdir -p "$work/pkg"
tar -xzf "$tgz" -C "$work/pkg"
pkg="$work/pkg/package"
# Runtime dependencies, when there are any (today there are none: vyre uses Node's built-ins).
if node -e 'const p=require(process.argv[1]);process.exit(Object.keys(p.dependencies||{}).length?0:1)' "$pkg/package.json"; then
  cp "$here/package-lock.json" "$pkg/"
  (cd "$pkg" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cpu arm64 --os darwin)
  rm -f "$pkg/package-lock.json"
fi
# Which commit this is, for /v1/health and `vyre status` (core/daemon/build.js), unless the
# release's tarball already carries it.
if [ ! -f "$pkg/build.json" ] && git -C "$here" rev-parse --verify HEAD >/dev/null 2>&1; then
  if [ -n "$(git -C "$here" status --porcelain --untracked-files=no)" ]; then dirty=true; else dirty=false; fi
  printf '{"version":"%s","commit":"%s","dirty":%s}\n' \
    "$(node -p 'require(process.argv[1]).version' "$pkg/package.json")" "$(git -C "$here" rev-parse HEAD)" "$dirty" >"$pkg/build.json"
fi

# 3. The bundle.
app="$out/Vyre.app"
rm -rf "$app"
mkdir -p "$out"
ditto "$capsule" "$app"
c="$app/Contents"
mkdir -p "$c/Resources/bin" "$c/Library/LaunchAgents"
cp "$nodedir/bin/node" "$c/MacOS/node"
cp "$nodedir/LICENSE" "$c/Resources/node-LICENSE"
ditto "$pkg" "$c/Resources/vyre"

# The CLI. It may be reached through a symlink on PATH, so it finds the bundle from its real path.
# It uses the same home as the LaunchAgent, so `vyre` in Terminal talks to the node the app runs.
cat >"$c/Resources/bin/vyre" <<'SH'
#!/bin/sh
# The vyre CLI inside Vyre.app: the bundled node runs the bundled package, never one on PATH.
f="$0"
while [ -L "$f" ]; do
  l="$(readlink "$f")"
  case "$l" in /*) f="$l" ;; *) f="$(dirname "$f")/$l" ;; esac
done
contents="$(cd "$(dirname "$f")/../.." && pwd)"
: "${VYRE_HOME:=$HOME/Library/Application Support/Vyre}"
export VYRE_HOME
exec "$contents/MacOS/node" "$contents/Resources/vyre/bin/vyre" "$@"
SH
chmod 755 "$c/Resources/bin/vyre"

# The LaunchAgent's entry. launchd neither expands ~ nor knows where the app was put, so the plist
# runs the bundled node with a one-line loader that finds this file next to itself.
cat >"$c/Resources/vyre-launch.mjs" <<'JS'
// The LaunchAgent's entry (Contents/Library/LaunchAgents/sh.vyre.node.plist): the home is in
// Application Support, and vyred knows launchd supervises it.
import os from "node:os";
import path from "node:path";
process.env.VYRE_HOME ||= path.join(os.homedir(), "Library", "Application Support", "Vyre");
process.env.VYRE_SUPERVISOR ||= "launchd";
await import("./vyre/core/daemon/main.js");
JS

# SMAppService.agent(plistName: "sh.vyre.node.plist") registers this; BundleProgram is relative to
# the bundle, and ProgramArguments[0] is only argv[0].
loader='import(require("node:url").pathToFileURL(require("node:path").join(process.execPath,"../../Resources/vyre-launch.mjs")).href)'
cat >"$c/Library/LaunchAgents/sh.vyre.node.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>sh.vyre.node</string>
  <key>BundleProgram</key><string>Contents/MacOS/node</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>-e</string>
    <string>$loader</string>
  </array>
  <key>AssociatedBundleIdentifiers</key><array><string>sh.vyre.capsule</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST
plutil -lint "$c/Library/LaunchAgents/sh.vyre.node.plist" >/dev/null

# 4. Signing, inside out: native addons, then node, then the app (which seals everything else).
# node keeps the hardened runtime and the entitlements it ships with (JIT needs them), so a later
# notarization needs no change here. The Capsule is signed as build.sh signs it.
# shellcheck disable=SC2086
find "$c/Resources/vyre" \( -name '*.node' -o -name '*.dylib' \) -type f | while read -r f; do
  codesign --force --sign "$id" $kc --timestamp=none --options runtime "$f"
done
codesign -d --entitlements - --xml "$nodedir/bin/node" >"$work/node.entitlements" 2>/dev/null || true
ent=""; [ -s "$work/node.entitlements" ] && ent="--entitlements $work/node.entitlements"
# shellcheck disable=SC2086
codesign --force --sign "$id" $kc --timestamp=none --options runtime $ent --identifier sh.vyre.node "$c/MacOS/node"
# shellcheck disable=SC2086
codesign --force --sign "$id" $kc --timestamp=none --identifier sh.vyre.capsule "$app"
codesign --verify --strict --deep "$app"
echo "mac-bundle: $app ($(du -sh "$app" | cut -f1), node $NODE_VERSION, signed by ${VYRE_SIGN_IDENTITY:-ad hoc})"
