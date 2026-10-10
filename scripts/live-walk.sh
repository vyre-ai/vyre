#!/bin/sh
# scripts/live-walk.sh OUT [--expect-version X.Y.Z] [--channel beta]: the live droplet walk with its secrets read from ~/.live-env and the file removed at once, even when the walk fails early.
# ~/.live-env: line 1 the DigitalOcean token, line 2 the names directory's admin secret, line 3 (optional) a Claude subscription token for the chat step. Nothing is echoed. When the walk has ended, the
# runner's own log and the output folder are searched for the first 12 characters of the Claude token and the answer is printed (absent / FOUND, never the characters).
set -u
out=${1:?usage: live-walk.sh OUT [walk options]}; shift
env_file=$HOME/.live-env
trap 'rm -f "$env_file"' EXIT INT TERM HUP
{ read -r DIGITALOCEAN_TOKEN; read -r VYRE_NAMES_ADMIN_SECRET; read -r RC_CLAUDE_TOKEN || RC_CLAUDE_TOKEN=; } < "$env_file"
rm -f "$env_file"
export DIGITALOCEAN_TOKEN VYRE_NAMES_ADMIN_SECRET
if [ -n "$RC_CLAUDE_TOKEN" ]; then export RC_CLAUDE_TOKEN; else unset RC_CLAUDE_TOKEN; fi
mkdir -p "$out"
head12=$(printf %s "${RC_CLAUDE_TOKEN:-}" | cut -c1-12)
cd "$(dirname "$0")/.." || exit 1
node "scripts/${WALK_SCRIPT:-proof-live-droplet.mjs}" --out "$out" "$@" > "$out/walk.log" 2>&1
code=$?
if [ -n "$head12" ]; then
  if grep -rqF -- "$head12" "$out" 2>/dev/null; then echo "token check: FOUND the Claude token's first 12 characters in $out"; code=97; else echo "token check: the Claude token's first 12 characters are absent from the walk log and output"; fi
fi
[ ! -e "$env_file" ] && echo "secrets file: removed"
tail -n 40 "$out/walk.log"
exit $code
