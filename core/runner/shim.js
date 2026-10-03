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
