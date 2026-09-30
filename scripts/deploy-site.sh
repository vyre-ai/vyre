#!/bin/sh
# deploy-site.sh: put a built site folder on Cloudflare Pages (project vyre-site), with two refusals built in.
#
#   scripts/deploy-site.sh DIR --branch main|staging [--project NAME]
#
# --branch main is production (vyre.run): it refuses a folder that contains setup/config.json, since a staging copy
# (scripts/stage-site.sh) must never reach that origin, and the page would ignore it there anyway. Any other branch is a preview
# alias (https://<branch>.vyre-site.pages.dev). Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.
# VYRE_WRANGLER replaces `npx --yes wrangler@latest` (tests).
set -eu
dir=""; branch=""; project=vyre-site
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) [ $# -ge 2 ] || { echo "deploy-site: --branch needs a name" >&2; exit 1; }; branch=$2; shift ;;
    --project) [ $# -ge 2 ] || { echo "deploy-site: --project needs a name" >&2; exit 1; }; project=$2; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) echo "deploy-site: unknown option $1" >&2; exit 1 ;;
    *) dir=$1 ;;
  esac
  shift
done
[ -d "$dir" ] || { echo "deploy-site: give the built site folder" >&2; exit 1; }
[ -n "$branch" ] || { echo "deploy-site: --branch is required (main is production; anything else is a preview)" >&2; exit 1; }
case "$branch" in *[!A-Za-z0-9._-]*) echo "deploy-site: a plain branch name" >&2; exit 1 ;; esac
if [ "$branch" = main ] && [ -e "$dir/setup/config.json" ]; then
  echo "deploy-site: $dir/setup/config.json is a staging override; it does not go to production (--branch main)" >&2
  exit 1
fi
if [ -n "${VYRE_WRANGLER:-}" ]; then
  # shellcheck disable=SC2086 # the override is a command line
  exec $VYRE_WRANGLER pages deploy "$dir" --project-name "$project" --branch "$branch"
fi
exec npx --yes wrangler@latest pages deploy "$dir" --project-name "$project" --branch "$branch"
