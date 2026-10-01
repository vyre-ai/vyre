#!/bin/bash
# J10: threads on a real box, with a stand-in `claude` (the stream-json fake the switchboard tests use).
#   bash scripts/matrix/j10-threads.sh <box-dir> <out-dir>
# As the person at the command line: start, send, stop and delete a thread. Then a thread whose agent
# calls tools the way the MCP server does (as an agent caller), so the reach rules (asked or anyone) are
# seen on a real install, not only in unit tests. Calls an agent makes whose answer the rules leave to the
# team are recorded as "observed" with the answer, for the owner to judge. CI runners only.
set -u
[ -n "${CI:-}" ] || { echo "j10-threads.sh: runs on a CI runner only (CI is unset)" >&2; exit 2; }
BOX=$(cd "$1" && pwd); mkdir -p "$2"; OUT=$(cd "$2" && pwd); DIR=/srv/vyre; FAILED=0
rec() { ok=$2; case "$ok" in ok) ok=true;; observed) ok='"observed"';; *) ok=false; FAILED=$((FAILED + 1));; esac
  printf '{"journey":"J10","device":"linux","step":"%s","ok":%s,"why":"%s"}\n' "$1" "$ok" "$(printf %s "${3:-}" | tr -d '"\\' | tr '\n' ' ' | cut -c1-400)" >>"$OUT/results.jsonl"
  echo "$1 $2 ${3:-}"; }
T=$RUNNER_TEMP/j10; mkdir -p "$T"
cp scripts/../core/switchboard/testing/fake-claude.js "$T/fake-claude.cjs.js" 2>/dev/null || cp core/switchboard/testing/fake-claude.js "$T/fake-claude.js"
mv "$T/fake-claude.cjs.js" "$T/fake-claude.js" 2>/dev/null
printf '#!/bin/sh\nFAKE_CLAUDE_LOG=/tmp/fake-claude.log exec node /opt/vyre/core/switchboard/testing/fake-claude.js "$@"\n' >"$T/claude"; cp "$T/fake-claude.js" "$T/fake-claude.mjs"; chmod 755 "$T/claude" "$T/fake-claude.mjs"
sudo mkdir -p $DIR && sudo chown "$(id -u):$(id -g)" $DIR
cat >$DIR/compose.e2e.yml <<YML
services:
  vyre:
    environment:
      - VYRE_CLAUDE_BIN=/usr/local/bin/claude
    volumes:
      - $T/claude:/usr/local/bin/claude:ro
      - $T/fake-claude.js:/opt/vyre/core/switchboard/testing/fake-claude.js:ro
YML
python3 -m http.server 18080 --bind 127.0.0.1 --directory "$BOX" >/dev/null 2>&1 & SRV=$!
for i in $(seq 1 50); do curl -fs http://127.0.0.1:18080/SHA256SUMS >/dev/null && break; sleep 0.2; done
VYRE_BOX_URL=http://127.0.0.1:18080/ VYRE_BUILD=tgz COMPOSE_FILE=$DIR/compose.yml:$DIR/compose.build.yml:$DIR/compose.e2e.yml sh "$BOX/install-box.sh" --yes --print-link </dev/null >"$OUT/install.log" 2>&1
i=0; until vyre status 2>/dev/null | grep -q 'vyred running'; do i=$((i + 1)); [ $i -ge 120 ] && break; sleep 1; done
vyre status 2>&1 | grep -q 'vyred running' && rec 10.0-install ok || { rec 10.0-install false "$(tail -4 "$OUT/install.log")"; exit 1; }
vyre call threads.list '{}' >/dev/null 2>&1; rec 10.0b-fake-claude-in-box ok "$(docker compose -f $DIR/compose.yml exec -T vyre claude --version 2>&1 | head -1)"
call() { vyre call "$@" 2>&1; }
send_json() { node -e 'console.log(JSON.stringify({ thread: process.argv[1], text: process.argv[2], surface: "deck" }))' "$1" "$2"; }
# 10.1 the person starts a thread
S=$(call threads.start '{"agent":"worker-a","cwd":"/work","prompt":"hello from the matrix","surface":"deck"}'); echo "$S" >"$OUT/start.json"
ID=$(printf '%s' "$S" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.data||j).id||(j.data||j).thread||"")}catch{console.log("")}})')
[ -n "$ID" ] && rec 10.1-person-starts-thread ok "$ID" || { rec 10.1-person-starts-thread false "$(printf %s "$S" | head -c 300)"; ID=""; }
wait_reply() { # wait until the thread's text contains $2, up to 60 s
  for i in $(seq 1 30); do call threads.get "{\"thread\":\"$1\"}" >"$OUT/get-$3.json"; grep -q "$2" "$OUT/get-$3.json" && return 0; sleep 2; done; return 1; }
