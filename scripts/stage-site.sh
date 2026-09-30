#!/bin/sh
# stage-site.sh: a copy of the built site for a STAGING deploy, with the setup page pointed at another relay and install line.
#
#   scripts/stage-site.sh --out DIR [--relay wss://HOST] [--install-url https://HOST/i] [--site DIR]
#
# Run scripts/build-site.sh first. This never changes site/ itself: it copies it to DIR and, there only,
#   - writes setup/config.json {relay, installUrl}, which site/setup/config.js checks and site/setup/page.js reads
#     (production has no such file, so production stays exactly as it is), and
#   - widens the setup page's Content-Security-Policy (_headers) to the staging relay's origins.
# With neither option the copy is the site as built.
#
# Deploy the copy to the staging branch alias, never main:
#   npx wrangler pages deploy DIR --project-name vyre-site --branch staging
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
out=""; relay=""; install=""; site="$here/site"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "stage-site: --out needs a folder" >&2; exit 1; }; out=$2; shift ;;
    --relay) [ $# -ge 2 ] || { echo "stage-site: --relay needs a wss:// address" >&2; exit 1; }; relay=$2; shift ;;
    --install-url) [ $# -ge 2 ] || { echo "stage-site: --install-url needs an https:// address" >&2; exit 1; }; install=$2; shift ;;
    --site) [ $# -ge 2 ] || { echo "stage-site: --site needs a folder" >&2; exit 1; }; site=$2; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "stage-site: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
[ -n "$out" ] || { echo "stage-site: --out DIR is required" >&2; exit 1; }
case "$relay" in ""|wss://*) ;; *) echo "stage-site: the relay is a wss:// address" >&2; exit 1 ;; esac
case "$install" in ""|https://*) ;; *) echo "stage-site: the install URL is an https:// address" >&2; exit 1 ;; esac
[ -d "$site/setup/relay" ] || { echo "stage-site: run scripts/build-site.sh first ($site/setup/relay is missing)" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
cp -R "$site/." "$out/"
if [ -n "$relay" ] || [ -n "$install" ]; then
  node -e '
    const fs = require("fs"), [out, relay, install] = process.argv.slice(1);
    const cfg = {};
    if (relay) cfg.relay = relay;
    if (install) cfg.installUrl = install;
    fs.writeFileSync(out + "/setup/config.json", JSON.stringify(cfg) + "\n");
    if (relay) {
      const https = relay.replace(/^wss:/, "https:");
      const f = out + "/_headers", h = fs.readFileSync(f, "utf8");
      const from = "connect-src \x27self\x27 https://relay.vyre.run wss://relay.vyre.run;";
      if (!h.includes(from)) { console.error("stage-site: _headers has no connect-src line to widen"); process.exit(1); }
      fs.writeFileSync(f, h.replace(from, "connect-src \x27self\x27 https://relay.vyre.run wss://relay.vyre.run " + https + " " + relay + ";"));
    }
  ' "$out" "$relay" "$install"
fi
echo "stage-site: $out ($( [ -n "$relay" ] && echo "relay $relay" || echo "the production relay" ), $( [ -n "$install" ] && echo "install line $install" || echo "the production install line" ))"
