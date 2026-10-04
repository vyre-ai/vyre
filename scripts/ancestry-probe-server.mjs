// Real-box ancestry probe: node scripts/ancestry-probe-server.mjs <repo> <socket> <out>, then run scripts/ancestry-probe-client.mjs <socket> <label> from an ssh login (with and without a pty), a tmux, setsid, and under a process named claude. One JSON line per call.
import net from "node:net"; import fs from "node:fs";
const base = process.argv[2];
const { above, isLoginServer, surfaceAncestry } = await import(base + "/core/daemon/index.js");
const registry = { call: async () => ({ data: { pids: [], pgids: [], sids: [] } }), deps: {} };
const sock = process.argv[3]; try { fs.unlinkSync(sock); } catch {}
const out = process.argv[4];
net.createServer(async c => {
  let label = "";
  c.on("data", async d => {
    label = String(d).trim();
    let r; try { r = await above(c, registry, undefined); } catch (e) { r = { error: String(e) }; }
    const outside = surfaceAncestry({ model: Boolean(r.inside), server: r.server }, true);
    const line = JSON.stringify({ label, inside: r.inside, unknown: r.unknown, nopid: r.nopid, server: r.server && { exe: r.server.exe, uid: r.server.uid, comm: r.server.comm, cmd: (r.server.cmd || "").slice(0, 40) }, isLoginServer: r.server ? isLoginServer(r.server) : null, standInOutside: outside.outside, noStandInOutside: surfaceAncestry({ model: Boolean(r.inside), server: r.server }, false).outside });
    fs.appendFileSync(out, line + "\n"); c.end("ok");
  });
}).listen(sock, () => console.log("listening"));
