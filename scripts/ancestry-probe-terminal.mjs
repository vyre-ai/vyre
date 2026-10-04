// Real-box probe of the terminal check `vyre signin` uses: node scripts/ancestry-probe-terminal.mjs <repo> <socket> <out>; then run scripts/ancestry-probe-client.mjs <socket> <label> from a real ssh login with a pty.
import net from "node:net"; import fs from "node:fs"; import { execFile } from "node:child_process";
const base = process.argv[2];
const { atTerminal, above } = await import(base + "/core/daemon/index.js");
const { peerPid, loginOf, controllingTty } = await import(base + "/core/daemon/peer.js");
const who = () => new Promise(r => execFile("/usr/bin/who", [], (e, o) => r(e ? [] : String(o).split("\n").map(l => l.trim().split(/\s+/)[1]).filter(Boolean))));
const registry = { call: async () => ({ data: { pids: [], pgids: [], sids: [] } }), deps: {} };
const sock = process.argv[3]; try { fs.unlinkSync(sock); } catch {}
net.createServer(c => c.on("data", async d => {
  const label = String(d).trim();
  const pid = await peerPid(c);
  const a = await above(c, registry).catch(e => ({ error: String(e) }));
  const t = await atTerminal(c, registry, { who }, false).catch(e => ({ error: String(e) }));
  fs.appendFileSync(process.argv[4], JSON.stringify({ label, pid, tty: pid && controllingTty(pid), login: pid && loginOf(pid), who: await who(), above: { inside: a.inside, unknown: a.unknown, nopid: a.nopid, server: a.server && { exe: a.server.exe, uid: a.server.uid, comm: a.server.comm } }, atTerminal: t }) + "\n"); c.end("ok");
})).listen(sock, () => console.log("listening"));
