// @ts-check
// preview-forward: runs INSIDE a preview's network-less sandbox (lib/sandbox/preview-wall.js, Linux). The dev server listens on its own loopback port in the sandbox's private network; this waits until that
// port answers, then offers it on a unix socket in a folder the sandbox shares with Vyre, which relays the leased port on the host to it. It connects to nothing but that one loopback port.
//   node preview-forward.js <socket path> <port>
import fs from "node:fs";
import net from "node:net";

const [sock, portText] = process.argv.slice(2), port = Number(portText);
if (!sock || !Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);

const answers = () => new Promise(resolve => {
  const s = net.connect({ host: "127.0.0.1", port });
  const done = (/** @type {boolean} */ v) => { s.destroy(); resolve(v); };
  s.setTimeout(400, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});

for (;;) { if (await answers()) break; await new Promise(r => setTimeout(r, 200)); }
try { fs.rmSync(sock, { force: true }); } catch { /* none */ }
const server = net.createServer(c => {
  const u = net.connect({ host: "127.0.0.1", port });
  c.pipe(u); u.pipe(c);
  const end = () => { c.destroy(); u.destroy(); };
  c.on("error", end); u.on("error", end); c.on("close", end); u.on("close", end);
});
server.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch { /* the folder is private */ } });
