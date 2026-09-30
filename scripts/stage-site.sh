#!/bin/sh
# stage-site.sh: a copy of the built site for a STAGING deploy, with the setup page pointed at another relay and install line.
#
#   scripts/stage-site.sh --out DIR [--relay wss://HOST] [--install-url https://HOST/i] [--site DIR]
#   (or VYRE_SETUP_RELAY and VYRE_SETUP_INSTALL_URL in the environment; a loopback ws:// relay and http:// install URL are
#    accepted for a test runner's own machine)
#
# Run scripts/build-site.sh first. This never changes site/ itself: it copies it to DIR and, there only,
#   - writes setup/config.json {relay, installUrl}, which site/setup/config.js checks and site/setup/page.js reads
#     (production has no such file, so production stays exactly as it is), and
#   - widens the setup page's Content-Security-Policy (_headers) to the staging relay's origins.
# With neither option the copy is the site as built.
#
# Deploy the copy to the staging branch alias, never main:
#   scripts/deploy-site.sh DIR --branch staging
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
out=""; relay=${VYRE_SETUP_RELAY:-}; install=${VYRE_SETUP_INSTALL_URL:-}; site="$here/site"
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
[ -d "$site/setup/relay" ] || { echo "stage-site: run scripts/build-site.sh first ($site/setup/relay is missing)" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out"
cp -R "$site/." "$out/"
if [ -n "$relay" ] || [ -n "$install" ]; then
  # The values are checked by the very code the page runs (site/setup/config.js), for a staging hostname: what it would ignore is
  # refused here, not written. (A shell pattern would let ws://127.0.0.1.evil.example through.)
  node --input-type=module -e '
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    const [here, out, relay, install] = process.argv.slice(1);
    const { setupOverrides } = await import(pathToFileURL(here + "/site/setup/config.js").href);
    const want = {};
    if (relay) want.relay = relay;
    if (install) want.installUrl = install;
    const got = setupOverrides(want, "staging.vyre-site.pages.dev");
    for (const k of Object.keys(want)) {
      if (got[k] !== want[k]) { console.error("stage-site: " + (k === "relay" ? "the relay" : "the install URL") + " " + want[k] + " is not one the page would take (a wss:// relay or https:// install URL on vyre.run or pages.dev, or a loopback ws:// / http:// one)"); process.exit(1); }
    }
    fs.writeFileSync(out + "/setup/config.json", JSON.stringify(got) + "\n");
    if (got.relay) {
      const https = got.relay.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
      const f = out + "/_headers", h = fs.readFileSync(f, "utf8");
      const from = "connect-src \x27self\x27 https://relay.vyre.run wss://relay.vyre.run;";
      if (!h.includes(from)) { console.error("stage-site: _headers has no connect-src line to widen"); process.exit(1); }
      fs.writeFileSync(f, h.replace(from, "connect-src \x27self\x27 https://relay.vyre.run wss://relay.vyre.run " + https + " " + got.relay + ";"));
    }
    console.log("stage-site: wrote setup/config.json " + JSON.stringify(got));
  ' "$here" "$out" "$relay" "$install" || { rm -rf "$out"; exit 1; }
fi
echo "stage-site: $out ($( [ -n "$relay" ] && echo "relay $relay" || echo "the production relay" ), $( [ -n "$install" ] && echo "install line $install" || echo "the production install line" ))"
