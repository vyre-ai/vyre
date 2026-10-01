#!/bin/sh
# release-check.sh: everything that must hold before a release goes out.
#
#   scripts/release-check.sh [--skip-tests] [--skip-perf] [--claude] [--live]
#
#   1. the suite (npm test) and scripts/perf-check (idle budgets, SPEC section 2 principle 8;
#      about a minute), unless --skip-tests or --skip-perf
#   2. docs-check --release: the docs tree is clean and no screenshot is older than the code it shows
#   3. npm pack, and the tarball holds what it should and nothing it should not
#   4. a global install of that tarball into a temp prefix, never the real one
#   5. vyre up, status, modules, call and down, in a temp HOME and VYRE_HOME
#   6. the Harness from the installed folder: its MCP server lists tools over stdio, and with
#      --claude a real `claude -p --plugin-dir` session calls one (uses your Claude sign-in)
#   7. site/box (from scripts/build-site.sh): every file there matches SHA256SUMS, and vyre.tgz
#      is this version; with --live, https://vyre.run/box serves exactly those bytes
#
# Nothing outside the temp folders is written, except the one throwaway session transcript
# --claude makes under ~/.claude/projects, which it deletes. Exits non-zero at the first failure.
set -eu

TESTS=1
PERF=1
CLAUDE=0
LIVE=0
for a in "$@"; do
  case "$a" in
    --skip-tests) TESTS=0 ;;
    --skip-perf) PERF=0 ;;
    --claude) CLAUDE=1 ;;
    --live) LIVE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
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
  # npm test's own command, with a per-test timeout, so a test that hangs fails with its name
  # instead of holding the release open (a daemon test once hung for 20 minutes under load).
  cmd=$(node -e 'process.stdout.write(require(process.argv[1]).scripts.test.replace(/^node --test /, "node --test --test-timeout=180000 "))' "$repo/package.json")
  (cd "$repo" && sh -c "$cmd" >"$work/test.log" 2>&1) || { grep -B2 -A12 -E '^✖|failing tests' "$work/test.log" | tail -n 60; fail "the suite (log above)"; }
  ok "$(grep -E '^[^ ]+ (tests|pass|fail) ' "$work/test.log" | tr '\n' ' ')"
fi

step "docs"
# Stale screenshots only warn while people work; they block a release (docs-check --release).
(cd "$repo" && node scripts/docs-check --release >"$work/docs.log" 2>&1) || { tail -n 30 "$work/docs.log"; fail "docs-check --release (log above; run npm run docs:shots for stale screenshots)"; }
ok "docs are clean, screenshots are fresh"

if [ "$PERF" = 1 ]; then
  step "perf"
  (cd "$repo" && nice -n 10 node scripts/perf-check >"$work/perf.log" 2>&1) || { tail -n 30 "$work/perf.log"; fail "perf-check (log above)"; }
  ok "idle budgets hold"
fi

step "pack"
name=$(cd "$repo" && npm pack --silent --pack-destination "$work" | tail -n 1)
tgz=$work/$name
tar -tzf "$tgz" | sed 's|^package/||' >"$work/files"
ok "$name, $(wc -l <"$work/files" | tr -d ' ') files, $(du -k "$tgz" | cut -f1) KB"
for want in bin/vyre core/daemon/main.js core/cli/index.js harness/.claude-plugin/plugin.json \
  harness/.mcp.json harness/hooks/hooks.json harness/mcp/server.js deck/index.html scripts/install-box.sh lib/theme/tokens.json LICENSE package.json; do
  grep -qx "$want" "$work/files" || fail "the tarball has no $want"
done
ok "has the bin, core, the Harness plugin, the Deck, the design tokens and the box installer"
# The web app vyred serves at /app/ (ADR 0027): build-site.sh exports it (scripts/build-app.sh).
if [ -f "$repo/apps/app/package.json" ]; then
  for want in apps/app/dist/index.html apps/app/dist/precache.json; do
    grep -qx "$want" "$work/files" || fail "the tarball has no $want (run scripts/build-app.sh before npm pack)"
  done
  grep -q '^apps/app/\(src\|node_modules\)/' "$work/files" && fail "the tarball carries the app's source or node_modules, only apps/app/dist belongs"
  if [ -d "$repo/apps/app/dist" ]; then
    missing=$(cd "$repo/apps/app/dist" && find . -type f | sed 's|^\./|apps/app/dist/|' | grep -vxF -f "$work/files" || true)
    [ -z "$missing" ] || fail "npm pack left out these files of apps/app/dist: $missing"
  fi
  ok "has the web app for /app/ ($(grep -c '^apps/app/dist/' "$work/files") files)"
fi
if grep -E '(\.test\.js$|(^|/)fixtures/|(^|/)testing(/|\.js$)|node_modules/|^docs/(design|work|proposals)/|^docs/.*\.png$|^local/capsule/native/(\.build|Tests)/|\.DS_Store$|(^|/)\.env)' "$work/files"; then
  fail "the tarball carries the files above, which it should not"
fi
ok "no tests, fixtures, test helpers, design docs, docs screenshots, build output or env files"
# "files" takes whole folders, so a gitignored file left in the tree (a Mac build output in
# local/capsule/bin, say) would ship. build.json and apps/app/dist are made for the pack on purpose.
ignored=$(cd "$repo" && node --input-type=module -e '
  const { ignoredShipped } = await import("./scripts/lib/pack-imports.mjs");
  const fs = await import("node:fs");
  const r = ignoredShipped(process.cwd(), fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean));
  process.stdout.write(r === null ? "-" : r.join("\n"));
