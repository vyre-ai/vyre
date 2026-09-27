#!/bin/sh
# rc-smoke.sh <vyre.tgz>: the release smoke check. It walks the path a person takes on the night
# of a release, on a throwaway box built from the given package, with fakes only: no real Claude,
# no real mail, no tailnet, no network in the box. box-deploy runs it as the gate before a
# redeploy. Each step prints pass, FAIL or skip; the exit code is 1 when any step failed.
#
#   1 install        the package's installer (dry run) and the box image built from the package
#   2 vyred up       the box container starts and vyred answers
#   3 vault          the Claude sign-in through onboard.claude, with a fake `claude setup-token`:
#                    the token lands in the vault and never in an answer
#   4 phone          the phone app at /app/ loads; pairing a phone needs the tailnet, so the
#                    headscale gate (scripts/e2e-headscale) covers enrolment, not this
#   5 memory         a question on a synthetic world (test/fixtures/personal-world.js) is answered
#                    with its sources, and one it cannot know is not answered
#   6 mail           an IMAP account added through vault.connect (made-up hosts, no server),
#                    then mail.send is held at the Gate and the password never comes back
#   7 theme          settings.set appearance.tokens changes /theme.css
#   8 update         box/vyre's `vyre update` to a fake next release (the same package, one
#                    patch version on), then `vyre update --rollback` back; the vault item from
#                    step 3 survives both
#
# Run on the test server from a checkout (the fakes and the synthetic world come from it), never
# against /srv/vyre: every container, volume and image is named rc-smoke-<pid> and removed at the
# end, the box runs with --network none, and the wrapper's docker calls go through a shim that maps
# its fixed image names (vyre:local, vyre:prev) to the smoke's own. No port is published.
#
# Environment: RC_KEEP=1 leaves the throwaway in place for a look (remove it with the printed line).