if [ -n "$ID" ]; then
  wait_reply "$ID" "hello from the matrix" first && [ "$(grep -c "hello from the matrix" "$OUT/get-first.json")" -ge 2 ] && ! grep -q "Not logged in" "$OUT/get-first.json" && rec 10.2-agent-answers ok || rec 10.2-agent-answers false "no reply: $(head -c 300 "$OUT/get-first.json")"
  # a second thread the person starts, so "another agent's thread" exists
  S2=$(call threads.start '{"agent":"worker-b","cwd":"/work","prompt":"second thread","surface":"deck"}')
  ID2=$(printf '%s' "$S2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.data||j).id||(j.data||j).thread||"")}catch{console.log("")}})')
  [ -n "$ID2" ] && rec 10.2b-person-starts-second-thread ok "$ID2" || rec 10.2b-person-starts-second-thread false "$(printf %s "$S2" | head -c 200)"
  # 10.3 an agent inside the thread calls tools as a plain agent caller (what the MCP server does). Reach is
  # "anyone" and the in-code guard decides: a plain agent is refused each of these with these words (sessions, 1 Oct).
  agent_call() { # agent_call STEP "tool json" "message fragment"
    n=$(printf '%s' "$1" | tr . -)
    call threads.send "$(send_json "$ID" "vyre $2")" >"$OUT/send-$n.json"
    for i in $(seq 1 10); do sleep 3; call threads.get "{\"thread\":\"$ID\"}" >"$OUT/get-$n.json"; grep -q "$3" "$OUT/get-$n.json" && break; done
    grep -q "$3" "$OUT/get-$n.json" && rec "$1" ok "refused: $3" || rec "$1" false "expected a refusal saying '$3'; send said: $(head -c 200 "$OUT/send-$n.json" | tr '\n' ' ')"; }
  agent_call 10.3a-agent-start-refused "threads.start {\"cwd\":\"/work\",\"prompt\":\"child\"}" "only the assistant can start sessions"
  agent_call 10.3b-agent-delete-other-refused "threads.delete {\"thread\":\"$ID2\"}" "only the assistant can delete sessions"
  agent_call 10.3c-agent-stop-own-refused "threads.stop {\"thread\":\"$ID\"}" "only the assistant can stop sessions"
  agent_call 10.3d-agent-stop-other-refused "threads.stop {\"thread\":\"$ID2\"}" "only the assistant can stop sessions"
  agent_call 10.3e-agent-list-refused "threads.list {}" "only the assistant can list sessions"
  agent_call 10.3f-agent-ask-refused "agents.ask {\"agent\":\"nobody\",\"prompt\":\"hi\"}" "only the assistant can talk to other agents"
  # the person still can (same tools, as the person at the command line)
  call threads.list '{}' | grep -q "$ID2" && rec 10.3g-person-lists-threads ok || rec 10.3g-person-lists-threads false "the person's list lacks the second thread"
  # the thread survived every refused call
  call threads.list '{}' | grep -q "$ID" && rec 10.3h-refusals-changed-nothing ok || rec 10.3h-refusals-changed-nothing false "the first thread vanished"
  # 10.7 the assistant can do what a plain agent cannot: start, list, stop and delete
  SA=$(call threads.start '{"agent":"asst","agent_kind":"assistant","cwd":"/work","prompt":"hi from the assistant","surface":"deck"}')
  IDA=$(printf '%s' "$SA" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.data||j).id||(j.data||j).thread||"")}catch{console.log("")}})')
  if [ -z "$IDA" ]; then rec 10.7-assistant-thread-starts false "$(printf %s "$SA" | head -c 300)"; else
    rec 10.7-assistant-thread-starts ok "$IDA"
    count() { call threads.list '{}' | grep -o '"id": *"[0-9a-f-]\{36\}"' | sort -u | wc -l | tr -d ' '; }
    asst_call() { n=$(printf '%s' "$1" | tr . -); call threads.send "$(send_json "$IDA" "vyre $2")" >"$OUT/send-$n.json"; sleep 12; call threads.get "{\"thread\":\"$IDA\"}" >"$OUT/get-$n.json"; }
    before=$(count)
    asst_call 10.7a "threads.start {\"cwd\":\"/work\",\"prompt\":\"child by the assistant\"}"
    after=$(count)
    [ "$after" -gt "$before" ] && ! grep -q "only the assistant can" "$OUT/get-10-7a.json" && rec 10.7a-assistant-starts-thread ok "$before to $after threads" || rec 10.7a-assistant-starts-thread false "threads $before to $after; $(grep -o 'only the assistant[^"]*' "$OUT/get-10-7a.json" | head -1)"
    asst_call 10.7b "threads.list {}"
    grep -q "$ID2" "$OUT/get-10-7b.json" && ! grep -q "only the assistant can" "$OUT/get-10-7b.json" && rec 10.7b-assistant-lists-threads ok || rec 10.7b-assistant-lists-threads false "the assistant's list does not show the other thread, or it was refused"
    asst_call 10.7c "threads.stop {\"thread\":\"$ID2\"}"
    ! grep -q "only the assistant can" "$OUT/get-10-7c.json" && grep -q "stop" "$OUT/get-10-7c.json" && rec 10.7c-assistant-stops-thread ok || rec 10.7c-assistant-stops-thread false "refused or no answer: $(grep -o 'only the assistant[^"]*\|Not logged in[^"]*' "$OUT/get-10-7c.json" | head -1)"
    asst_call 10.7d "threads.delete {\"thread\":\"$ID2\"}"
    call threads.list '{}' | grep -q "$ID2" && rec 10.7d-assistant-deletes-thread false "the other thread is still listed" || rec 10.7d-assistant-deletes-thread ok
  fi
  call threads.stop "{\"thread\":\"$ID\"}" >"$OUT/stop.json"; grep -qi '"error"' "$OUT/stop.json" && rec 10.4-person-stops-thread false "$(head -c 200 "$OUT/stop.json")" || rec 10.4-person-stops-thread ok
  call threads.delete "{\"thread\":\"$ID\"}" >"$OUT/delete.json"; grep -qi '"error"' "$OUT/delete.json" && rec 10.5-person-deletes-thread false "$(head -c 200 "$OUT/delete.json")" || rec 10.5-person-deletes-thread ok
  call threads.list '{}' | grep -q "$ID" && rec 10.6-deleted-thread-gone false "still listed" || rec 10.6-deleted-thread-gone ok
fi
kill $SRV 2>/dev/null
exit $([ $FAILED -eq 0 ] && echo 0 || echo 1)
