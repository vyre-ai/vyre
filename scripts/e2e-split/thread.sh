#!/bin/sh
# A Vyre-owned session through the spawner, started by vyred itself (threads.start), with a
# stand-in claude that reports what it can reach. Usage: split-thread.sh <image>
set -u
IMG=${1:-vyre-e2e-split:local}
C=vyre-e2e-thread-$$
V=vyre-e2e-thread-work-$$
fail=0
ok() { echo "ok   $1"; }
no() { echo "FAIL $1"; fail=1; }
docker volume create "$V" >/dev/null
# The stand-in claude, in /work (the agent can run it; the spawner is told to allow it).
docker run --rm --user 0:0 -v "$V":/work --entrypoint sh "$IMG" -c 'cat > /work/fake-claude <<"F"
#!/bin/sh
O=/work/out-$$.txt
{
echo "UID $(id -u)"
echo "SOCK ${VYRE_SOCKET:-none}"
echo "CALL $(vyre call system.echo "{\"text\":\"hi\"}" 2>&1 | tr -d "\n" | cut -c1-160)"
echo "CLIENT $(node --input-type=module -e "import(\"/opt/vyre/core/daemon/client.js\").then(async m => { const r = await m.call(\"system.echo\", { text: \"hi\" }); console.log(JSON.stringify(r)); })" 2>&1 | cut -c1-160)"
echo "CLAIM $(node --input-type=module -e "import(\"/opt/vyre/core/daemon/client.js\").then(async m => { const r = await m.call(\"agents.create\", { name: \"rogue\" }, { caller: \"deck\" }); console.log(JSON.stringify(r)); })" 2>&1 | cut -c1-200)"
echo "MAIN $(node --input-type=module -e "import(\"/opt/vyre/core/daemon/client.js\").then(async m => { const r = await m.call(\"system.echo\", { text: \"hi\" }, { socket: \"/home/vyre/.vyre/vyred.sock\" }); console.log(JSON.stringify(r)); })" 2>&1 | cut -c1-160)"
echo "MCP $(printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}" "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"system_echo\",\"arguments\":{\"text\":\"via-mcp\"}}}" | (cat; sleep 6) | timeout 12 node /opt/vyre/harness/mcp/server.js 2>&1 | node -e "let b=\"\";process.stdin.on(\"data\",d=>b+=d).on(\"end\",()=>{const l=b.split(\"\\n\").filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);const list=l.find(x=>x.id===2);const call=l.find(x=>x.id===3);console.log(\"tools=\"+(list&&list.result?list.result.tools.length:\"none\")+\" echo=\"+(call?JSON.stringify(call.result||call.error).slice(0,120):\"none\"))})")"
} > "$O" 2>&1
cat >/dev/null
F
chmod 755 /work/fake-claude; mkdir -p /work/kit; chmod 2775 /work /work/kit'
docker run -d --name "$C" --network none --user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges:true -e VYRE_HOME=/home/vyre/.vyre -e VYRE_SUPERVISOR=docker \
  -e VYRE_SPAWNER_ALLOW=/work/fake-claude -e VYRE_CLAUDE_BIN=/work/fake-claude -v "$V":/work "$IMG" >/dev/null
trap 'docker rm -f "$C" >/dev/null 2>&1; docker volume rm "$V" >/dev/null 2>&1' EXIT
i=0; until docker exec "$C" test -S /home/vyre/.vyre/vyred.sock 2>/dev/null || [ $i -ge 60 ]; do i=$((i+1)); sleep 1; done
# The CLI runner on the stand-in claude, with the box's defaults otherwise (spawner on for a box).
docker exec -u vyre "$C" sh -c 'echo "{\"sessions\":{\"driver\":\"cli\"}}" > /home/vyre/.vyre/config.json'
# The loop brings vyred back with the new config.
docker exec "$C" pkill -TERM -f 'node /opt/vyre/core/daemon/main.js' >/dev/null 2>&1; sleep 4
i=0; until docker exec "$C" vyre status 2>/dev/null | grep -qi running || [ $i -ge 60 ]; do i=$((i+1)); sleep 1; done
sleep 3
ST=$(docker exec -u vyre "$C" vyre call threads.start '{"cwd":"/work/kit","prompt":"hello","surface":"deck"}' 2>&1)
echo "$ST" | grep -q '"id"' && ok "vyred starts a session (threads.start)" || no "threads.start: $(echo "$ST" | head -3)"
i=0; until docker exec "$C" sh -c 'ls /work/out-*.txt >/dev/null 2>&1 && grep -q "^MCP" /work/out-*.txt' || [ $i -ge 40 ]; do i=$((i+1)); sleep 1; done
R=$(docker exec "$C" sh -c 'cat /work/out-*.txt' 2>&1)
echo "$R" | sed 's/^/     /'
echo "$R" | grep -q '^UID 1001$' && ok "the session runs as vyre-agent" || no "session uid: $(echo "$R" | grep UID)"
echo "$R" | grep -q '^SOCK /run/vyre-threads/' && ok "VYRE_SOCKET is the thread's own socket" || no "socket: $(echo "$R" | grep SOCK)"
echo "$R" | grep -q '^CLIENT .*"text":"hi"' && ok "the client reaches vyred on the thread socket" || no "client: $(echo "$R" | grep CLIENT)"
echo "$R" | grep -q '^CALL .*"text": *"hi"' && ok "vyre call from the session works" || no "vyre call: $(echo "$R" | grep '^CALL')"
echo "$R" | grep -q '^CLAIM .*"error"' && ! echo "$R" | grep -q '^CLAIM .*"data"' && ok "claiming the Deck on the thread socket is refused" || no "claim: $(echo "$R" | grep CLAIM)"
echo "$R" | grep -q '^MAIN .*unreachable\|^MAIN .*EACCES' && ok "no path to vyred's main socket" || no "main: $(echo "$R" | grep MAIN)"
echo "$R" | grep -qE '^MCP tools=[1-9][0-9]* echo=\{"content"' && ok "the Vyre MCP tools work through the thread socket" || no "mcp: $(echo "$R" | grep MCP)"
exit $fail