' "$work/files") || fail "could not check the pack against .gitignore"
if [ "$ignored" = "-" ]; then ok "not a git checkout: the .gitignore check is skipped"
else [ -z "$ignored" ] || { echo "$ignored"; fail "the tarball carries the gitignored files above (clean the tree, or exclude them in package.json \"files\")"; }
  ok "nothing gitignored in the tarball"; fi
node -e '
  const p = require(process.argv[1]);
  if (Object.keys(p.dependencies || {}).length) throw new Error("regular dependencies: " + Object.keys(p.dependencies));
  // The embedder is fetched on first use (core/recall/embed.js), never by npm i -g.
  if (Object.keys(p.optionalDependencies || {}).length) throw new Error("optional dependencies: " + Object.keys(p.optionalDependencies));
  if (p.bin.vyre !== "bin/vyre") throw new Error("bin.vyre is " + p.bin.vyre);
' "$repo/package.json" || fail "package.json"
ok "no dependencies at all; the embedder is fetched on first use"

step "install into a temp prefix"
npm i -g --prefix "$work/prefix" --no-audit --no-fund "$tgz" >"$work/install.log" 2>&1 || { cat "$work/install.log"; fail "npm i -g"; }
vyre=$work/prefix/bin/vyre
pkg=$work/prefix/lib/node_modules/vyre
[ -x "$vyre" ] || fail "no vyre in $work/prefix/bin"
kb=$(du -sk "$work/prefix" | cut -f1)
[ ! -d "$pkg/node_modules" ] || fail "npm i -g installed dependencies: $(ls "$pkg/node_modules" | tr '\n' ' ')"
# 20 MB for 0.1.0: batch 4 installs 16.6 MB with the web app (apps/app/dist, 2.6 MB, served at
# /app/); before it 12.7 MB. The generated docs index and reference (about 1.8 MB) are the 0.1.1
# candidate to move out. box-image.yml prints the size every run. Before that, 12 MB: real code growth (memory/personal, the Mac apps module, relay, resilience) plus the docs
# and docs/index.json, which scripts and agents read offline. du counts a block per file, so 670
# small files cost more here than in the 2.5 MB tarball. A dependency or build output coming back
# would add tens of MB; design docs and screenshots are kept out above.
[ "$kb" -lt 20480 ] || fail "npm i -g installs $kb KB; it should be a few MB (did a dependency or a build output come back?)"
ok "$(du -sh "$work/prefix" | cut -f1) installed at $work/prefix"
# 0.1.0-rc.1 installed without packages/module-sdk, which a CLI command imports: every `vyre`
# died with ERR_MODULE_NOT_FOUND. So every relative import must name a shipped file, every CLI
# command must load from the installed folder, and `vyre --version` must answer, before vyre up.
node "$repo/scripts/lib/pack-imports.mjs" "$pkg" || fail "the installed package imports files it does not ship"
(cd "$work" && node --input-type=module -e '
  const fs = await import("node:fs"); const path = await import("node:path"); const { pathToFileURL } = await import("node:url");
  const dir = path.join(process.argv[1], "core/cli/commands");
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".js"))) await import(pathToFileURL(path.join(dir, f)).href);
' "$pkg") || fail "a CLI command does not load from the installed folder"
v=$(HOME=$home VYRE_HOME=$home/.vyre VYRE_NO_DIALOGS=1 "$vyre" --version 2>&1) || { echo "$v"; fail "vyre --version"; }
echo "$v" | grep -q "$version" || fail "vyre --version says $v, not $version"
ok "every import is shipped, every CLI command loads, vyre --version is $version"

step "vyre up, status, down"
mkdir -p "$home/.vyre"
# No transcripts to index, and no Capsule or hands, which reach into the desktop.
printf '%s\n' '{"transcripts":[],"vault":{"keystore":"file"},"modules":{"disable":["capsule","hands"]}}' >"$home/.vyre/config.json"
run() { (cd "$home" && HOME=$home VYRE_HOME=$home/.vyre VYRE_NO_DIALOGS=1 PATH="$work/prefix/bin:$PATH" "$vyre" "$@"); }
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
grep -qx '/box /box/install-box.sh 200' "$repo/site/_redirects" || fail "site/_redirects does not send /box to install-box.sh"
grep -qx '/download/mac /start#mac 302' "$repo/site/_redirects" || fail "site/_redirects does not send /download/mac to /start#mac"
# The Capsule zip is retired: the Mac installs from npm and builds the Capsule there.
if grep -rIl 'Vyre-mac\.zip' "$repo/site" "$box" >/dev/null 2>&1 || tar -tzf "$box/vyre.tgz" | grep -q '^package/box/Vyre-mac\.sha256$'; then
  fail "the retired Capsule zip is still referenced: $(grep -rIl 'Vyre-mac\.zip' "$repo/site" "$box" 2>/dev/null | tr '\n' ' ')"
fi
# /start is served as committed: nothing between the checkout and the site rewrote it.
if git -C "$repo" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$repo" diff --quiet HEAD -- site/start || fail "site/start differs from what is committed"
fi
ok "_redirects sends /box and /download/mac; no Capsule zip; /start is as committed"

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
  code=$(curl -sL -o /dev/null -w '%{http_code}' "$base/start")
  [ "$code" = 200 ] || fail "$base/start answers $code"
  code=$(curl -s -o "$work/box-alias" -w '%{http_code}' "$base/box")
  { [ "$code" = 200 ] && cmp -s "$work/box-alias" "$box/install-box.sh"; } || fail "$base/box is not install-box.sh ($code)"
  curl -fsSL "$base/start/" | cmp -s - "$repo/site/start/index.html" || fail "$base/start is not site/start/index.html"
  ok "every file is served byte for byte; install.sh, /start and 404 are right"
fi

printf '\nrelease-check: all good for vyre %s\n' "$version"
