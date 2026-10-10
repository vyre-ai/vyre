// @ts-check
// The relay's public front alone in its own process, for test/relay-never-reads.test.js (FOUNDATION S8): the directory knows one name, the box is a TCP address given by BOX_PORT, every log call is a line on stdout.
// LEAK=1 makes a deliberately wrong relay (it keeps the first flight it reads) so the memory scan has a case that must fail.
import net from "node:net";
import { createTunnelFront } from "../relay/node/tunnel.js";

const boxPort = Number(process.env.BOX_PORT);
const keep = /** @type {Buffer[]} */ ([]);
const front = createTunnelFront({
  resolve: async host => (host === "harlow.vyre.run" ? { route: "route-harlow" } : null),
  open: (_route, _visitor, sink) => new Promise(resolve => {
    const c = net.connect(boxPort, "127.0.0.1", () => resolve({ write: b => { if (process.env.LEAK === "1") keep.push(Buffer.from(b)); return c.write(b); }, close: () => c.destroy() }));
    c.on("data", b => { sink.data(b); });
    c.on("close", () => sink.end());
    c.on("error", () => resolve(null));
  }),
  log: (what, x) => { console.log(`LOG ${JSON.stringify([what, x])}`); },
});
const server = net.createServer(s => front.tls(s));
server.listen(0, "127.0.0.1", () => { console.log(`LISTEN ${/** @type {any} */ (server.address()).port}`); });
process.stdin.on("data", d => { if (String(d).includes("stats")) console.log(`STATS ${JSON.stringify(front.stats)}`); });
