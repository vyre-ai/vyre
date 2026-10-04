// reviewer-2 SG probe: replicate atTerminal's new guard on a real box. node rv2-sg.mjs <repo> <sock> <out>
import net from "node:net"; import fs from "node:fs"; import { execFileSync } from "node:child_process";
const base = process.argv[2];
const { above, isLoginServer } = await import(base + "/core/daemon/index.js");
const { peerPid, loginOf } = await import(base + "/core/daemon/peer.js");
const registry = { call: async () => ({ data: { pids: [], pgids: [], sids: [] } }), deps: {} };
const sock = process.argv[3], out = process.argv[4]; try { fs.unlinkSync(sock); } catch {}
net.createServer(c => { c.on("data", async d => {
  const label = String(d).trim(); let w; try { w = await above(c, registry, undefined); } catch (e) { w = { error: String(e) }; }
  const pid = await peerPid(c); const login = pid ? loginOf(pid) : null;
  const who = execFileSync("/usr/bin/who", { encoding: "utf8" }).split("\n").map(l => l.trim().split(/\s+/)[1]).filter(Boolean);
  const refused = w.nopid || w.inside || (w.unknown && !w.server);
  fs.appendFileSync(out, JSON.stringify({ label, inside: w.inside, unknown: w.unknown, nopid: w.nopid, server: w.server && { exe: w.server.exe, uid: w.server.uid, comm: w.server.comm, cmd: String(w.server.cmd || "").slice(0, 30) }, isLoginServer: w.server ? isLoginServer(w.server) : null, guardRefuses: Boolean(refused), login: login && login.key, ttyInWho: login ? who.includes(login.tty) : false, wouldGetKey: !refused && Boolean(login) && who.includes(login.tty) }) + "\n");
  c.end("ok"); }); }).listen(sock, () => console.log("listening"));