set -u
[ $# -eq 1 ] && [ -f "$1" ] || { echo "usage: rc-smoke.sh <vyre.tgz>" >&2; exit 2; }
TGZ=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$HERE")
H=$HERE/rc-smoke
ID=rc-smoke-$$
C=$ID-box
V=$ID-home
W=$(mktemp -d "${TMPDIR:-/tmp}/$ID.XXXXXX")
RC_DOCKER=$(command -v docker) || { echo "rc-smoke: needs docker" >&2; exit 2; }
command -v node >/dev/null || { echo "rc-smoke: needs node" >&2; exit 2; }
export RC_DOCKER RC_ID="$ID" RC_C="$C" RC_RUN="$W/run" RC_LOG="$W/docker.log"
SITE_PID=""
PASS=0 FAILS=0 SKIPS=0

cleanup() {
  [ -n "$SITE_PID" ] && kill "$SITE_PID" 2>/dev/null
  if [ "${RC_KEEP:-}" = 1 ]; then
    echo "kept: docker rm -f $C; docker volume rm $V; docker image rm $ID:local $ID:prev $ID:next; rm -rf $W"
    return
  fi
  "$RC_DOCKER" rm -f "$C" >/dev/null 2>&1
  "$RC_DOCKER" ps -aq --filter "label=run.vyre.rc-smoke=$ID" | xargs -r "$RC_DOCKER" rm -f >/dev/null 2>&1
  "$RC_DOCKER" volume rm "$V" >/dev/null 2>&1
  for t in local prev next; do "$RC_DOCKER" image rm "$ID:$t" >/dev/null 2>&1; done
  rm -rf "$W"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

pass() { PASS=$((PASS + 1)); echo "pass  $*"; }
fail() { FAILS=$((FAILS + 1)); echo "FAIL  $*"; }
skip() { SKIPS=$((SKIPS + 1)); echo "skip  $*"; }
# One line of what came back, for a FAIL: never more than 300 characters.
short() { tr '\n' ' ' | cut -c1-300; }
j() { node "$H/jq.mjs" "$1"; }
# A tool call on the box, as the person at its command line.
vc() { "$RC_DOCKER" exec -u vyre "$C" vyre call "$@" 2>&1; }
# The tool is on this box?
has() { ! vc "$1" '{}' | grep -q 'no_such_tool'; }
get() { "$RC_DOCKER" exec -u vyre "$C" node /opt/rc/get.js "$1"; }
# vyred's pid when `vyre status` says running, else nothing.
upid() { "$RC_DOCKER" exec -u vyre "$C" vyre status 2>/dev/null | grep -i running | sed -n 's/.*pid \([0-9][0-9]*\).*/\1/p' | head -1; }
# Up and settled: running with the same pid 3 s apart, so a vyred the loop is still replacing (a
# first start that exits "already running", then the loop's 2 s pause) is not taken for ready.
ready() {
  i=0
  while :; do
    a=$(upid)
    if [ -n "$a" ]; then sleep 3; i=$((i + 3)); [ "$(upid)" = "$a" ] && return 0; fi
    i=$((i + 1)); [ $i -ge "${1:-90}" ] && return 1; sleep 1
  done
}

# The box container, as box/compose.yml runs vyre (the uid split, tini, the spawner), without a
# network, a published port or the host's docker. The fakes are mounted read-only at /opt/rc.
cat >"$W/run" <<EOF
#!/bin/sh
# run [--once [-u U] [-e K=V]...] IMAGE [CMD...]: the smoke's box container, or a one-off of it.
once=0; extra=""
if [ "\${1:-}" = --once ]; then once=1; shift
  while [ \$# -gt 0 ]; do case "\$1" in -u|-e) extra="\$extra \$1 \$2"; shift 2 ;; *) break ;; esac; done
fi
img=\$1; shift
set -- --network none --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \\
  --security-opt no-new-privileges:true -e VYRE_HOME=/home/vyre/.vyre -e VYRE_SUPERVISOR=docker \\
  -e VYRE_CLAUDE_BIN=/opt/rc/fake-claude -e VYRE_NO_DIALOGS=1 -v "$V":/home/vyre -v "$H":/opt/rc:ro \\
  --label run.vyre.rc-smoke=$ID \$extra "\$img" "\$@"
if [ \$once = 1 ]; then exec "$RC_DOCKER" run --rm -i "\$@"; fi
exec "$RC_DOCKER" run -d --name "$C" "\$@"
EOF
chmod 755 "$W/run"

echo "rc-smoke: $TGZ (throwaway $ID)"

# ---- 1 install -----------------------------------------------------------------------------------
# As install-box.sh lays a box out: the package unpacked into DIR/src, the box files beside it,
# and .env building the image from src (VYRE_BUILD=tgz).
S=$W/srv
mkdir -p "$S/src" "$W/bin"
if tar -xzf "$TGZ" -C "$S/src" --strip-components=1 && [ -f "$S/src/box/Dockerfile" ]; then
  cp "$REPO/.dockerignore" "$S/src/.dockerignore"
  for f in compose.yml compose.build.yml vyre.env.example; do cp "$S/src/box/$f" "$S/$f"; done
  cp "$S/src/box/vyre" "$W/bin/vyre"; chmod 755 "$W/bin/vyre"
  printf 'COMPOSE_PROJECT_NAME=%s\nCOMPOSE_FILE=compose.yml:compose.build.yml\nVYRE_SOURCE=%s/src\n' "$ID" "$S" >"$S/.env"
  CUR=$(node -e 'console.log(require(process.argv[1]).version)' "$S/src/package.json")
  pass "1 install: the package unpacks (vyre $CUR, box/Dockerfile present)"
else
  fail "1 install: $TGZ does not unpack to a package with box/Dockerfile"; exit 1
fi
if [ -f "$S/src/scripts/install-box.sh" ]; then
  out=$(VYRE_DIR="$W/dry" VYRE_WRAPPER="$W/dry/vyre" sh "$S/src/scripts/install-box.sh" --dry-run --yes --from "$S/src" 2>&1)
  if [ $? -eq 0 ]; then pass "1 install: install-box.sh --dry-run runs"; else fail "1 install: install-box.sh --dry-run: $(echo "$out" | tail -3 | short)"; fi
else
  fail "1 install: the package has no scripts/install-box.sh"
fi
if out=$(nice -n 15 "$RC_DOCKER" build -q -t "$ID:local" -f "$S/src/box/Dockerfile" "$S/src" 2>&1); then
  pass "1 install: the box image builds from the package"
else
  fail "1 install: the image does not build: $(echo "$out" | tail -5 | short)"; exit 1
fi

# ---- 2 vyred up ------------------------------------------------------------------------------------
# The volume gets the synthetic world before vyred first starts: its transcripts where a box's
# Claude Code keeps them, and the made-up person as `me`.
NODE_NO_WARNINGS=1 node "$H/world.mjs" "$W/world" >"$W/world.json" || { fail "2 vyred up: the synthetic world could not be written"; exit 1; }
node -e 'const w=require(process.argv[1]); require("fs").writeFileSync(process.argv[2], JSON.stringify({ me: w.me }))' "$W/world.json" "$W/world/config.json"
"$RC_DOCKER" volume create --label "run.vyre.rc-smoke=$ID" "$V" >/dev/null
tar -C "$W/world" -cf - projects config.json | "$RC_DOCKER" run --rm -i --user 0:0 -v "$V":/home/vyre --entrypoint sh "$ID:local" -c \
  'mkdir -p /home/vyre/.claude /home/vyre/.vyre && tar -xf - -C /tmp && mv /tmp/projects /home/vyre/.claude/projects && mv /tmp/config.json /home/vyre/.vyre/config.json && chown -R 1000:1000 /home/vyre/.claude /home/vyre/.vyre' \
  || { fail "2 vyred up: could not seed the box's home"; exit 1; }
"$W/run" "$ID:local" >/dev/null || { fail "2 vyred up: the container did not start"; exit 1; }
if ready 90; then pass "2 vyred up: vyred answers (vyre status: running)"
else fail "2 vyred up: vyred did not come up in 90 s: $("$RC_DOCKER" logs "$C" 2>&1 | tail -5 | short)"; exit 1; fi
v=$("$RC_DOCKER" exec "$C" vyre version 2>/dev/null | tr -d ' \r\n')
[ "$v" = "$CUR" ] && pass "2 vyred up: vyre version is $CUR" || fail "2 vyred up: vyre version says '$v', the package is $CUR"

# ---- 3 vault: the Claude sign-in ---------------------------------------------------------------------
TOKEN="sk-ant-oat01-$(printf 'Rc5m%.0s' 1 2 3 4 5 6 7 8 9 10 11 12)"
r=$(vc onboard.claude '{"mode":"setup-token"}')
if [ "$(echo "$r" | j 'd.needsCode === true && /\/oauth\/authorize/.test(d.url || "")')" = true ]; then
  pass "3 vault: onboard.claude starts the sign-in and shows its link"
  vc onboard.claude '{"mode":"setup-token","code":"bad-code#rc1"}' | grep -q 'did not accept' \
    && pass "3 vault: a wrong code is refused at once" || fail "3 vault: a wrong code was not refused"
  vc onboard.claude '{"mode":"setup-token"}' >/dev/null
  r=$(vc onboard.claude '{"mode":"setup-token","code":"good-code#rc1"}')
  if [ "$(echo "$r" | j 'd.signedIn === true && d.via === "setup-token"')" = true ]; then pass "3 vault: the code signs in (via setup-token)"
  else fail "3 vault: the right code did not sign in: $(echo "$r" | short)"; fi
  case "$r" in *"$TOKEN"*) fail "3 vault: the token came back in the answer" ;; *) pass "3 vault: the token never comes back" ;; esac
else
  fail "3 vault: onboard.claude did not start a sign-in: $(echo "$r" | short)"
fi
if [ "$(vc vault.list '{}' | j '(d.items || []).some(i => i.name === "claude-setup-token")')" = true ]; then
  pass "3 vault: vault.list has claude-setup-token (names only)"
else fail "3 vault: claude-setup-token is not in the vault"; fi
if "$RC_DOCKER" exec -u vyre "$C" sh -c "grep -rqsF '$TOKEN' /home/vyre/.vyre/logs /home/vyre/.vyre/*.jsonl 2>/dev/null"; then
  fail "3 vault: the token is written in vyred's logs"
else pass "3 vault: the token is in no log"; fi

# ---- 4 phone -----------------------------------------------------------------------------------------
r=$(get /app/)
if [ "$(echo "$r" | head -1)" = 200 ] && echo "$r" | grep -q '<title>Vyre</title>'; then pass "4 phone: /app/ loads (200, the Vyre app shell)"
else fail "4 phone: /app/ answered $(echo "$r" | head -1): $(echo "$r" | tail -n +2 | short)"; fi
r=$(get /app/sw.js)
[ "$(echo "$r" | head -1)" = 200 ] && echo "$r" | grep -q 'const BUILD =' && pass "4 phone: /app/sw.js is served with its build stamp" \
  || fail "4 phone: /app/sw.js answered $(echo "$r" | head -1)"
skip "4 phone: enrolling a phone's passkey needs the box's tailnet address; the headscale gate pairs one"

# ---- 5 memory ------------------------------------------------------------------------------------------
Q=$(j 'd.known.q' <"$W/world.json"); EXPECT=$(j 'd.known.expect[0]' <"$W/world.json"); NONE=$(j 'd.none.q' <"$W/world.json")
vc recall.index '{}' >/dev/null
ask() { # ask QUESTION: the answer as JSON {answer, sources, abstained}
  qj=$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$1")
  if has iq.ask; then vc iq.ask "{\"q\":$qj,\"question\":$qj}" | j '({ answer: d.answer ?? null, sources: (d.sources || []).length, abstained: d.abstained === true || d.answer == null })'
  else vc memory.answer "{\"q\":$qj,\"sources\":true}" | j '({ answer: d.answer ?? null, sources: (d.sources || []).length, abstained: d.answer == null })'
  fi
}
got=""; i=0
while [ $i -lt 40 ]; do
  vc memory.curate '{}' >/dev/null
  got=$(ask "$Q")
  [ "$(echo "$got" | j 'd.answer != null')" = true ] && break
  i=$((i + 1)); sleep 3
done
if [ "$(echo "$got" | E="$EXPECT" j 'new RegExp("\\b" + process.env.E + "\\b", "i").test(String(d.answer)) && d.sources > 0')" = true ]; then
  pass "5 memory: \"$Q\" is answered with its sources ($(echo "$got" | j 'd.sources') of them)"
else fail "5 memory: \"$Q\" wanted $EXPECT with sources, got $(echo "$got" | short)"; fi
none=$(ask "$NONE")
[ "$(echo "$none" | j 'd.abstained')" = true ] && pass "5 memory: \"$NONE\" is not answered (it is not in the world)" \
  || fail "5 memory: \"$NONE\" should not be answered, got $(echo "$none" | short)"

# ---- 6 mail --------------------------------------------------------------------------------------------
if ! has mail.send; then skip "6 mail: mail is not in this build (no mail.send)"
else . "$H/mail.sh"
fi

# ---- 7 theme -------------------------------------------------------------------------------------------
if [ "$(vc settings.schema '{}' | j '(d.keys || []).some(k => k.key === "appearance.tokens")')" != true ]; then
  skip "7 theme: appearance.tokens is not a setting in this build"
else
  before=$(get /theme.css)
  r=$(vc settings.set '{"key":"appearance.tokens","value":{"radius":{"card":16}}}')
  after=$(get /theme.css)
  if echo "$r" | grep -q '"error"\|denied\|confirm_required\|bad_input'; then fail "7 theme: settings.set appearance.tokens: $(echo "$r" | short)"
  elif [ "$(echo "$after" | head -1)" = 200 ] && echo "$after" | grep -q -- '--radius-card: 16px' && [ "$before" != "$after" ]; then
    pass "7 theme: settings.set appearance.tokens changes /theme.css (--radius-card: 16px)"
  else fail "7 theme: /theme.css did not change: $(echo "$after" | head -3 | short)"; fi
fi

# ---- 8 update and back -------------------------------------------------------------------------------
NEXT=$(node -e 'const [a,b,c]=process.argv[1].split(/[.+-]/).map(Number); console.log(`${a}.${b}.${c + 1}`)' "$CUR")
node "$H/site.mjs" make "$S/src" "$W/site" "$NEXT" "$CUR" "$REPO/.dockerignore" || fail "8 update: the fake release $NEXT could not be made"
node "$H/site.mjs" serve "$W/site" "$W/port" & SITE_PID=$!
i=0; while [ ! -s "$W/port" ] && [ $i -lt 50 ]; do i=$((i + 1)); sleep 0.1; done
PORT=$(cat "$W/port" 2>/dev/null)
mkdir -p "$W/shim"; cp "$H/docker" "$W/shim/docker"; chmod 755 "$W/shim/docker"
wrap() { PATH="$W/shim:$PATH" VYRE_DIR="$S" VYRE_WRAPPER="$W/bin/vyre" VYRE_BOX_URL="http://127.0.0.1:$PORT/" VYRE_RELEASES_API="" \
  VYRE_UPDATE_WAIT=120 nice -n 15 sh "$W/bin/vyre" "$@" </dev/null 2>&1; }
out=$(wrap update)
if [ $? -eq 0 ] && echo "$out" | grep -q "updated to $NEXT"; then pass "8 update: vyre update to the fake release $NEXT"
else fail "8 update: vyre update: $(echo "$out" | tail -6 | short)"; fi
ready 60
v=$("$RC_DOCKER" exec "$C" vyre version 2>/dev/null | tr -d ' \r\n')
[ "$v" = "$NEXT" ] && pass "8 update: the box runs $NEXT" || fail "8 update: the box runs '$v', not $NEXT"
[ "$(vc vault.list '{}' | j '(d.items || []).some(i => i.name === "claude-setup-token")')" = true ] \
  && pass "8 update: the vault item survived the update" || fail "8 update: the vault item is gone after the update"
out=$(wrap update --rollback)
if [ $? -eq 0 ] && echo "$out" | grep -q "rolled back"; then pass "8 update: vyre update --rollback"
else fail "8 update: vyre update --rollback: $(echo "$out" | tail -6 | short)"; fi
ready 60
v=$("$RC_DOCKER" exec "$C" vyre version 2>/dev/null | tr -d ' \r\n')
[ "$v" = "$CUR" ] && pass "8 update: the box is back on $CUR" || fail "8 update: after the rollback the box runs '$v', not $CUR"
[ "$(vc vault.list '{}' | j '(d.items || []).some(i => i.name === "claude-setup-token")')" = true ] \
  && pass "8 update: the vault item survived the rollback" || fail "8 update: the vault item is gone after the rollback"
if grep -qv '^docker \(image\|compose\) ' "$W/docker.log" 2>/dev/null; then
  fail "8 update: the wrapper asked docker for something the shim does not map: $(grep -v '^docker \(image\|compose\) ' "$W/docker.log" | head -3 | short)"
fi

echo "rc-smoke: $PASS pass, $FAILS fail, $SKIPS skip"
[ "$FAILS" = 0 ]
