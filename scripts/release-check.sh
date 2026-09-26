#!/bin/sh
# release-check.sh: everything that must hold before a release goes out.
#
#   scripts/release-check.sh [--skip-tests] [--claude] [--live]
#
#   1. the suite (npm test), unless --skip-tests
#   2. npm pack, and the tarball holds what it should and nothing it should not
#   3. a global install of that tarball into a temp prefix, never the real one
#   4. vyre up, status, modules, call and down, in a temp HOME and VYRE_HOME
#   5. the Harness from the installed folder: its MCP server lists tools over stdio, and with
#      --claude a real `claude -p --plugin-dir` session calls one (uses your Claude sign-in)
#   6. site/box (from scripts/build-site.sh): every file there matches SHA256SUMS, and vyre.tgz
#      is this version; with --live, https://vyre.run/box serves exactly those bytes
#
# Nothing outside the temp folders is written, except the one throwaway session transcript
# --claude makes under ~/.claude/projects, which it deletes. Exits non-zero at the first failure.
set -eu

TESTS=1
CLAUDE=0
LIVE=0
for a in "$@"; do
  case "$a" in
    --skip-tests) TESTS=0 ;;
    --claude) CLAUDE=1 ;;
    --live) LIVE=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "release-check: unknown option $a" >&2; exit 1 ;;
  esac
done

