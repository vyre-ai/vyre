#!/usr/bin/env bash
# Same-uid bypasses (reviewer-2, reviews/platform.md): can an agent at the person's uid make a call arrive as the person?
# A real vyred in a temp home; an agent process whose name is `claude` (a copy of node), which tries each way it knows, and
# each way prints one line: CASE <id> works|blocked|prompts|skip|error. Runs on a CI runner only, never on a person's Mac.
set -u
[ -n "${CI:-}" ] || { echo "run.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
OUT=${1:-results}; mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
TMP=$(mktemp -d); export PROBE_TMP=$TMP PROBE_NODE=$TMP/bin/claude
mkdir -p "$TMP/bin"; cp "$(command -v node)" "$PROBE_NODE"
export VYRE_HOME=$TMP/home; mkdir -p "$VYRE_HOME"
echo '{"role":"box","transcripts":[],"modules":{"disable":["names","onboard","relay","recall","memory","learn"]}}' >"$VYRE_HOME/config.json"
# ssh to this same account, with a key the agent makes and authorizes for itself (that is the bypass under test)
if [ "$(uname)" = Linux ]; then sudo apt-get install -y -qq openssh-server >/dev/null 2>&1; sudo service ssh start >/dev/null 2>&1 || sudo systemctl start ssh >/dev/null 2>&1
else sudo systemsetup -setremotelogin on >/dev/null 2>&1; fi
mkdir -p ~/.ssh; chmod 700 ~/.ssh
ssh-keygen -q -t ed25519 -N "" -f "$TMP/key" && cat "$TMP/key.pub" >>~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && export PROBE_KEY=$TMP/key
ssh -o StrictHostKeyChecking=no -o BatchMode=yes -i "$PROBE_KEY" localhost true 2>/dev/null || { echo "ssh to this account does not work here: the ssh cases are skipped" >&2; unset PROBE_KEY; }
( cd "$REPO" && node core/daemon/main.js >"$TMP/vyred.log" 2>&1 ) &
VP=$!
for i in $(seq 1 60); do [ -S "$VYRE_HOME/vyre.sock" ] || ls "$VYRE_HOME"/*.sock >/dev/null 2>&1 && break; sleep 0.5; done
sleep 2
echo "who, before: $(who | tr '\n' ';')" | tee "$OUT/context.txt"
cd "$REPO" && "$PROBE_NODE" "$HERE/agent.mjs" 2>&1 | tee "$OUT/cases.txt"
{ echo "who, after: $(who | tr '\n' ';')"; echo "$(uname -sr) / node $(node -v)"; [ "$(uname)" = Linux ] && echo "legacy_tiocsti=$(sysctl -n dev.tty.legacy_tiocsti 2>/dev/null || echo n/a)"; } | tee -a "$OUT/context.txt"
tail -5 "$TMP/vyred.log" >"$OUT/vyred-tail.txt"
kill $VP 2>/dev/null
[ -n "${PROBE_KEY:-}" ] && sed -i.bak "\#$(cut -d' ' -f2 "$TMP/key.pub")#d" ~/.ssh/authorized_keys 2>/dev/null
exit 0
