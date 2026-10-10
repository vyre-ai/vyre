// @ts-check
// Runs INSIDE the Linux sandbox. Its network namespace has only loopback, so this listens on one loopback port,
// forwards every connection to the runner's egress proxy over the bound unix socket, and then starts the session
// program. Nothing else can leave the sandbox. Usage: shim.js --listen PORT --to /run/egress.sock -- cmd args...

import net from "node:net";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const cut = argv.indexOf("--");
const opt = k => argv[argv.indexOf(k) + 1];
const port = Number(opt("--listen")), sock = opt("--to");
const [cmd, ...args] = argv.slice(cut + 1);
if (!port || !sock || cut < 0 || !cmd) { console.error("usage: shim.js --listen PORT --to SOCK -- cmd args"); process.exit(2); }

// An optional second listener, on a unix socket bound in from the lender's side: the lender's preview of a dev server in here. A connection says which loopback port it wants on its first line (`PORT <n>`),
// and everything after that line goes to that port, both ways. Only an ordinary port that is not this shim's own egress port.
const pv = argv.indexOf("--preview") >= 0 ? opt("--preview") : null;
if (pv) {
  net.createServer(c => {
    let head = Buffer.alloc(0);
    const onData = d => {
      head = Buffer.concat([head, d]);
      const nl = head.indexOf(10);
      if (nl < 0) { if (head.length > 32) c.destroy(); return; }
      c.off("data", onData); c.pause();
      const m = /^PORT (\d{4,5})$/.exec(head.subarray(0, nl).toString());
      const n = m ? Number(m[1]) : 0;
      if (!n || n < 1024 || n > 65535 || n === port) { c.destroy(); return; }
      const up = net.connect(n, "127.0.0.1", () => { const rest = head.subarray(nl + 1); if (rest.length) up.write(rest); c.pipe(up).pipe(c); c.resume(); });
      const end = () => { c.destroy(); up.destroy(); };
      c.on("error", end); up.on("error", end); c.on("close", end);
    };
    c.on("data", onData); c.on("error", () => c.destroy());
  }).listen(pv);
}

const server = net.createServer(c => {
  const up = net.connect(sock);
  c.pipe(up).pipe(c);
  const end = () => { c.destroy(); up.destroy(); };
  c.on("error", end); up.on("error", end);
});
server.listen(port, "127.0.0.1", () => {
  const child = spawn(cmd, args, { stdio: "inherit" });
  child.on("exit", (code, sig) => { server.close(); process.exit(code ?? (sig ? 128 : 0)); });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
});