repo=$(cd "$(dirname "$0")/.." && pwd)
base=${VYRE_SITE:-https://vyre.run}
work=$(mktemp -d "${TMPDIR:-/tmp}/vyre-release.XXXXXX")
# Short, so vyred's socket fits in a unix socket path.
home=$(mktemp -d /tmp/vyre-rc.XXXXXX)
vyre=""
cleanup() {
  if [ -n "$vyre" ] && [ -x "$vyre" ]; then HOME=$home VYRE_HOME=$home/.vyre "$vyre" down >/dev/null 2>&1 || true; fi
  rm -rf "$work" "$home"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok  %s\n' "$*"; }
fail() { printf '   FAIL  %s\n' "$*" >&2; exit 1; }
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

version=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$repo/package.json")

if [ "$TESTS" = 1 ]; then
  step "suite"
  (cd "$repo" && npm test >"$work/test.log" 2>&1) || { tail -n 40 "$work/test.log"; fail "npm test (log above)"; }
  ok "$(grep -E '^[^ ]+ (tests|pass|fail) ' "$work/test.log" | tr '\n' ' ')"
fi

step "pack"
name=$(cd "$repo" && npm pack --silent --pack-destination "$work" | tail -n 1)
tgz=$work/$name
tar -tzf "$tgz" | sed 's|^package/||' >"$work/files"
ok "$name, $(wc -l <"$work/files" | tr -d ' ') files, $(du -k "$tgz" | cut -f1) KB"
for want in bin/vyre core/daemon/main.js core/cli/index.js harness/.claude-plugin/plugin.json \
  harness/.mcp.json harness/hooks/hooks.json harness/mcp/server.js deck/index.html LICENSE package.json; do
  grep -qx "$want" "$work/files" || fail "the tarball has no $want"
done
ok "has the bin, core, the Harness plugin and the Deck"
if grep -E '(\.test\.js$|(^|/)fixtures/|(^|/)testing(/|\.js$)|node_modules/|^docs/(design|work)/|^local/capsule/(dist|bin)/|\.DS_Store$|(^|/)\.env)' "$work/files"; then
  fail "the tarball carries the files above, which it should not"
fi
ok "no tests, fixtures, test helpers, design boards, build output or env files"
node -e '
  const p = require(process.argv[1]);
  if (Object.keys(p.dependencies || {}).length) throw new Error("regular dependencies: " + Object.keys(p.dependencies));
  if (!p.optionalDependencies || !p.optionalDependencies["@huggingface/transformers"]) throw new Error("the embedder is not an optional dependency");
  if (p.bin.vyre !== "bin/vyre") throw new Error("bin.vyre is " + p.bin.vyre);
' "$repo/package.json" || fail "package.json"
ok "no required dependencies; the embedder stays optional"

step "install into a temp prefix"
npm i -g --prefix "$work/prefix" --no-audit --no-fund "$tgz" >"$work/install.log" 2>&1 || { cat "$work/install.log"; fail "npm i -g"; }
vyre=$work/prefix/bin/vyre
pkg=$work/prefix/lib/node_modules/vyre
[ -x "$vyre" ] || fail "no vyre in $work/prefix/bin"
ok "$(du -sh "$work/prefix" | cut -f1) installed at $work/prefix"

step "vyre up, status, down"
mkdir -p "$home/.vyre"
# No transcripts to index, and no Capsule or hands, which reach into the desktop.
printf '%s\n' '{"transcripts":[],"modules":{"disable":["capsule","hands"]}}' >"$home/.vyre/config.json"
run() { (cd "$home" && HOME=$home VYRE_HOME=$home/.vyre PATH="$work/prefix/bin:$PATH" "$vyre" "$@"); }
run up >"$work/up.log" 2>&1 || { cat "$work/up.log"; fail "vyre up"; }
ok "up: $(head -n 1 "$work/up.log" | sed 's/^ *//')"
run status >"$work/status.log" 2>&1 || { cat "$work/status.log"; fail "vyre status"; }
grep -q "running" "$work/status.log" || { cat "$work/status.log"; fail "vyre status does not say running"; }
grep -q "$version" "$work/status.log" || { cat "$work/status.log"; fail "vyre status is not $version"; }
ok "status: $(head -n 1 "$work/status.log" | sed 's/^ *//')"
run modules >"$work/modules.log" 2>&1 || fail "vyre modules"
grep -Eq 'failed|error' "$work/modules.log" && { cat "$work/modules.log"; fail "a module did not start"; }
ok "$(grep -c running "$work/modules.log" | tr -d " ") modules running"
run call system.echo '{"text":"release-check"}' >"$work/call.log" 2>&1 || { cat "$work/call.log"; fail "vyre call"; }
grep -q release-check "$work/call.log" || { cat "$work/call.log"; fail "system.echo did not echo"; }
ok "vyre call system.echo answers"

step "the Harness from the installed folder"
mcp_in='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-check","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
( printf '%s\n' "$mcp_in"; sleep 3 ) | (cd "$home" && HOME=$home VYRE_HOME=$home/.vyre CLAUDE_PLUGIN_ROOT=$pkg/harness node "$pkg/harness/mcp/server.js") >"$work/mcp.log" 2>&1 || true
grep -q '"system_echo"' "$work/mcp.log" || { head -c 2000 "$work/mcp.log"; fail "the MCP server did not list system_echo"; }
ok "MCP server lists $(grep -o '"name":"[a-z_]*"' "$work/mcp.log" | wc -l | tr -d ' ') tools"
if [ "$CLAUDE" = 1 ]; then
  command -v claude >/dev/null 2>&1 || fail "--claude needs claude on PATH"
  mkdir -p "$home/session"
  # The real HOME, for the Claude sign-in; vyred stays in the temp VYRE_HOME.
  res=$(cd "$home/session" && VYRE_HOME=$home/.vyre claude -p --plugin-dir "$pkg/harness" --model claude-haiku-4-5-20251001 \
    --allowedTools 'mcp__plugin_vyre_vyre__system_echo' --output-format json \
    "Call the vyre MCP tool system_echo with text 'plugin-ok'. Reply with only the tool's result." 2>&1 || true)
  real=$(cd "$home/session" && pwd -P)
  rm -rf "$HOME/.claude/projects/$(printf '%s' "$real" | sed 's|[^A-Za-z0-9]|-|g')"
  printf '%s' "$res" | grep -q plugin-ok || { printf '%s\n' "$res" | head -c 1500; fail "claude --plugin-dir did not reach the vyre tools"; }
  ok "claude --plugin-dir $pkg/harness calls system_echo"
fi
run down >/dev/null 2>&1 || fail "vyre down"
run status >/dev/null 2>&1 && fail "vyred still running after vyre down"
ok "down"

step "site/box"
box=$repo/site/box
[ -f "$box/SHA256SUMS" ] || fail "no site/box/SHA256SUMS; run scripts/build-site.sh first"
(cd "$box" && sum -c --quiet SHA256SUMS) || fail "site/box does not match its SHA256SUMS"
for f in install-box.sh vyre compose.yml compose.build.yml vyre.env.example Dockerfile vyre.tgz VERSION; do
  grep -q "  $f\$" "$box/SHA256SUMS" || fail "SHA256SUMS does not list $f"
done
[ "$(cat "$box/VERSION")" = "$version" ] || fail "site/box is $(cat "$box/VERSION"), this checkout is $version"
tar -xzOf "$box/vyre.tgz" package/package.json | grep -q "\"version\": \"$version\"" || fail "vyre.tgz is not $version"
tar -tzf "$box/vyre.tgz" | grep -q '^package/box/Dockerfile$' || fail "vyre.tgz has no box/Dockerfile, which the image build needs"
cmp -s "$box/install-box.sh" "$repo/site/install.sh" || fail "site/install.sh differs from site/box/install-box.sh"
sh -n "$box/install-box.sh" || fail "install-box.sh does not parse"
sh -n "$box/vyre" || fail "the box wrapper does not parse"
ok "$(wc -l <"$box/SHA256SUMS" | tr -d ' ') files match SHA256SUMS; vyre.tgz is $version"
if [ -f "$box/Vyre-mac.zip" ]; then
  unzip -l "$box/Vyre-mac.zip" | grep -q 'Vyre.app/Contents/Info.plist' || fail "Vyre-mac.zip has no Vyre.app"
  ok "Vyre-mac.zip holds Vyre.app"
fi

if [ "$LIVE" = 1 ]; then
  step "live at $base"
  curl -fsSL "$base/box/SHA256SUMS" -o "$work/live.sums" || fail "cannot fetch $base/box/SHA256SUMS"
  cmp -s "$work/live.sums" "$box/SHA256SUMS" || fail "$base/box/SHA256SUMS differs from site/box; deploy the site"
  mkdir -p "$work/live"
  while read -r _ f; do
    mkdir -p "$work/live/$(dirname "$f")"
    curl -fsSL "$base/box/$f" -o "$work/live/$f" || fail "cannot fetch $base/box/$f"
  done <"$box/SHA256SUMS"
  (cd "$work/live" && sum -c --quiet "$box/SHA256SUMS") || fail "$base/box serves different bytes"
  curl -fsSL "$base/install.sh" | cmp -s - "$box/install-box.sh" || fail "$base/install.sh is not install-box.sh"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$base/box/no-such-file")
  [ "$code" = 404 ] || fail "$base answers a missing file with $code, not 404"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$base/start")
  [ "$code" = 200 ] || fail "$base/start answers $code"
  code=$(curl -s -o "$work/box-alias" -w '%{http_code}' "$base/box")
  { [ "$code" = 200 ] && cmp -s "$work/box-alias" "$box/install-box.sh"; } || fail "$base/box is not install-box.sh ($code)"
  ok "every file is served byte for byte; install.sh, /start and 404 are right"
fi

printf '\nrelease-check: all good for vyre %s\n' "$version"
